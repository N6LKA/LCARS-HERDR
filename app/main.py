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
CLAUDE_CMD = os.environ.get("LCARS_CLAUDE_CMD", "claude")      # tests point this at a stand-in
CLAUDE_DIR = Path(os.environ.get("LCARS_CLAUDE_DIR") or Path.home() / ".claude")
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
    if not auth.users_exist():
        log.warning("LCARS first run: open the login page and create the first account. From the local network that is all; from "
                    "anywhere else it needs this one-time setup code (valid 1 hour): %s   (new one: python3 -m app.auth setup-code)",
                    auth.make_setup_code())


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if path in ("/login", "/api/login", "/api/login/info", "/api/login/setup", "/api/login/start", "/login/code", "/static/sf-logo.png"):
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


STARFIELD = """<canvas id=stars aria-hidden=true></canvas>
<script>(()=>{const cv=document.getElementById('stars'),cx=cv.getContext('2d');let W=0,H=0,S=[],still=matchMedia('(prefers-reduced-motion:reduce)').matches;
// like the old LCARS: small dim stars that twinkle and drift very slowly, some bluish
const mk=()=>({x:Math.random(),y:Math.random(),r:.35+Math.random()*.95,a:.14+Math.random()*.44,p:Math.random()*6.283,sp:.007+Math.random()*.02,dx:(Math.random()-.5)*.00005,dy:(Math.random()-.5)*.00005,b:Math.random()<.32});
function size(){const d=Math.min(devicePixelRatio||1,2);W=innerWidth;H=innerHeight;cv.width=Math.round(W*d);cv.height=Math.round(H*d);cx.setTransform(d,0,0,d,0,0);
 const n=Math.max(90,Math.min(340,Math.round(W*H/5500)));while(S.length<n)S.push(mk());S.length=n;paint()}
function paint(){cx.clearRect(0,0,W,H);for(const s of S){const a=s.a*(.55+Math.sin(s.p)*.45);cx.fillStyle=s.b?`rgba(160,210,255,${a.toFixed(2)})`:`rgba(215,225,255,${a.toFixed(2)})`;cx.beginPath();cx.arc(s.x*W,s.y*H,s.r,0,6.283);cx.fill()}}
let last=0;function tick(t){if(t-last>33){last=t;for(const s of S){s.p+=s.sp;s.x+=s.dx;s.y+=s.dy;if(s.x<0)s.x=1;if(s.x>1)s.x=0;if(s.y<0)s.y=1;if(s.y>1)s.y=0}paint()}requestAnimationFrame(tick)}
addEventListener('resize',size);size();if(!still)requestAnimationFrame(tick)})()</script>"""
STARFIELD_CSS = "html[data-theme=titan] input{border-radius:10px;background:#2f3749;color:#dfe6f0}html[data-theme=titan] button{border-radius:10px;color:#05070b}html[data-theme=titan] h1{font-weight:400;letter-spacing:.3em;color:#cfd8e6}html[data-theme=titan] #m{color:#ff6f5e}html[data-theme=titan] a{color:#97c8e2}html[data-theme=titan] body{background:radial-gradient(ellipse at 50% 0,#1b2438 0,#05070b 62%)}html[data-theme=picard] input{border-radius:0;border-bottom:1px solid #1c2d3d}html[data-theme=picard] button{border-radius:0;color:#02121a;clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%)}html[data-theme=picard] h1{font-weight:400;letter-spacing:.34em}html[data-theme=picard] body{background:radial-gradient(ellipse at 20% 0,#0d2233 0,#03060a 60%)}#stars{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}main{position:relative;z-index:1}"

