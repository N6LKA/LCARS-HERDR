"""Login for LCARS: access code + authenticator app (TOTP), with server-side sessions.

 - The access code (LCARS_TOKEN) is the first factor. When 2FA is on, a 6-digit authenticator code (or a one-time recovery
   code) is the second, and both are always required together so the page never reveals which part was wrong.
 - A session is a random value kept on the server (only its hash is stored), so it can expire, be listed and be revoked.
 - Failed logins are counted by the real client address (the last X-Forwarded-For entry when the request came through a
   trusted proxy), per address and across all addresses.
 - Direct connections from this machine itself (no proxy header) skip the second factor: whoever is on the box already owns it.
   That keeps local tools and tests working.
State lives in auth.json next to the app (mode 600). `python3 -m app.auth status | setup-code | reset-2fa [--password]`
There is no built-in password: the first visit to the login page chooses it (see /api/login/setup in main.py). From the local network it needs nothing
else; from anywhere else it needs a one-time setup code (`setup-code`, also logged at startup).. manage it on the server.
"""
import base64
import hashlib
import hmac
import json
import os
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
_lock = threading.RLock()
_fail_ip: dict[str, list[float]] = {}
_fail_all: list[float] = []


# ── state file ───────────────────────────────────────────────────────────
def _load() -> dict:
    try:
        d = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        d = {}
    d.setdefault("totp", {"secret": None, "enabled": False, "last": 0})
    d.setdefault("recovery", [])
    d.setdefault("sessions", {})
    d.setdefault("setup", None)
    d.setdefault("password", None)     # {"salt","hash"}; None until the first visit sets it
    return d


def _save(d: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(STATE_FILE.parent), prefix=".auth-")
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


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


def otpauth_uri(secret: str) -> str:
    return f"otpauth://totp/{ISSUER}:lcars?secret={secret}&issuer={ISSUER}&algorithm=SHA1&digits=6&period=30"


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


# ── the password (access code) ───────────────────────────────────────────
MIN_PASSWORD = 12


def _scrypt(pw: str, salt: bytes) -> str:
    return hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32).hex()


def _pw_ok(d: dict, pw: str, env: str, local: bool) -> bool:
    """The password set in the app. The optional .env code is only a key for programs on this machine itself, never remote."""
    rec = d["password"]
    a = bool(rec) and hmac.compare_digest(_scrypt(pw, bytes.fromhex(rec["salt"])), rec["hash"]) if rec else False
    b = bool(env) and hmac.compare_digest(pw.encode(), env.encode())
    return a or (b and local)


SETUP_CODE_TTL = 3600
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


def make_setup_code() -> str:
    """A one-time code for the first password, valid for an hour. Shown only to someone with access to the server."""
    with _lock:
        d = _load()
        code = secrets.token_hex(6)
        d["setup"] = {"hash": _h(code), "expires": time.time() + SETUP_CODE_TTL}
        _save(d)
        return f"{code[:4]}-{code[4:8]}-{code[8:]}"


def setup_password(new: str, code: str = "", direct: bool = False) -> None:
    """First use: choose the password. Works once; after that only a signed-in change_password can replace it.
    Without a direct local-network connection the one-time setup code is required."""
    with _lock:
        d = _load()
        if d["password"]:
            raise ValueError("a password is already set")
        if not direct:
            s = d.get("setup") or {}
            given = "".join(ch for ch in (code or "") if ch.isalnum()).lower()
            if not s or time.time() > s.get("expires", 0) or not hmac.compare_digest(_h(given), s.get("hash", "")):
                raise ValueError("the setup code is missing, wrong or expired")
        if len(new) < MIN_PASSWORD:
            raise ValueError(f"the password needs at least {MIN_PASSWORD} characters")
        d["setup"] = None
        salt = secrets.token_bytes(16)
        d["password"] = {"salt": salt.hex(), "hash": _scrypt(new, salt)}
        _save(d)


def new_session(ip: str, ua: str) -> str:
    with _lock:
        d = _load()
        sid = secrets.token_urlsafe(32)
        now = time.time()
        d["sessions"][_h(sid)] = {"created": now, "last": now, "ip": ip, "ua": ua[:120]}
        _prune(d)
        _save(d)
        return sid


def change_password(current: str, new: str, env: str, local: bool, keep_sid: str) -> None:
    with _lock:
        d = _load()
        if not _pw_ok(d, current, env, local):
            raise ValueError("the current password is not right")
        if len(new) < MIN_PASSWORD:
            raise ValueError(f"the new password needs at least {MIN_PASSWORD} characters")
        salt = secrets.token_bytes(16)
        d["password"] = {"salt": salt.hex(), "hash": _scrypt(new, salt)}
        keep = _h(keep_sid or "")
        d["sessions"] = {k: v for k, v in d["sessions"].items() if k == keep}   # every other device signs in again
        _save(d)


def password_is_custom() -> bool:
    with _lock:
        return bool(_load()["password"])


# ── login and sessions ───────────────────────────────────────────────────
def two_factor_on() -> bool:
    with _lock:
        t = _load()["totp"]
        return bool(t["enabled"] and t["secret"])


