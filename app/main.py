"""LCARS Claude: a web front end for the terminals herdr-core runs.

The browser never talks to Claude directly. It attaches to real `claude`
terminals that live in herdr-core on this machine, so MCP tools load once and
every session stays alive when the page is closed.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .core_client import CLOSE, DATA, FOCUS, RESIZE, Core, CoreClosed, CoreError

log = logging.getLogger("lcars")

STATIC = Path(__file__).parent / "static"
TOKEN = os.environ.get("LCARS_TOKEN", "")
# Proxies (e.g. Nginx Proxy Manager behind Authelia) whose `Remote-User` header we accept as a login.
TRUSTED_PROXIES = {p.strip() for p in os.environ.get("LCARS_TRUSTED_PROXIES", "").split(",") if p.strip()}
COOKIE = "lcars_session"
MAX_UPLOAD = 8 * 1024 * 1024  # terminal.put accepts at most 8 MB raw
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,31}$")
XTERM_ENV = {"TERM": "xterm-256color", "COLORTERM": "truecolor"}

app = FastAPI(title="LCARS Claude", docs_url=None, redoc_url=None, openapi_url=None)


# ── auth ────────────────────────────────────────────────────────────────
def _session_value() -> str:
    return hashlib.sha256(("lcars-session:" + TOKEN).encode()).hexdigest()


_failures: dict[str, list[float]] = {}


def _login_blocked(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _failures.get(ip, []) if now - t < 60]
    _failures[ip] = recent
    return len(recent) >= 5


def _authorized(headers, cookies, client_host: str | None) -> bool:
    if not TOKEN:
        return False  # never run open
    if client_host in TRUSTED_PROXIES and headers.get("remote-user"):
        return True
    if hmac.compare_digest(cookies.get(COOKIE, ""), _session_value()):
        return True
    bearer = headers.get("authorization", "")
    return bearer.startswith("Bearer ") and hmac.compare_digest(bearer[7:], TOKEN)


def _same_origin(headers) -> bool:
    """Reject cross-site pages talking to us (this is a shell on the machine)."""
    origin = headers.get("origin")
    if not origin:
        return True  # not a browser page; the token still applies
    host = headers.get("x-forwarded-host") or headers.get("host", "")
    return urlparse(origin).netloc == host


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if path in ("/login", "/api/login"):
        return await call_next(request)
    if not _authorized(request.headers, request.cookies, request.client.host if request.client else None):
        if path.startswith("/api/"):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return HTMLResponse(LOGIN_PAGE, status_code=401)
    if request.method not in ("GET", "HEAD", "OPTIONS") and not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    return await call_next(request)


LOGIN_PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>LCARS Claude</title><style>
body{background:#000;color:#ff9900;font-family:Antonio,Arial,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
form{display:grid;gap:12px;width:min(320px,90vw)}h1{margin:0;letter-spacing:.2em;font-size:20px}
input,button{font:inherit;padding:12px;border:0;border-radius:18px;background:#ff9900;color:#000}
input{background:#1a1224;color:#ffcc99}</style>
<form onsubmit="return go(event)"><h1>LCARS ACCESS</h1>
<input id=t type=password placeholder="Access code" autofocus autocomplete=current-password>
<button>AUTHORIZE</button><div id=m></div></form>
<script>async function go(e){e.preventDefault();const r=await fetch('/api/login',{method:'POST',
headers:{'content-type':'application/json'},body:JSON.stringify({token:t.value})});
if(r.ok)location.href='/';else m.textContent=r.status==429?'Too many attempts':'Access denied';return false}</script>"""


class LoginBody(BaseModel):
    token: str


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return LOGIN_PAGE


@app.post("/api/login")
async def login(body: LoginBody, request: Request):
    ip = request.client.host if request.client else "?"
    if not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    if _login_blocked(ip):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    if not TOKEN or not hmac.compare_digest(body.token, TOKEN):
        _failures.setdefault(ip, []).append(time.time())
        return JSONResponse({"error": "denied"}, status_code=401)
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE, _session_value(), httponly=True, samesite="strict", secure=secure, max_age=30 * 86400)
    return resp


