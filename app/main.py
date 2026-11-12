"""LCARS: a web front end for the terminals herdr-core runs.

The browser never talks to Claude directly. It attaches to real `claude`
terminals that live in herdr-core on this machine, so MCP tools load once and
every session stays alive when the page is closed.
"""
import asyncio
import base64
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

from . import agents, auth, fs_git, machines
from .core_client import CLOSE, DATA, FOCUS, RESIZE, Core, CoreClosed, CoreError

log = logging.getLogger("lcars")

STATIC = Path(__file__).parent / "static"
TOKEN = os.environ.get("LCARS_TOKEN", "")
# Addresses of the reverse proxy in front of us (Nginx Proxy Manager). They are NOT trusted to have logged anyone in; they
# only tell us whose address to believe in X-Forwarded-For, for counting failed logins.
TRUSTED_PROXIES = {p.strip() for p in os.environ.get("LCARS_TRUSTED_PROXIES", "").split(",") if p.strip()}
COOKIE = "lcars_session"
MAX_UPLOAD = 8 * 1024 * 1024  # terminal.put accepts at most 8 MB raw
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,31}$")
XTERM_ENV = {"TERM": "xterm-256color", "COLORTERM": "truecolor"}

app = FastAPI(title="LCARS", docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(fs_git.router)
app.include_router(machines.router)


# ── auth (see auth.py) ─────────────────────────────────────────────────
def _client(headers, client_host):
    return auth.client_ip(headers, client_host, TRUSTED_PROXIES)


def _authorized(headers, cookies, client_host: str | None) -> bool:
    if auth.session_ok(cookies.get(COOKIE, "")):
        return True
    # a program on this machine itself may present the .env access code; nothing from outside can
    bearer = headers.get("authorization", "")
    return bool(TOKEN) and auth.is_local(headers, client_host) and bearer.startswith("Bearer ") and hmac.compare_digest(bearer[7:], TOKEN)


def _same_origin(headers) -> bool:
    """Reject cross-site pages talking to us (this is a shell on the machine)."""
    origin = headers.get("origin")
    if not origin:
        return True  # not a browser page; the token still applies
    host = headers.get("x-forwarded-host") or headers.get("host", "")
    return urlparse(origin).netloc == host


@app.on_event("startup")
async def _first_run_notice():
    if not auth.password_is_custom():
        log.warning("LCARS first run: open the login page and choose a password. From the local network that is all; from "
                    "anywhere else it needs this one-time setup code (valid 1 hour): %s   (new one: python3 -m app.auth setup-code)",
                    auth.make_setup_code())


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if path in ("/login", "/api/login", "/api/login/info", "/api/login/setup"):
        return await call_next(request)
    if not _authorized(request.headers, request.cookies, request.client.host if request.client else None):
        if path.startswith("/api/"):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return HTMLResponse(LOGIN_PAGE, status_code=401)
    if request.method not in ("GET", "HEAD", "OPTIONS") and not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    response = await call_next(request)
    if path == "/" or path.startswith("/static/"):
        # Revalidate every time (cheap 304s), so a new page never runs against an old script.
        response.headers["Cache-Control"] = "no-cache"
    return response


LOGIN_PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=color-scheme content=dark><meta name=darkreader-lock><title>LCARS</title><style>
:root{color-scheme:dark}
body{background:#000;color:#ff9900;font-family:Antonio,Arial,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
main{display:grid;gap:12px;width:min(320px,90vw)}form{display:grid;gap:12px}[hidden]{display:none!important}h1{margin:0;letter-spacing:.2em;font-size:20px}
input,button{font:inherit;padding:12px;border:0;border-radius:18px;background:#ff9900;color:#000}
input{background:#1a1224;color:#ffcc99}#m{color:#ff7766;min-height:1.2em;text-align:center}a{color:#ff9900;text-align:center;font-size:14px}</style>
<main><form id=f1 onsubmit="return go(event)" method=post action=/login><h1 id=h>LCARS ACCESS</h1>
<input id=u name=username type=text value=lcars autocomplete=username aria-label=Username>
<input id=t name=password type=password placeholder="Password" autofocus autocomplete=current-password>
<input id=t2 name=password-confirm type=password placeholder="Password again" autocomplete=new-password hidden>
<input id=sc name=setup-code placeholder="Setup code from the server" autocomplete=one-time-code hidden>
<button id=b>AUTHORIZE</button></form>
<form id=f2 onsubmit="return go2(event)" method=post action=/login hidden><h1>TWO-STEP CODE</h1>
<input id=c name=totp placeholder="6-digit code" autocomplete=one-time-code inputmode=numeric aria-label="Authenticator code">
<button>VERIFY</button><a id=rec href=# onclick="return recov()">Use a recovery code instead</a></form>
<div id=m></div></main>
<script>let setup=false,need=false;
fetch('/api/login/info').then(r=>r.json()).then(j=>{if(j.setup){setup=true;h.textContent='CHOOSE A PASSWORD';t.placeholder='New password (12+ characters)';t.autocomplete='new-password';t2.hidden=false;sc.hidden=!j.setup_code;b.textContent='SET PASSWORD'}else need=j.code}).catch(()=>{});
function recov(){c.placeholder='Recovery code';c.inputMode='text';c.setAttribute('aria-label','Recovery code');rec.hidden=true;c.focus();return false}
async function login(){const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t.value,code:c.value})});
if(r.ok){location.href='/';return}
f2.hidden=true;f1.hidden=false;t.value='';c.value='';m.textContent=r.status==429?'Too many attempts. Wait a few minutes.':'Access denied';t.focus()}
async function go(e){e.preventDefault();m.textContent='';
if(setup){if(t.value!==t2.value){m.textContent='The passwords do not match';return false}
const r=await fetch('/api/login/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:t.value,code:sc.value})});
if(r.ok)location.href='/?settings=1';else{const j=await r.json().catch(()=>({}));m.textContent=j.detail||'Not available from here'}return false}
if(need){f1.hidden=true;f2.hidden=false;c.focus();return false}   // the password is checked together with the code, so nothing reveals which was wrong
await login();return false}
async function go2(e){e.preventDefault();await login();return false}</script>"""


class LoginBody(BaseModel):
    token: str
    code: str = ""


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return LOGIN_PAGE


@app.get("/api/login/info")
async def login_info(request: Request):
    host = request.client.host if request.client else None
    setup = not auth.password_is_custom()
    return {"code": auth.two_factor_on(), "setup": setup, "setup_code": setup and not auth.direct_lan(request.headers, host)}


class SetupBody(BaseModel):
    password: str
    code: str = ""


@app.post("/api/login/setup")
async def login_setup(body: SetupBody, request: Request):
    host = request.client.host if request.client else None
    ip = _client(request.headers, host)
    if not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    if auth.password_is_custom():
        return JSONResponse({"error": "not available"}, status_code=403)
    direct = auth.direct_lan(request.headers, host)
    if not direct and auth.blocked(ip):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    try:
        auth.setup_password(body.password, body.code, direct)
    except ValueError as e:
        if "setup code" in str(e):
            auth._fail(ip)
        return JSONResponse({"detail": str(e)}, status_code=422)
    sid = auth.new_session(ip, request.headers.get("user-agent", ""))
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE, sid, httponly=True, samesite="strict", secure=secure, max_age=auth.SESSION_MAX)
    return resp


@app.post("/api/login")
async def login(body: LoginBody, request: Request):
    host = request.client.host if request.client else None
    ip = _client(request.headers, host)
    if not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    local = auth.is_local(request.headers, host)
    if not local and auth.blocked(ip):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    sid = auth.login(body.token, body.code, TOKEN, ip, request.headers.get("user-agent", ""), local)
    if not sid:
        await asyncio.sleep(1)           # slows guessing a little more
        return JSONResponse({"error": "denied"}, status_code=401)
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE, sid, httponly=True, samesite="strict", secure=secure, max_age=auth.SESSION_MAX)
    return resp


# ── account: password, 2FA, sessions ───────────────────────────────────
class PwBody(BaseModel):
    current: str
    new: str


class CodeBody(BaseModel):
    code: str = ""


def _sid(request: Request) -> str:
    return request.cookies.get(COOKIE, "")


@app.get("/api/auth/status")
async def auth_status(request: Request):
    return auth.status(_sid(request))


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    auth.logout(_sid(request))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE)
    return resp


@app.post("/api/auth/logout-others")
async def auth_logout_others(request: Request):
    auth.logout(_sid(request), others=True)
    return {"ok": True}


def _guarded(request: Request, fn, *a):
    """Account changes count wrong guesses like a login does, so a stolen session cannot be used to guess the password."""
    host = request.client.host if request.client else None
    ip = _client(request.headers, host)
    if not auth.is_local(request.headers, host) and auth.blocked(ip):
        raise HTTPException(429, "too many attempts")
    try:
        return fn(*a)
    except ValueError as e:
        auth._fail(ip)
        raise HTTPException(422, str(e))


@app.post("/api/auth/password")
async def auth_password(body: PwBody, request: Request):
    host = request.client.host if request.client else None
    _guarded(request, auth.change_password, body.current, body.new, TOKEN, auth.is_local(request.headers, host), _sid(request))
    return {"ok": True}


@app.post("/api/auth/totp/begin")
async def totp_begin(request: Request):
    return _guarded(request, auth.totp_begin)


@app.post("/api/auth/totp/confirm")
async def totp_confirm(body: CodeBody, request: Request):
    return {"recovery": _guarded(request, auth.totp_confirm, body.code)}


@app.post("/api/auth/totp/disable")
async def totp_disable(body: CodeBody, request: Request):
    _guarded(request, auth.totp_disable, body.code)
    return {"ok": True}


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
    kind: str = "claude"  # "claude", "shell", or "agent" (with `agent` naming one from /api/agents)
    agent: str | None = None
    name: str | None = None
    cwd: str | None = None
    cols: int = 120
    rows: int = 32
    on: str | None = None  # another machine added to the core
    args: list[str] = []


@app.post("/api/terminals")
async def new_terminal(body: NewTerminal):
    if body.kind not in ("claude", "shell", "agent"):
        raise HTTPException(422, "kind must be claude, shell or agent")
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
    elif body.kind == "agent":
        # the command comes from our own list, never from the page
        if body.agent not in agents.BY_ID:
            raise HTTPException(422, "unknown agent")
        argv = agents.argv_for(body.agent)
        if not argv:
            raise HTTPException(409, f"{agents.BY_ID[body.agent]['name']} is not installed on this server")
        params["argv"] = argv
        params["env"] = {**XTERM_ENV, **agents.extra_env()}
        params["labels"] = {"app": "lcars", "kind": "agent", "agent": body.agent}
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


class TitleBody(BaseModel):
    terminal: str
    title: str = ""


@app.post("/api/terminals/title")
async def set_title(body: TitleBody):
    """A display name kept as a label in the core, so every browser shows it. Empty clears it."""
    title = body.title.strip()[:40]
    return await rpc("terminal.label", {"terminal": body.terminal, "labels": {"title": title}})


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


@app.get("/api/agents")
async def list_agents():
    return {"agents": agents.listing(), "env_file": str(agents.ENV_FILE)}


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
            # A quiet terminal still sends a keepalive, so a proxy's idle timeout never cuts the link.
            nxt = asyncio.ensure_future(stream.recv())
            try:
                while True:
                    done, _ = await asyncio.wait({nxt}, timeout=20)
                    if not done:
                        await ws.send_text('{"type":"ping"}')
                        continue
                    kind, payload = nxt.result()
                    nxt = asyncio.ensure_future(stream.recv())
                    if kind == DATA:
                        await ws.send_bytes(payload)
                    elif kind == CLOSE:
                        await ws.send_text(json.dumps({"type": "closed", "reason": stream.close_reason}))
                        return
            finally:
                nxt.cancel()

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
SW_JS = """// Keeps LCARS installable as an app. It caches nothing and answers no request itself,
// so a new version is never hidden behind an old copy. It also clears caches an older version left.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', () => {});   // present so browsers treat the page as an installable app
"""


@app.get("/sw.js")
async def service_worker():
    return HTMLResponse(SW_JS, media_type="application/javascript", headers={"Cache-Control": "no-store"})


@app.get("/")
async def index():
    """The page, with every script and stylesheet tagged by its file time.

    A browser that cached an older script keeps asking for the old address, so a new page
    can never run against an old script: the tag changes whenever a file does.
    """
    page = STATIC / "index.html"
    if not page.exists():
        return HTMLResponse("<h1>LCARS</h1>")

    def tag(m):
        f = STATIC / m.group(1)
        return f'/static/{m.group(1)}?v={int(f.stat().st_mtime)}' if f.exists() else m.group(0)

    html = re.sub(r'/static/([A-Za-z0-9_./-]+\.(?:js|css))(?=")', tag, page.read_text())
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