def login(token: str, code: str, expected: str, ip: str, ua: str, local: bool) -> str | None:
    """A new session id, or None. Every check runs even when an earlier one failed."""
    with _lock:
        d = _load()
        ok = _pw_ok(d, token, expected, local)
        t = d["totp"]
        if t["enabled"] and t["secret"] and not local:
            code = "".join(ch for ch in (code or "") if ch.isalnum()).lower()
            second = False
            if len(code) == 6 and code.isdigit():
                c = _totp_match(t["secret"], code, t["last"])
                if c:
                    t["last"] = c
                    second = True
            elif code:
                hh = _h(code)
                if hh in d["recovery"]:
                    d["recovery"].remove(hh)         # each recovery code works once
                    second = True
            ok = ok and second
        if not ok:
            _fail(ip)
            return None
        sid = secrets.token_urlsafe(32)
        now = time.time()
        d["sessions"][_h(sid)] = {"created": now, "last": now, "ip": ip, "ua": ua[:120]}
        _prune(d)
        _save(d)
        return sid


def _prune(d: dict) -> None:
    now = time.time()
    for k in [k for k, s in d["sessions"].items() if now - s["created"] > SESSION_MAX or now - s["last"] > SESSION_IDLE]:
        del d["sessions"][k]


def session_ok(sid: str) -> bool:
    if not sid:
        return False
    with _lock:
        d = _load()
        s = d["sessions"].get(_h(sid))
        if not s:
            return False
        now = time.time()
        if now - s["created"] > SESSION_MAX or now - s["last"] > SESSION_IDLE:
            del d["sessions"][_h(sid)]
            _save(d)
            return False
        if now - s["last"] > 600:                    # note use at most every 10 minutes
            s["last"] = now
            _save(d)
        return True


def logout(sid: str, others: bool = False) -> None:
    with _lock:
        d = _load()
        mine = _h(sid or "")
        for k in list(d["sessions"]):
            if (k != mine) if others else (k == mine):
                del d["sessions"][k]
        _save(d)


def status(sid: str) -> dict:
    with _lock:
        d = _load()
        mine = _h(sid or "")
        return {
            "totp": bool(d["totp"]["enabled"] and d["totp"]["secret"]),
            "password_custom": bool(d["password"]),
            "recovery_left": len(d["recovery"]),
            "sessions": sorted(({"id": k[:8], "created": s["created"], "last": s["last"], "ip": s["ip"], "ua": s["ua"],
                                 "current": k == mine} for k, s in d["sessions"].items()), key=lambda x: -x["last"]),
        }


# ── turning 2FA on and off ───────────────────────────────────────────────
def totp_begin() -> dict:
    """A fresh secret, kept but not active until a code from it is confirmed."""
    with _lock:
        d = _load()
        if d["totp"]["enabled"]:
            raise ValueError("2FA is already on")
        d["totp"] = {"secret": new_secret(), "enabled": False, "last": 0}
        _save(d)
        return {"secret": d["totp"]["secret"], "uri": otpauth_uri(d["totp"]["secret"])}


def totp_confirm(code: str) -> list[str]:
    """Check a code from the new secret, switch 2FA on, and return 8 recovery codes (shown once, stored hashed)."""
    with _lock:
        d = _load()
        t = d["totp"]
        if t["enabled"] or not t["secret"]:
            raise ValueError("start the setup first")
        c = _totp_match(t["secret"], "".join(ch for ch in code if ch.isdigit()))
        if not c:
            raise ValueError("that code is not right")
        t["enabled"], t["last"] = True, c
        codes = [secrets.token_hex(5) for _ in range(8)]
        d["recovery"] = [_h(x) for x in codes]
        _save(d)
        return [f"{x[:5]}-{x[5:]}" for x in codes]


def totp_disable(code: str) -> None:
    with _lock:
        d = _load()
        t = d["totp"]
        if not t["enabled"]:
            return
        code = "".join(ch for ch in code if ch.isalnum()).lower()
        c = _totp_match(t["secret"], code, t["last"]) if code.isdigit() and len(code) == 6 else None
        if not c:
            raise ValueError("that code is not right")
        d["totp"], d["recovery"] = {"secret": None, "enabled": False, "last": 0}, []
        _save(d)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "reset-2fa":                             # lost phone: switch 2FA off from the server's own shell
        with _lock:
            d = _load()
            d["totp"], d["recovery"], d["sessions"] = {"secret": None, "enabled": False, "last": 0}, [], {}
            if "--password" in sys.argv:             # also forget the password: the next visit sets a new one
                d["password"] = None
            _save(d)
        print("2FA is off and every session is signed out." + (" The password is cleared: the next visit to the login page sets a new one." if "--password" in sys.argv else "") + " Sign in and set 2FA up again.")
    elif cmd == "setup-code":                          # for the first visit from outside the local network
        if password_is_custom():
            print("A password is already set, so no setup code is needed.")
        else:
            print("Setup code (valid 1 hour, works once):", make_setup_code())
    else:
        s = status("")
        print("2FA:", "on" if s["totp"] else "off", "| recovery codes left:", s["recovery_left"], "| sessions:", len(s["sessions"]))