# ── core access ─────────────────────────────────────────────────────────
_core: Core | None = None
_core_lock = asyncio.Lock()


async def rpc(method: str, params: dict | None = None):
    """One shared connection for request/response calls; reconnects if it drops."""
    global _core
    for attempt in (1, 2):
        async with _core_lock:
            if _core is None or _core.closed.is_set():
                _core = await Core().connect()
            core = _core
        try:
            return await core.call(method, params)
        except CoreClosed:
            if attempt == 2:
                raise
        except CoreError as e:
            raise HTTPException(status_code=422 if e.kind else 500, detail=str(e))


@app.exception_handler(ConnectionError)
async def core_down(_request, exc):
    return JSONResponse({"error": f"herdr-core unavailable: {exc}"}, status_code=503)


@app.exception_handler(FileNotFoundError)
async def core_missing(_request, _exc):
    return JSONResponse({"error": "herdr-core is not running"}, status_code=503)


# ── REST ────────────────────────────────────────────────────────────────
@app.get("/api/status")
async def status():
    return await rpc("server.status")


@app.get("/api/terminals")
async def list_terminals(all: bool = False):
    return await rpc("terminal.list", {"all": all})


class NewTerminal(BaseModel):
    kind: str = "claude"  # "claude" or "shell"
    name: str | None = None
    cwd: str | None = None
    cols: int = 120
    rows: int = 32
    on: str | None = None  # another machine added to the core
    args: list[str] = []


@app.post("/api/terminals")
async def new_terminal(body: NewTerminal):
    if body.kind not in ("claude", "shell"):
        raise HTTPException(422, "kind must be claude or shell")
    if body.name and not NAME_RE.match(body.name):
        raise HTTPException(422, "name: 1-32 of a-z 0-9 _ . -")
    params: dict = {
        "env": XTERM_ENV,
        "labels": {"app": "lcars", "kind": body.kind},
        "size": {"cols": body.cols, "rows": body.rows},
        "no_parent": True,
    }
    if body.kind == "claude":
        params["argv"] = ["claude", *body.args]
    if body.name:
        params["name"] = body.name
    if body.cwd:
        params["cwd"] = body.cwd
    if body.on:
        params["on"] = body.on
    return await rpc("terminal.run", params)


@app.delete("/api/terminals")
async def kill_terminal(terminal: str):
    return await rpc("terminal.kill", {"terminal": terminal})


@app.post("/api/terminals/remove")
async def remove_terminal(terminal: str):
    return await rpc("terminal.rm", {"terminal": terminal})


class SendBody(BaseModel):
    terminal: str
    text: str


class KeysBody(BaseModel):
    terminal: str
    keys: list[str]


@app.post("/api/terminals/send")
async def send_text(body: SendBody):
    return await rpc("terminal.send", {"terminal": body.terminal, "text": body.text})


@app.post("/api/terminals/keys")
async def send_keys(body: KeysBody):
    return await rpc("terminal.keys", {"terminal": body.terminal, "keys": body.keys})


@app.post("/api/terminals/interrupt")
async def interrupt(terminal: str):
    return await rpc("terminal.interrupt", {"terminal": terminal})


@app.post("/api/terminals/upload")
async def upload(terminal: str = Form(...), file: UploadFile = File(...)):
    """Put a pasted image or dropped document beside a terminal; returns the path to type."""
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "file larger than 8 MB")
    name = Path(file.filename or "upload").name or "upload"
    return await rpc("terminal.put", {"terminal": terminal, "name": name, "data": base64.b64encode(data).decode()})


@app.get("/api/doc/{name}")
async def get_doc(name: str, on: str | None = None):
    return await rpc("doc.get", {"name": name, **({"on": on} if on else {})})


class DocBody(BaseModel):
    value: object
    version: int


