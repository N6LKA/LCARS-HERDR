"""Read-only file browsing and git status/diff for the Files and Changes panels, plus a commit.

Everything runs as the same user as the terminals, so this adds no access a person logged in here
does not already have through a terminal. Paths must be absolute, special trees (/proc, /sys, /dev)
are refused, and git is always run with an argument list (never a shell).
"""
import asyncio
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

BLOCKED = ("/proc", "/sys", "/dev")
PER_FOLDER = 500            # entries listed per folder
READ_LIMIT = 400_000        # bytes of a file shown
DIFF_LINES = 1500
MAX_CHANGED = 1000
# read-only git: do not touch the index or run a file-system monitor, so looking never changes the repository
READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"]
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "HOME": os.environ.get("HOME") or str(Path.home())}


def _safe(path: str) -> Path:
    if not path or not os.path.isabs(path) or "\0" in path:
        raise HTTPException(422, "an absolute path is required")
    p = Path(os.path.realpath(path))
    s = str(p)
    if any(s == b or s.startswith(b + "/") for b in BLOCKED):
        raise HTTPException(403, "that part of the system is not available")
    return p


async def _git(cwd: Path, *args: str, read: bool = True, timeout: float = 20):
    cmd = ["git", *(READ if read else []), *args]
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(cwd), stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, env=ENV)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "git took too long")
    return proc.returncode, out, err


async def _toplevel(cwd: Path) -> Path | None:
    if not cwd.is_dir():
        return None
    code, out, _ = await _git(cwd, "rev-parse", "--show-toplevel")
    return Path(out.decode().strip()) if code == 0 and out.strip() else None


# ── files ───────────────────────────────────────────────────────────────
@router.get("/api/fs/list")
async def fs_list(path: str):
    p = _safe(path)

    def go():
        if not p.is_dir():
            raise HTTPException(404, "not a folder")
        entries, truncated = [], False
        try:
            with os.scandir(p) as it:
                for e in it:
                    if e.name == ".git":
                        continue
                    try:
                        is_dir = e.is_dir(follow_symlinks=True)
                    except OSError:
                        is_dir = False
                    entries.append({"name": e.name, "dir": is_dir})
                    if len(entries) > PER_FOLDER:
                        truncated = True
                        break
        except PermissionError:
            raise HTTPException(403, "no permission to read this folder")
        entries = entries[:PER_FOLDER]
        entries.sort(key=lambda x: (not x["dir"], x["name"].lower()))   # folders first, then by name
        return {"path": str(p), "entries": entries, "truncated": truncated}

    return await asyncio.to_thread(go)


@router.get("/api/fs/read")
async def fs_read(path: str):
    p = _safe(path)

    def go():
        if not p.is_file():
            raise HTTPException(404, "not a file")
        size = p.stat().st_size
        try:
            with open(p, "rb") as f:
                data = f.read(READ_LIMIT + 1)
        except PermissionError:
            raise HTTPException(403, "no permission to read this file")
        if b"\0" in data[:8192]:
            return {"path": str(p), "size": size, "binary": True, "truncated": False, "text": ""}
        truncated = len(data) > READ_LIMIT
        return {"path": str(p), "size": size, "binary": False, "truncated": truncated,
                "text": data[:READ_LIMIT].decode("utf-8", errors="replace")}

    return await asyncio.to_thread(go)


# ── git ─────────────────────────────────────────────────────────────────
def _letter(xy: str) -> str:
    if "U" in xy or xy in ("AA", "DD"):
        return "U"
    if "D" in xy:
        return "D"
    if xy == "??" or "A" in xy:
        return "A"
    return "M"


