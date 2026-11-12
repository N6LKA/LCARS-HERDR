"""Login for LCARS: username + password + authenticator app (TOTP), with server-side sessions.

 - Accounts: each user has a username, a password (scrypt hash) and their own 2FA. The first account is an admin; an admin can
   add and remove other users. Every user gets the same access to this machine's terminals, so add only people you trust.
 - There is no built-in password. The first visit to the login page creates the first account: from a direct local-network
   connection that needs nothing else; from anywhere else (or through any proxy) it needs a one-time setup code
   (`python3 -m app.auth setup-code`, also logged at startup).
 - When a user has 2FA on, a 6-digit authenticator code (or a one-time recovery code) is required with the password. Username,
   password and code are always checked together, so the page never reveals which part was wrong or whether a user exists.
 - A session is a random value kept on the server (only its hash is stored), so it can expire, be listed and be revoked.
 - Failed logins are counted by the real client address (the last X-Forwarded-For entry when the request came through a
   trusted proxy), per address and across all addresses.
 - Direct connections from this machine itself (no proxy header) may use the optional LCARS_TOKEN from .env instead of an
   account. It is only for programs on this machine (tools, tests), never accepted from the network.
State lives in auth.json next to the app (mode 600). Manage it on the server with
`python3 -m app.auth status | setup-code | reset-2fa USER | set-password USER | remove-all-users`.
"""
import base64
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import struct
import sys
import tempfile
import threading
import time
from pathlib import Path

STATE_FILE = Path(os.environ.get("LCARS_AUTH_FILE") or Path(__file__).resolve().parent.parent / "auth.json")
SESSION_MAX = 30 * 86400      # absolute lifetime
SESSION_IDLE = 7 * 86400      # unused for this long = gone
PER_IP = (5, 300)             # failures, seconds
GLOBAL = (40, 3600)
ISSUER = "LCARS"
MIN_PASSWORD = 12
USER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")
LEGACY_USER = "lcars"          # the account an older single-password install becomes
_lock = threading.RLock()
_fail_ip: dict[str, list[float]] = {}
_fail_all: list[float] = []
_DUMMY_SALT = b"lcars-no-such-user"


def _empty_totp() -> dict:
    return {"secret": None, "enabled": False, "last": 0}


# ── state file ───────────────────────────────────────────────────────────
def _load() -> dict:
    try:
        d = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        d = {}
    d.setdefault("users", {})
    d.setdefault("sessions", {})
    d.setdefault("setup", None)
    if d.get("password") and not d["users"]:             # an older install: one password, one 2FA
        d["users"][LEGACY_USER] = {**d["password"], "totp": d.get("totp") or _empty_totp(), "recovery": d.get("recovery") or [],
                                   "role": "admin", "created": time.time()}
        for s in d["sessions"].values():
            s.setdefault("user", LEGACY_USER)
    for k in ("password", "totp", "recovery"):
        d.pop(k, None)
    for s in d["sessions"].values():
        s.setdefault("user", LEGACY_USER)
    return d


def _save(d: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(STATE_FILE.parent), prefix=".auth-")
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _scrypt(pw: str, salt: bytes) -> str:
    return hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32).hex()


def _hash_pw(pw: str) -> dict:
    salt = secrets.token_bytes(16)
    return {"salt": salt.hex(), "hash": _scrypt(pw, salt)}


def clean_username(name: str) -> str:
    name = (name or "").strip().lower()
    if not USER_RE.match(name):
        raise ValueError("username: 2-32 letters, digits, . _ - (no spaces)")
    return name


def _check_new_password(pw: str) -> None:
    if len(pw or "") < MIN_PASSWORD:
        raise ValueError(f"the password needs at least {MIN_PASSWORD} characters")


# ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──────────────────────────────
def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _hotp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = mac[-1] & 15
    return f"{(struct.unpack('>I', mac[o:o + 4])[0] & 0x7FFFFFFF) % 10**6:06d}"


