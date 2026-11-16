"""Other machines: add, rename, reconnect and remove, through herdr-core's own machine support.

The core keeps the machines (an ssh target and a name) and shows their terminals as `name/t7`. Adding one is done with
the `hc` command because only the command can also copy hc to a machine that has none. Nothing here is built into a
shell line: the target and name are checked against strict patterns and passed as separate arguments, and a target
can never begin with "-" (that would be an ssh option).
"""
import asyncio
import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import agents

router = APIRouter()

# user@host, host, user@host:port, user@[v6]; never starts with "-"
TARGET_RE = re.compile(r"^(?!-)(?:[A-Za-z0-9._-]{1,64}@)?(?:[A-Za-z0-9._-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$")
# becomes the prefix of every address (name/t7), so no slash, space or capitals
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,31}$")
PUBKEY = Path.home() / ".ssh" / "id_ed25519.pub"


def _hc() -> str:
    import shutil
    return shutil.which("hc", path=agents.SEARCH_PATH) or str(Path.home() / ".local" / "bin" / "hc")


def _check_name(name: str) -> str:
    name = (name or "").strip().lower()
    if not NAME_RE.match(name):
        raise HTTPException(422, "name: 1-32 letters, digits, - _ . (no spaces)")
    return name


class AddBody(BaseModel):
    target: str
    name: str
    install: bool = False


class RenameBody(BaseModel):
    machine: str
    new_name: str


class MachineBody(BaseModel):
    machine: str


@router.post("/api/machines")
async def add_machine(body: AddBody):
    target = body.target.strip()
    if not TARGET_RE.match(target):
        raise HTTPException(422, "address: user@host, host or user@host:port (letters, digits, . _ - only)")
    name = _check_name(body.name)
    cmd = [_hc(), "machine", "add", target, "--name", name, "--json"] + (["--install"] if body.install else [])
    proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), 180)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "the machine did not answer in time")
    text = out.decode(errors="replace").strip()
    result = None
    # the result is one JSON line (on stdout when it worked, on stderr when it did not); an install note may precede it
    for line in reversed((text + "\n" + err.decode(errors="replace")).strip().splitlines()):
        try:
            parsed = json.loads(line)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            result = parsed
            break
    if proc.returncode != 0 or not isinstance(result, dict) or "error" in result:
        e = (result or {}).get("error") or {}
        detail = e.get("message") or (err.decode(errors="replace").strip() or text or "could not add the machine")[:400]
        return JSONResponse({"detail": detail, "kind": e.get("kind"), "hint": e.get("hint")}, status_code=422)
    return result


@router.post("/api/machines/connect")
async def connect_machine(body: MachineBody):
    from .main import rpc
    return await rpc("machine.connect", {"machine": _check_name(body.machine)})


@router.post("/api/machines/rename")
async def rename_machine(body: RenameBody):
    from .main import rpc
    return await rpc("machine.rename", {"machine": _check_name(body.machine), "new_name": _check_name(body.new_name)})


@router.delete("/api/machines")
async def remove_machine(machine: str):
    from .main import rpc
    return await rpc("machine.rm", {"machine": _check_name(machine)})


@router.get("/api/machines/pubkey")
async def pubkey():
    """This server's public key, for the one-line command that lets it log in to a new machine."""
    try:
        key = PUBKEY.read_text().strip()
    except OSError:
        raise HTTPException(404, "this server has no ssh key yet")
    if "'" in key:
        raise HTTPException(500, "unexpected characters in the ssh key")
    one = f"mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '{key}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
    return {"pubkey": key, "command": one}