LOGIN_PAGE = """<!doctype html><meta charset=utf-8><script>try{(function(){var k=localStorage.getItem("lcars-theme");if(k==="picard"||k==="titan")document.documentElement.dataset.theme=k})()}catch(e){}</script><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=color-scheme content=dark><meta name=darkreader-lock><title>LCARS</title><style>
:root{color-scheme:dark;--a:#ff9900}html[data-theme=picard]{--a:#5ad2f4}html[data-theme=titan]{--a:#7aa9c9}
body{background:#000;color:var(--a);font-family:Antonio,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px 0;box-sizing:border-box}
main{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;width:min(320px,90vw)}#logo{display:block;justify-self:center;margin:0 0 10px;width:min(380px,84vw,46vh);height:auto;aspect-ratio:1}form{display:grid;gap:12px}[hidden]{display:none!important}h1{margin:0;letter-spacing:.2em;font-size:20px;text-align:center}
input,button{font:inherit;padding:12px;border:0;border-radius:18px;background:var(--a);color:#000}
input{background:#1a1224;color:#ffcc99}#m{color:#ff7766;min-height:1.2em;text-align:center}a{color:var(--a);text-align:center;font-size:14px}
p{margin:0;color:#9a8aa8;font-size:14px;text-align:center}/*STARS_CSS*/</style>
<!--STARS--><main><img id=logo src=/static/sf-logo.png width=380 height=380 alt="Starfleet Command" decoding=async><form id=f1 onsubmit="return go(event)" method=post action=/login><h1 id=h>LCARS ACCESS</h1>
<input id=u name=username type=text placeholder="Username" autofocus autocomplete=username autocapitalize=none spellcheck=false required>
<input id=t name=password type=password placeholder="Password" autocomplete=current-password required>
<input id=t2 name=password-confirm type=password placeholder="Password again" autocomplete=new-password hidden>
<input id=sc name=setup-code placeholder="Setup code from the server" autocomplete=one-time-code hidden>
<button id=b>AUTHORIZE</button></form>

<div id=m></div></main>
<script>let setup=false,need=false;
fetch('/api/login/info').then(r=>r.json()).then(j=>{if(j.setup){setup=true;h.textContent='CREATE ACCOUNT';u.placeholder='Choose a username';t.placeholder='New password (12+ characters)';t.autocomplete='new-password';t2.hidden=false;t2.required=true;sc.hidden=!j.setup_code;b.textContent='CREATE ACCOUNT'}else need=j.code}).catch(()=>{});
async function login(){const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,token:t.value,code:''})});
if(r.ok){location.href='/';return}
t.value='';m.textContent=r.status==429?'Too many attempts. Wait a few minutes.':'Access denied';t.focus()}
if(new URLSearchParams(location.search).has('denied'))m.textContent=new URLSearchParams(location.search).get('denied')=='429'?'Too many attempts. Wait a few minutes.':'Access denied';
async function go(e){e.preventDefault();m.textContent='';
if(setup){if(t.value!==t2.value){m.textContent='The passwords do not match';return false}
const r=await fetch('/api/login/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,password:t.value,code:sc.value})});
if(r.ok)location.href='/?settings=1';else{const j=await r.json().catch(()=>({}));m.textContent=j.detail||'Not available from here'}return false}
if(need){const r=await fetch('/api/login/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,token:t.value})});   // password page done: the code is its own page
if(r.ok){const j=await r.json();sessionStorage.setItem('lcars-ticket',j.ticket);location.href='/login/code'}else{t.value='';m.textContent=r.status==429?'Too many attempts. Wait a few minutes.':'Something went wrong';}return false}   // everything is checked together after the code step, so nothing reveals which part was wrong
await login();return false}</script>"""


class LoginBody(BaseModel):
    username: str = ""
    token: str = ""            # the password (kept under this name for programs that already call it)
    code: str = ""
    ticket: str = ""           # set instead of username+token when finishing the two-page login


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return LOGIN_PAGE


@app.get("/api/login/info")
async def login_info(request: Request):
    host = request.client.host if request.client else None
    setup = not auth.users_exist()
    return {"code": auth.two_factor_any(), "setup": setup, "setup_code": setup and not auth.direct_lan(request.headers, host)}


class StartBody(BaseModel):
    username: str = ""
    token: str = ""


@app.post("/api/login/start")
async def login_start(body: StartBody, request: Request):
    """Page one of the two-page login. It always answers with a ticket, whatever was typed, so nothing is revealed."""
    host = request.client.host if request.client else None
    ip = _client(request.headers, host)
    if not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    if not auth.is_local(request.headers, host) and auth.blocked(ip):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    try:
        return {"ticket": auth.start(body.username, body.token, ip)}
    except ValueError:
        return JSONResponse({"error": "too many attempts"}, status_code=429)