@router.get("/api/git/status")
async def git_status(cwd: str):
    root = await _toplevel(_safe(cwd))
    if not root:
        return {"error": "Not a git repository"}
    code, out, err = await _git(root, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all")
    if code != 0:
        return {"error": err.decode(errors="replace").strip() or "git status failed"}
    files, untracked = [], set()
    for rec in out.decode("utf-8", errors="replace").split("\0"):
        if len(rec) < 4:
            continue
        xy, path = rec[:2], rec[3:]
        files.append({"path": path, "status": _letter(xy), "untracked": xy == "??", "add": 0, "del": 0})
        if xy == "??":
            untracked.add(path)
    truncated = len(files) > MAX_CHANGED
    files = files[:MAX_CHANGED]
    # +/- counts against the last commit (an empty repository counts staged and unstaged changes)
    has_head = (await _git(root, "rev-parse", "--verify", "-q", "HEAD"))[0] == 0
    stats: dict[str, tuple[int, int]] = {}
    for args in ([["diff", "HEAD"]] if has_head else [["diff", "--cached"], ["diff"]]):
        _, o, _ = await _git(root, *args, "--numstat", "-z", "--no-renames")
        for rec in o.decode("utf-8", errors="replace").split("\0"):
            parts = rec.split("\t", 2)
            if len(parts) == 3:
                a, d, p = parts
                pa, pd = stats.get(p, (0, 0))
                stats[p] = (pa + (int(a) if a.isdigit() else 0), pd + (int(d) if d.isdigit() else 0))
    for f in files:
        f["add"], f["del"] = stats.get(f["path"], (0, 0))
    _, b, _ = await _git(root, "symbolic-ref", "--short", "-q", "HEAD")
    branch = b.decode().strip()
    if not branch:
        _, b, _ = await _git(root, "rev-parse", "--short", "HEAD")
        branch = b.decode().strip() or "no commits yet"
    ahead = behind = 0
    c, o, _ = await _git(root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
    if c == 0:
        try:
            ahead, behind = (int(x) for x in o.split())
        except ValueError:
            pass
    return {"root": str(root), "branch": branch, "ahead": ahead, "behind": behind, "files": files, "truncated": truncated,
            "add": sum(f["add"] for f in files), "del": sum(f["del"] for f in files)}


@router.get("/api/git/diff")
async def git_diff(cwd: str, path: str):
    root = await _toplevel(_safe(cwd))
    if not root:
        raise HTTPException(404, "Not a git repository")
    full = Path(os.path.realpath(root / path))
    if root not in full.parents and full != root:
        raise HTTPException(422, "that file is outside the repository")
    tracked = (await _git(root, "ls-files", "--error-unmatch", "--", path))[0] == 0
    if not tracked:   # a new file git does not know yet: show it as all added
        def go():
            if not full.is_file():
                return {"binary": False, "diff": ""}
            data = full.read_bytes()[:READ_LIMIT]
            if b"\0" in data[:8192]:
                return {"binary": True, "diff": ""}
            lines = data.decode("utf-8", errors="replace").splitlines()
            return {"binary": False, "truncated": len(lines) > DIFF_LINES,
                    "diff": "\n".join([f"@@ -0,0 +1,{len(lines)} @@", *("+" + l for l in lines[:DIFF_LINES])])}
        return await asyncio.to_thread(go)
    has_head = (await _git(root, "rev-parse", "--verify", "-q", "HEAD"))[0] == 0
    _, out, _ = await _git(root, "diff", *(["HEAD"] if has_head else []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path)
    text = out.decode("utf-8", errors="replace")
    if "Binary files" in text and "@@" not in text:
        return {"binary": True, "diff": ""}
    lines = text.split("\n")
    start = next((i for i, l in enumerate(lines) if l.startswith("@@")), len(lines))
    lines = lines[start:]
    return {"binary": False, "truncated": len(lines) > DIFF_LINES, "diff": "\n".join(lines[:DIFF_LINES])}


class CommitBody(BaseModel):
    cwd: str
    message: str


@router.post("/api/git/commit")
async def git_commit(body: CommitBody):
    msg = body.message.strip()
    if not msg or len(msg) > 4000:
        raise HTTPException(422, "a commit message is required (up to 4000 characters)")
    root = await _toplevel(_safe(body.cwd))
    if not root:
        raise HTTPException(404, "Not a git repository")
    code, _, err = await _git(root, "add", "-A", read=False, timeout=60)
    if code != 0:
        raise HTTPException(422, err.decode(errors="replace").strip() or "git add failed")
    code, out, err = await _git(root, "commit", "-m", msg, read=False, timeout=60)
    if code != 0:
        raise HTTPException(422, (err or out).decode(errors="replace").strip() or "git commit failed")
    return {"ok": True, "output": out.decode(errors="replace").strip()[:2000]}