@app.put("/api/doc/{name}")
async def set_doc(name: str, body: DocBody, on: str | None = None):
    return await rpc("doc.set", {"name": name, "value": body.value, "version": body.version, **({"on": on} if on else {})})


@app.get("/api/machines")
async def machines():
    return await rpc("machine.list")


# ── live: terminal streams and the event feed ──────────────────────────
async def _ws_ok(ws: WebSocket) -> bool:
    ok = _authorized(ws.headers, ws.cookies, ws.client.host if ws.client else None) and _same_origin(ws.headers)
    if not ok:
        await ws.close(code=4401)
    return ok


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    """Snapshot of terminals, then every change the core reports."""
    if not await _ws_ok(ws):
        return
    await ws.accept()
    core = None
    try:
        core = await Core().connect()
        snap, feed = await core.subscribe()
        await ws.send_text(json.dumps({"type": "snapshot", **snap}))

        async def pump():
            while True:
                await ws.send_text(json.dumps({"type": "notification", **(await feed.next())}))

        async def watch_browser():
            while (await ws.receive())["type"] != "websocket.disconnect":
                pass

        tasks = [asyncio.create_task(pump()), asyncio.create_task(watch_browser())]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in tasks:
            t.cancel()
    except (ConnectionError, FileNotFoundError, CoreError) as e:
        await _ws_send_error(ws, e)
    finally:
        if core:
            await core.close()


async def _ws_send_error(ws: WebSocket, err: Exception):
    try:
        await ws.send_text(json.dumps({"type": "error", "error": str(err)}))
        await ws.close()
    except Exception:
        pass


@app.websocket("/ws/term")
async def ws_term(ws: WebSocket, terminal: str, cols: int = 120, rows: int = 32, observe: int = 0, history: int = 0):
    """Bytes both ways between the browser terminal and one core terminal.

    Browser -> server: binary frames or {"type":"input","data":...} are typed into the
    terminal; {"type":"resize","cols","rows"} and {"type":"focus","focused":bool} are controls.
    Server -> browser: binary frames are terminal output (the first is a full repaint);
    text frames are {"type":"attached"|"closed"|"error"}.
    """
    if not await _ws_ok(ws):
        return
    await ws.accept()
    core = None
    try:
        core = await Core().connect()
        stream, res = await core.attach(terminal, cols, rows, observe=bool(observe), history=history)
        await ws.send_text(json.dumps({"type": "attached", "terminal": res["terminal"], "observe": bool(observe)}))

        async def to_browser():
            while True:
                kind, payload = await stream.recv()
                if kind == DATA:
                    await ws.send_bytes(payload)
                elif kind == CLOSE:
                    await ws.send_text(json.dumps({"type": "closed", "reason": stream.close_reason}))
                    return

        async def to_core():
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    return
                if observe:
                    continue
                if msg.get("bytes"):
                    await stream.send_data(msg["bytes"])
                elif msg.get("text"):
                    try:
                        c = json.loads(msg["text"])
                    except ValueError:
                        continue
                    t = c.get("type")
                    if t == "input":
                        await stream.send_data(str(c.get("data", "")).encode())
                    elif t == "resize":
                        await stream.resize(max(2, int(c["cols"])), max(2, int(c["rows"])))
                    elif t == "focus":
                        await stream.focus(bool(c.get("focused")))

        tasks = [asyncio.create_task(to_browser()), asyncio.create_task(to_core())]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in tasks:
            t.cancel()
        if not stream.close_reason:
            await stream.detach()  # leave the program running
    except (ConnectionError, FileNotFoundError, CoreError) as e:
        await _ws_send_error(ws, e)
    finally:
        if core:
            await core.close()


# ── pages ───────────────────────────────────────────────────────────────
@app.get("/")
async def index():
    page = STATIC / "index.html"
    return FileResponse(page) if page.exists() else HTMLResponse("<h1>LCARS Claude</h1>")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