CODE_PAGE = """<!doctype html><meta charset=utf-8><script>try{(function(){var k=localStorage.getItem("lcars-theme");if(k==="picard"||k==="titan")document.documentElement.dataset.theme=k})()}catch(e){}</script><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=color-scheme content=dark><meta name=darkreader-lock><title>LCARS</title><style>
:root{color-scheme:dark;--a:#ff9900}html[data-theme=picard]{--a:#5ad2f4}html[data-theme=titan]{--a:#7aa9c9}
body{background:#000;color:var(--a);font-family:Antonio,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px 0;box-sizing:border-box}
main{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;width:min(320px,90vw)}form{display:grid;gap:12px}h1{margin:0;letter-spacing:.2em;font-size:20px;text-align:center}
#logo{display:block;justify-self:center;margin:0 0 10px;width:min(380px,84vw,46vh);height:auto;aspect-ratio:1}
input,button{font:inherit;padding:12px;border:0;border-radius:18px;background:var(--a);color:#000}
input{background:#1a1224;color:#ffcc99}#m{color:#ff7766;min-height:1.2em;text-align:center}a{color:var(--a);text-align:center;font-size:14px}
p{margin:0;color:#9a8aa8;font-size:14px;text-align:center}/*STARS_CSS*/</style>
<!--STARS--><main><img id=logo src=/static/sf-logo.png width=380 height=380 alt="Starfleet Command">
<form id=f onsubmit="return go(event)" method=post action=/login/code><h1>TWO-STEP CODE</h1>
<input id=c name=totp type=text placeholder="6-digit code" autofocus autocomplete=one-time-code inputmode=numeric aria-label="Authenticator code">
<p>If your account does not use 2FA, leave this empty.</p>
<button>VERIFY</button><a id=rec href=# onclick="return recov()">Use a recovery code instead</a><a href=/login>Start over</a></form>
<div id=m></div></main>
<script>const ticket=sessionStorage.getItem('lcars-ticket');if(!ticket)location.replace('/login');
function recov(){c.placeholder='Recovery code';c.inputMode='text';c.setAttribute('aria-label','Recovery code');rec.hidden=true;c.focus();return false}
async function go(e){e.preventDefault();m.textContent='';
const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket,code:c.value})});
sessionStorage.removeItem('lcars-ticket');   // a ticket works once
if(r.ok){location.href='/';return}
location.replace('/login?denied='+(r.status==429?'429':'1'))}</script>"""


LOGIN_PAGE = LOGIN_PAGE.replace("/*STARS_CSS*/", STARFIELD_CSS).replace("<!--STARS-->", STARFIELD)
CODE_PAGE = CODE_PAGE.replace("/*STARS_CSS*/", STARFIELD_CSS).replace("<!--STARS-->", STARFIELD)


@app.get("/login/code", response_class=HTMLResponse)
async def login_code_page():
    return CODE_PAGE


class SetupBody(BaseModel):
    username: str
    password: str
    code: str = ""


def _set_cookie(resp, request: Request, sid: str):
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp.set_cookie(COOKIE, sid, httponly=True, samesite="strict", secure=secure, max_age=auth.SESSION_MAX)
    return resp


@app.post("/api/login/setup")
async def login_setup(body: SetupBody, request: Request):
    host = request.client.host if request.client else None
    ip = _client(request.headers, host)
    if not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    if auth.users_exist():
        return JSONResponse({"error": "not available"}, status_code=403)
    direct = auth.direct_lan(request.headers, host)
    if not direct and auth.blocked(ip):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    try:
        name = auth.setup_first_user(body.username, body.password, body.code, direct)
    except ValueError as e:
        if "setup code" in str(e):
            auth._fail(ip)
        return JSONResponse({"detail": str(e)}, status_code=422)
    sid = auth.new_session(name, ip, request.headers.get("user-agent", ""))
    return _set_cookie(JSONResponse({"ok": True}), request, sid)


@app.post("/api/login")
async def login(body: LoginBody, request: Request):
    host = request.client.host if request.client else None
    ip = _client(request.headers, host)
    if not _same_origin(request.headers):
        return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
    local = auth.is_local(request.headers, host)
    if not local and auth.blocked(ip):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    ua = request.headers.get("user-agent", "")
    sid = auth.login_ticket(body.ticket, body.code, ip, ua) if body.ticket else auth.login(body.username, body.token, body.code, TOKEN, ip, ua, local)
    if not sid:
        await asyncio.sleep(1)           # slows guessing a little more
        return JSONResponse({"error": "denied"}, status_code=401)
    return _set_cookie(JSONResponse({"ok": True}), request, sid)


# ── account: password, 2FA, users, sessions ────────────────────────────
class PwBody(BaseModel):
    current: str
    new: str


class NameBody(BaseModel):
    new: str
    current: str


class UserBody(BaseModel):
    username: str
    password: str


class CodeBody(BaseModel):
    code: str = ""


def _sid(request: Request) -> str:
    return request.cookies.get(COOKIE, "")


def _me(request: Request) -> str:
    me = auth.session_user(_sid(request))
    if not me:
        raise HTTPException(403, "sign in with an account to change account settings")
    return me


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
    """Account changes count wrong guesses like a login does, so a stolen session cannot be used to guess a password."""
    host = request.client.host if request.client else None
    ip = _client(request.headers, host)
    if not auth.is_local(request.headers, host) and auth.blocked(ip):
        raise HTTPException(429, "too many attempts")
    try:
        return fn(*a)
    except ValueError as e:
        auth._fail(ip)
        raise HTTPException(422, str(e))