def _totp_match(secret: str, code: str, after: int = 0) -> int | None:
    """Counter the code matches (this 30 s step, or one either side), if newer than `after` (no code is used twice)."""
    now = int(time.time() // 30)
    hit = None
    for c in (now - 1, now, now + 1):                # check all three so timing does not show which one matched
        if hmac.compare_digest(_hotp(secret, c), code) and c > after:
            hit = c
    return hit


def otpauth_uri(secret: str, user: str = "lcars") -> str:
    return f"otpauth://totp/{ISSUER}:{user}?secret={secret}&issuer={ISSUER}&algorithm=SHA1&digits=6&period=30"


def _totp_on(u: dict) -> bool:
    t = u.get("totp") or {}
    return bool(t.get("enabled") and t.get("secret"))


# ── who is asking ────────────────────────────────────────────────────────
def client_ip(headers, client_host: str | None, trusted: set[str]) -> str:
    xff = headers.get("x-forwarded-for", "")
    if client_host in trusted and xff:
        last = xff.split(",")[-1].strip()            # the address the trusted proxy itself saw
        if last:
            return last
    return client_host or "?"


def is_local(headers, client_host: str | None) -> bool:
    return client_host in ("127.0.0.1", "::1") and not headers.get("x-forwarded-for")


_FORWARD = ("x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via", "cf-connecting-ip")


def direct_lan(headers, client_host: str | None) -> bool:
    """A browser talking straight to the app from a private/local address, with no proxy in between. A request that carries
    any forwarding header is treated as proxied, so a reverse proxy can never make itself look like the LAN."""
    import ipaddress
    if any(h in headers for h in _FORWARD):
        return False
    try:
        return ipaddress.ip_address(client_host or "").is_private
    except ValueError:
        return False


def blocked(ip: str) -> bool:
    now = time.time()
    with _lock:
        _fail_ip[ip] = [t for t in _fail_ip.get(ip, []) if now - t < PER_IP[1]]
        _fail_all[:] = [t for t in _fail_all if now - t < GLOBAL[1]]
        return len(_fail_ip[ip]) >= PER_IP[0] or len(_fail_all) >= GLOBAL[0]


def _fail(ip: str) -> None:
    with _lock:
        _fail_ip.setdefault(ip, []).append(time.time())
        _fail_all.append(time.time())


# ── first run ────────────────────────────────────────────────────────────
SETUP_CODE_TTL = 3600


def users_exist() -> bool:
    with _lock:
        return bool(_load()["users"])


def two_factor_any() -> bool:
    """Whether the login page should offer the code step (any account uses 2FA)."""
    with _lock:
        return any(_totp_on(u) for u in _load()["users"].values())


def make_setup_code() -> str:
    """A one-time code for creating the first account, valid for an hour. Shown only to someone with access to the server."""
    with _lock:
        d = _load()
        code = secrets.token_hex(6)
        d["setup"] = {"hash": _h(code), "expires": time.time() + SETUP_CODE_TTL}
        _save(d)
        return f"{code[:4]}-{code[4:8]}-{code[8:]}"


def setup_first_user(username: str, password: str, code: str = "", direct: bool = False) -> str:
    """First use: create the first (admin) account. Works once. Without a direct local-network connection the one-time
    setup code is required."""
    with _lock:
        d = _load()
        if d["users"]:
            raise ValueError("an account already exists")
        if not direct:
            s = d.get("setup") or {}
            given = "".join(ch for ch in (code or "") if ch.isalnum()).lower()
            if not s or time.time() > s.get("expires", 0) or not hmac.compare_digest(_h(given), s.get("hash", "")):
                raise ValueError("the setup code is missing, wrong or expired")
        name = clean_username(username)
        _check_new_password(password)
        d["setup"] = None
        d["users"][name] = {**_hash_pw(password), "totp": _empty_totp(), "recovery": [], "role": "admin", "created": time.time()}
        _save(d)
        return name


# ── login and sessions ───────────────────────────────────────────────────
def _new_session(d: dict, user: str, ip: str, ua: str) -> str:
    sid = secrets.token_urlsafe(32)
    now = time.time()
    d["sessions"][_h(sid)] = {"user": user, "created": now, "last": now, "ip": ip, "ua": ua[:120]}
    _prune(d)
    return sid


def new_session(user: str, ip: str, ua: str) -> str:
    with _lock:
        d = _load()
        sid = _new_session(d, user, ip, ua)
        _save(d)
        return sid


def login(username: str, password: str, code: str, env: str, ip: str, ua: str, local: bool) -> str | None:
    """A new session id, or None. Every check runs even when an earlier one failed."""
    with _lock:
        d = _load()
        # a program on this machine may present the .env code instead of an account
        if local and env and hmac.compare_digest(password.encode(), env.encode()):
            admin = next((n for n, u in d["users"].items() if u.get("role") == "admin"), "local")
            sid = _new_session(d, admin, ip, ua)
            _save(d)
            return sid
        name = (username or "").strip().lower()
        u = d["users"].get(name)
        salt = bytes.fromhex(u["salt"]) if u else _DUMMY_SALT          # hash even for an unknown user: same time either way
        good = hmac.compare_digest(_scrypt(password, salt), u["hash"] if u else "0" * 64) and bool(u)
        ok = good
        new_last = used = None
        if u and _totp_on(u):
            t = u["totp"]
            c = "".join(ch for ch in (code or "") if ch.isalnum()).lower()
            second = False
            if len(c) == 6 and c.isdigit():
                m = _totp_match(t["secret"], c, t["last"])
                if m:
                    second, new_last = True, m
            elif c:
                hh = _h(c)
                if hh in u["recovery"]:
                    second, used = True, hh
            ok = ok and second
        if not ok:
            _fail(ip)
            return None
        if new_last:                                     # a code is used up only by a login that fully succeeds
            u["totp"]["last"] = new_last
        if used:
            u["recovery"].remove(used)
        sid = _new_session(d, name, ip, ua)
        _save(d)
        return sid


def _prune(d: dict) -> None:
    now = time.time()
    for k in [k for k, s in d["sessions"].items() if now - s["created"] > SESSION_MAX or now - s["last"] > SESSION_IDLE
              or s.get("user") not in d["users"] and d["users"]]:
        del d["sessions"][k]


def session_user(sid: str) -> str | None:
    """The username behind a valid session (and note that it is in use), or None."""
    if not sid:
        return None
    with _lock:
        d = _load()
        s = d["sessions"].get(_h(sid))
        if not s:
            return None
        now = time.time()
        if now - s["created"] > SESSION_MAX or now - s["last"] > SESSION_IDLE or (d["users"] and s["user"] not in d["users"]):
            del d["sessions"][_h(sid)]
            _save(d)
            return None
        if now - s["last"] > 600:                    # note use at most every 10 minutes
            s["last"] = now
            _save(d)
        return s["user"]


def session_ok(sid: str) -> bool:
    return session_user(sid) is not None


def logout(sid: str, others: bool = False) -> None:
    with _lock:
        d = _load()
        mine = _h(sid or "")
        me = (d["sessions"].get(mine) or {}).get("user")
        for k, s in list(d["sessions"].items()):
            if (k != mine and s.get("user") == me) if others else (k == mine):
                del d["sessions"][k]
        _save(d)


def status(sid: str) -> dict:
    with _lock:
        d = _load()
        mine = _h(sid or "")
        me = (d["sessions"].get(mine) or {}).get("user")
        u = d["users"].get(me) or {}
        out = {
            "user": me, "role": u.get("role"),
            "totp": _totp_on(u), "recovery_left": len(u.get("recovery") or []),
            "sessions": sorted(({"id": k[:8], "created": s["created"], "last": s["last"], "ip": s["ip"], "ua": s["ua"],
                                 "current": k == mine} for k, s in d["sessions"].items() if s.get("user") == me), key=lambda x: -x["last"]),
        }
        if u.get("role") == "admin":
            out["users"] = [{"username": n, "role": x.get("role"), "totp": _totp_on(x), "created": x.get("created"),
                             "signed_in": sum(1 for s in d["sessions"].values() if s.get("user") == n)}
                            for n, x in sorted(d["users"].items())]
        return out


# ── account changes (always for the signed-in user) ──────────────────────
def _account(d: dict, user: str) -> dict:
    u = d["users"].get(user)
    if not u:
        raise ValueError("this session has no account (it came from a program on this machine)")
    return u


def _pw_right(u: dict, pw: str) -> bool:
    return hmac.compare_digest(_scrypt(pw or "", bytes.fromhex(u["salt"])), u["hash"])


def change_password(user: str, current: str, new: str, keep_sid: str) -> None:
    with _lock:
        d = _load()
        u = _account(d, user)
        if not _pw_right(u, current):
            raise ValueError("the current password is not right")
        _check_new_password(new)
        u.update(_hash_pw(new))
        keep = _h(keep_sid or "")
        d["sessions"] = {k: v for k, v in d["sessions"].items() if k == keep or v.get("user") != user}   # your other devices sign in again
        _save(d)


def change_username(user: str, new_name: str, current: str, keep_sid: str) -> str:
    with _lock:
        d = _load()
        u = _account(d, user)
        if not _pw_right(u, current):
            raise ValueError("the current password is not right")
        new = clean_username(new_name)
        if new != user and new in d["users"]:
            raise ValueError("that username is taken")
        if new != user:
            d["users"][new] = d["users"].pop(user)
            for s in d["sessions"].values():
                if s.get("user") == user:
                    s["user"] = new
        _save(d)
        return new


def add_user(actor: str, name: str, password: str) -> str:
    with _lock:
        d = _load()
        if _account(d, actor).get("role") != "admin":
            raise ValueError("only an admin can add users")
        n = clean_username(name)
        if n in d["users"]:
            raise ValueError("that username is taken")
        _check_new_password(password)
        d["users"][n] = {**_hash_pw(password), "totp": _empty_totp(), "recovery": [], "role": "user", "created": time.time()}
        _save(d)
        return n


def remove_user(actor: str, name: str) -> None:
    with _lock:
        d = _load()
        if _account(d, actor).get("role") != "admin":
            raise ValueError("only an admin can remove users")
        n = (name or "").strip().lower()
        if n not in d["users"]:
            raise ValueError("no such user")
        if n == actor:
            raise ValueError("you cannot remove your own account here")
        del d["users"][n]
        d["sessions"] = {k: v for k, v in d["sessions"].items() if v.get("user") != n}
        _save(d)


# ── turning 2FA on and off (own account) ─────────────────────────────────
def totp_begin(user: str) -> dict:
    """A fresh secret, kept but not active until a code from it is confirmed."""
    with _lock:
        d = _load()
        u = _account(d, user)
        if _totp_on(u):
            raise ValueError("2FA is already on")
        u["totp"] = {"secret": new_secret(), "enabled": False, "last": 0}
        _save(d)
        return {"secret": u["totp"]["secret"], "uri": otpauth_uri(u["totp"]["secret"], user)}


def totp_confirm(user: str, code: str) -> list[str]:
    """Check a code from the new secret, switch 2FA on, and return 8 recovery codes (shown once, stored hashed)."""
    with _lock:
        d = _load()
        u = _account(d, user)
        t = u["totp"]
        if t["enabled"] or not t["secret"]:
            raise ValueError("start the setup first")
        c = _totp_match(t["secret"], "".join(ch for ch in code if ch.isdigit()))
        if not c:
            raise ValueError("that code is not right")
        t["enabled"], t["last"] = True, c
        codes = [secrets.token_hex(5) for _ in range(8)]
        u["recovery"] = [_h(x) for x in codes]
        _save(d)
        return [f"{x[:5]}-{x[5:]}" for x in codes]


def totp_disable(user: str, code: str) -> None:
    with _lock:
        d = _load()
        u = _account(d, user)
        if not _totp_on(u):
            return
        code = "".join(ch for ch in code if ch.isalnum()).lower()
        c = _totp_match(u["totp"]["secret"], code, u["totp"]["last"]) if code.isdigit() and len(code) == 6 else None
        if not c:
            raise ValueError("that code is not right")
        u["totp"], u["recovery"] = _empty_totp(), []
        _save(d)


# ── command line, for the server's own shell ─────────────────────────────
def _cli() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    arg = sys.argv[2].strip().lower() if len(sys.argv) > 2 else ""
    with _lock:
        d = _load()
        if cmd == "reset-2fa":                         # lost phone: switch one user's 2FA off
            if arg not in d["users"]:
                sys.exit(f"no such user. Users: {', '.join(d['users']) or '(none)'}")
            d["users"][arg]["totp"], d["users"][arg]["recovery"] = _empty_totp(), []
            d["sessions"] = {k: v for k, v in d["sessions"].items() if v.get("user") != arg}
            _save(d)
            print(f"2FA is off for {arg} and their sessions are signed out. They can sign in and set 2FA up again.")
        elif cmd == "set-password":                    # forgotten password: set a new one (asks twice, never echoed)
            if arg not in d["users"]:
                sys.exit(f"no such user. Users: {', '.join(d['users']) or '(none)'}")
            a, b = getpass.getpass("New password: "), getpass.getpass("Again: ")
            if a != b:
                sys.exit("The two entries differ.")
            _check_new_password(a)
            d["users"][arg].update(_hash_pw(a))
            d["sessions"] = {k: v for k, v in d["sessions"].items() if v.get("user") != arg}
            _save(d)
            print(f"Password changed for {arg}; their sessions are signed out.")
        elif cmd == "remove-all-users":                # start over: the next visit creates the first account again
            d["users"], d["sessions"] = {}, {}
            _save(d)
            print("All accounts removed. The next visit to the login page creates the first account.")
        elif cmd == "setup-code":                      # for the first visit from outside the local network
            if d["users"]:
                print("An account already exists, so no setup code is needed.")
            else:
                print("Setup code (valid 1 hour, works once):", make_setup_code())
        else:
            print("users:", ", ".join(f"{n} ({u.get('role')}, 2FA {'on' if _totp_on(u) else 'off'})" for n, u in d["users"].items()) or "(none: first visit creates the first account)")
            print("sessions:", len(d["sessions"]))


if __name__ == "__main__":
    _cli()