class PrefsBody(BaseModel):
    theme: str = ""


@app.post("/api/auth/prefs")
async def auth_prefs(body: PrefsBody, request: Request):
    me = _me(request)
    try:
        if body.theme:
            auth.set_pref(me, "theme", body.theme)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"ok": True}


@app.post("/api/auth/password")
async def auth_password(body: PwBody, request: Request):
    _guarded(request, auth.change_password, _me(request), body.current, body.new, _sid(request))
    return {"ok": True}


@app.post("/api/auth/username")
async def auth_username(body: NameBody, request: Request):
    return {"username": _guarded(request, auth.change_username, _me(request), body.new, body.current, _sid(request))}


@app.post("/api/auth/users")
async def auth_add_user(body: UserBody, request: Request):
    return {"username": _guarded(request, auth.add_user, _me(request), body.username, body.password)}


@app.delete("/api/auth/users")
async def auth_remove_user(username: str, request: Request):
    _guarded(request, auth.remove_user, _me(request), username)
    return {"ok": True}


@app.post("/api/auth/totp/begin")
async def totp_begin(request: Request):
    return _guarded(request, auth.totp_begin, _me(request))


@app.post("/api/auth/totp/confirm")
async def totp_confirm(body: CodeBody, request: Request):
    return {"recovery": _guarded(request, auth.totp_confirm, _me(request), body.code)}


@app.post("/api/auth/totp/disable")
async def totp_disable(body: CodeBody, request: Request):
    _guarded(request, auth.totp_disable, _me(request), body.code)
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
        params["argv"] = [CLAUDE_CMD, *body.args]
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
        params["labels"] = {**params.get("labels", {}), "title": body.name}   # the pane shows the session name
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


class SessionNameBody(BaseModel):
    terminal: str
    name: str


def _claude_session_id(pid: int, cwd: str | None) -> str | None:
    """The conversation a running Claude is in: Claude writes ~/.claude/sessions/<pid>.json while it runs."""
    try:
        d = json.loads((CLAUDE_DIR / "sessions" / f"{int(pid)}.json").read_text())
    except (OSError, ValueError, TypeError):
        return None
    sid = d.get("sessionId")
    if not isinstance(sid, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", sid):
        return None
    return sid if not cwd or d.get("cwd") in (None, cwd) else None


@app.post("/api/terminals/session-name")
async def set_session_name(body: SessionNameBody):
    """Give a running Claude a session name (what `hc send <name>` finds). The core fixes a name when a terminal
    starts, so this ends the terminal and starts a new one that resumes the same conversation under the name."""
    name = body.name.strip().lower()
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", name):
        raise HTTPException(422, "name: 1-32 of a-z 0-9 _ -")
    if "/" in body.terminal:
        raise HTTPException(409, "a session on another machine cannot be renamed this way yet")
    info = await rpc("terminal.get", {"terminal": body.terminal})
    if info.get("state") != "live":
        raise HTTPException(409, "that terminal is not running")
    if info.get("name") == name:
        return {"address": info["address"], "restarted": False}
    fg = info.get("foreground") or {}
    if fg.get("name") != "claude" or not fg.get("pid"):
        raise HTTPException(409, "only a running Claude session can be renamed this way")
    sid = _claude_session_id(fg["pid"], info.get("cwd"))
    if not sid:
        raise HTTPException(409, "could not find which conversation this Claude is in, so it was left alone")
    live = (await rpc("terminal.list", {})).get("terminals", [])
    if any(t.get("name") == name and t.get("address") != info["address"] for t in live):
        raise HTTPException(409, f"another session is already named {name}")
    labels = {**(info.get("labels") or {}), "title": name, "kind": "claude", "app": "lcars"}
    base = {
        "env": XTERM_ENV, "labels": labels, "no_parent": True,
        "size": {"cols": info.get("cols") or 120, "rows": info.get("rows") or 32},
        **({"cwd": info["cwd"]} if info.get("cwd") else {}),
    }
    await rpc("terminal.kill", {"terminal": info["address"]})
    try:
        new = await rpc("terminal.run", {**base, "name": name, "argv": [CLAUDE_CMD, "--resume", sid, "--name", name]})
    except HTTPException:
        # put it back as it was, so a failed rename does not lose the conversation
        await rpc("terminal.run", {**base, "argv": [CLAUDE_CMD, "--resume", sid]})
        raise
    try:
        await rpc("terminal.rm", {"terminal": info["address"]})
    except HTTPException:
        pass
    return {"address": new["address"], "old": info["address"], "restarted": True}


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
