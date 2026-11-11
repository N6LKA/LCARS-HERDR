import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .claude_runner import run_claude
from .conversation import ConversationStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

store = ConversationStore()

# ─── Permission request state ──────────────────────────────────────
# Pending permission requests from the hook script, keyed by req_id.
# The SSE generator for the active conversation injects these as events;
# the browser shows a modal and POSTs a decision back.

@dataclass
class PendingPermission:
    req_id: str
    tool_name: str
    tool_input: dict
    conv_id: str
    decision: str | None = None

pending_permissions: dict[str, PendingPermission] = {}

# Conversations with "allow all this session" active — auto-approve without modal
session_allow_all: set[str] = set()

# Active SSE streams: conv_id → combined asyncio.Queue
# Items are tagged tuples: ("claude", event_type, payload) or ("perm", sse_event_dict)
active_perm_queues: dict[str, asyncio.Queue] = {}

# ─── App ──────────────────────────────────────────────────────────

app = FastAPI(title="LCARS Claude Interface")

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    content = (static_dir / "index.html").read_text()
    return HTMLResponse(content=content, headers={"Cache-Control": "no-store"})


@app.get("/manifest.json")
async def manifest():
    content = (static_dir / "manifest.json").read_text()
    return Response(content=content, media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker():
    content = (static_dir / "sw.js").read_text()
    return Response(
        content=content,
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/api/status")
async def status():
    return {"model": "claude-code (subscription)", "backend": "claude-code-cli"}


@app.get("/api/metrics")
async def get_metrics():
    def read_stat():
        with open('/proc/stat') as f:
            parts = f.readline().split()
        vals = list(map(int, parts[1:]))
        return sum(vals), vals[3]

    t1, i1 = read_stat()
    await asyncio.sleep(0.5)
    t2, i2 = read_stat()
    cpu_pct = max(0.0, min(100.0, (1 - (i2 - i1) / (t2 - t1)) * 100)) if (t2 - t1) > 0 else 0.0

    meminfo: dict[str, int] = {}
    with open('/proc/meminfo') as f:
        for line in f:
            if ':' in line:
                k, v = line.split(':', 1)
                meminfo[k.strip()] = int(v.strip().split()[0])
    mem_total = meminfo.get('MemTotal', 1)
    mem_avail = meminfo.get('MemAvailable', 0)
    mem_pct = (mem_total - mem_avail) / mem_total * 100

    return {
        "cpu_pct": round(cpu_pct, 1),
        "mem_pct": round(mem_pct, 1),
        "mem_used_mb": round((mem_total - mem_avail) / 1024),
        "mem_total_mb": round(mem_total / 1024),
    }


# ─── Conversations ─────────────────────────────────────────────────

@app.get("/api/conversations")
async def list_conversations():
    return store.list_all()


@app.post("/api/conversations")
async def new_conversation():
    conv = store.new()
    return conv.to_dict()


@app.delete("/api/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    conv = store.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    session_id = conv.claude_session_id
    store.delete(conv_id)
    if session_id:
        session_file = Path.home() / ".claude" / "projects" / "-root" / f"{session_id}.jsonl"
        try:
            session_file.unlink(missing_ok=True)
            logger.info(f"Deleted session file for {session_id}")
        except Exception as e:
            logger.warning(f"Could not delete session file: {e}")
    return {"ok": True}


class UpdateConvRequest(BaseModel):
    title: str


@app.patch("/api/conversations/{conv_id}")
async def update_conversation(conv_id: str, body: UpdateConvRequest):
    conv = store.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if body.title.strip():
        conv.title = body.title.strip()
        conv.updated_at = time.time()
        store._save()
    return conv.to_dict()


@app.post("/api/conversations/{conv_id}/activate")
async def activate_conversation(conv_id: str):
    conv = store.set_active(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv.to_dict()


@app.get("/api/conversations/{conv_id}/messages")
async def get_messages(conv_id: str):
    conv = store.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv.messages



class ResumeRequest(BaseModel):
    session_id: str
    title: str = "Resumed Session"


@app.post("/api/conversations/resume")
async def resume_conversation(body: ResumeRequest):
    conv = store.new()
    conv.claude_session_id = body.session_id
    conv.title = body.title
    store._save()
    return conv.to_dict()


CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "/root/.local/bin/claude")


@app.post("/api/conversations/{conv_id}/uplink")
async def uplink_conversation(conv_id: str):
    """Start a remote-control session, inject LCARS history, and track the new session ID."""
    conv = store.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    tmux_name = f"lcars-{conv_id}"
    subprocess.run(["tmux", "kill-session", "-t", tmux_name], capture_output=True)

    # Snapshot existing JSONL files — new one that appears will be the remote session
    jsonl_dir = Path.home() / ".claude" / "projects" / "-root"
    existing_jsonl = {f.stem for f in jsonl_dir.glob("*.jsonl")}

    # Start fresh --remote-control session (--print sessions can't be resumed in RC mode)
    shell_cmd = f'{CLAUDE_BIN} --remote-control {shlex.quote("LCARS-" + conv_id)}'
    try:
        r = subprocess.run(
            ["tmux", "new-session", "-d", "-s", tmux_name, shell_cmd],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=f"tmux error: {r.stderr.strip()}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="tmux timed out")

    # Poll for URL and simultaneously watch for new JSONL (remote session ID)
    remote_url = None
    new_session_id = None
    for _ in range(25):
        await asyncio.sleep(1)
        pane = subprocess.run(
            ["tmux", "capture-pane", "-t", tmux_name, "-p"],
            capture_output=True, text=True,
        )
        if pane.returncode != 0:
            logger.warning(f"Uplink session {tmux_name} exited early")
            break

        # Check for new JSONL file (may appear before URL)
        if not new_session_id:
            new_jsonl = {f.stem for f in jsonl_dir.glob("*.jsonl")} - existing_jsonl
            if new_jsonl:
                newest = max((jsonl_dir / f"{s}.jsonl" for s in new_jsonl), key=lambda f: f.stat().st_mtime)
                new_session_id = newest.stem

        m = re.search(r'https://claude\.ai/code/session_\S+', pane.stdout)
        if m:
            remote_url = m.group(0).rstrip(')')
            break

    if not remote_url:
        raise HTTPException(status_code=500, detail="Remote-control URL not found — session may have failed to start")

    # Inject LCARS conversation history so the Claude app session has context
    if conv.messages:
        parts = []
        for msg in conv.messages[-16:]:
            role = "User" if msg["role"] == "user" else "Claude"
            content = msg.get("content", [])
            if isinstance(content, list):
                text = " ".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
            else:
                text = str(content).strip()
            if text:
                snippet = (text[:250] + "…") if len(text) > 250 else text
                parts.append(f"{role}: {snippet}")
        if parts:
            context_msg = (
                "This session was uplinked from LCARS. Prior conversation history: "
                + " || ".join(parts)
                + " || [End of LCARS history — you may continue from here]"
            )
            subprocess.run(["tmux", "send-keys", "-t", tmux_name, "-l", context_msg], capture_output=True)
            subprocess.run(["tmux", "send-keys", "-t", tmux_name, "Enter"], capture_output=True)

            # Wait for Claude to respond and for the JSONL to be created
            if not new_session_id:
                for _ in range(15):
                    await asyncio.sleep(1)
                    new_jsonl = {f.stem for f in jsonl_dir.glob("*.jsonl")} - existing_jsonl
                    if new_jsonl:
                        newest = max((jsonl_dir / f"{s}.jsonl" for s in new_jsonl), key=lambda f: f.stat().st_mtime)
                        new_session_id = newest.stem
                        break

    logger.info(f"Uplink conv={conv_id} url={remote_url} new_session={new_session_id}")

    conv.is_remote = True
    conv.remote_url = remote_url
    conv.updated_at = time.time()
    if new_session_id:
        conv.claude_session_id = new_session_id
    store._save()

    result_dict = conv.to_dict()
    result_dict["remote_url"] = remote_url
    return result_dict


@app.post("/api/conversations/{conv_id}/sync")
async def sync_conversation(conv_id: str):
    """Re-read the Claude session JSONL file and refresh stored messages."""
    conv = store.get(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not conv.claude_session_id:
        raise HTTPException(status_code=400, detail="No Claude session to sync")

    session_file = Path.home() / ".claude" / "projects" / "-root" / f"{conv.claude_session_id}.jsonl"
    if not session_file.exists():
        raise HTTPException(status_code=404, detail="Session file not found on disk")

    messages: list[dict] = []
    for line in session_file.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        if obj.get("isSidechain", True):
            continue

        msg_type = obj.get("type")
        if msg_type not in ("user", "assistant"):
            continue

        msg = obj.get("message", {})
        role = msg.get("role", msg_type)
        raw_content = msg.get("content", "")

        if isinstance(raw_content, str):
            if not raw_content.strip():
                continue
            content: list[dict] = [{"type": "text", "text": raw_content}]
        elif isinstance(raw_content, list):
            if role == "assistant":
                content = [b for b in raw_content if isinstance(b, dict) and b.get("type") == "text"]
            else:
                content = [b for b in raw_content if isinstance(b, dict) and b.get("type") in ("text", "image")]
        else:
            continue

        if not content:
            continue

        messages.append({"role": role, "content": content})

    conv.messages = messages
    conv.updated_at = time.time()
    store._save()
    logger.info(f"Synced conv {conv_id}: {len(messages)} messages from JSONL")
    return {"ok": True, "message_count": len(messages)}


# ─── Permission bridge ─────────────────────────────────────────────

class PermHookBody(BaseModel):
    conv_id: str = ""
    data: dict = {}


class PermDecisionBody(BaseModel):
    decision: str       # "allow" or "deny"
    all_session: bool = False  # if True, auto-approve all future requests this session


@app.post("/api/permission/request")
async def permission_request(body: PermHookBody):
    """Called by the permission-hook.sh script when Claude needs authorization."""
    req_id = str(uuid.uuid4())[:8]
    tool_name = body.data.get("tool_name", "Unknown")
    tool_input = body.data.get("tool_input", {})

    perm = PendingPermission(
        req_id=req_id,
        tool_name=tool_name,
        tool_input=tool_input,
        conv_id=body.conv_id,
    )
    pending_permissions[req_id] = perm

    # If "allow all" is active for this conversation, auto-approve silently
    if body.conv_id in session_allow_all:
        perm.decision = "allow"
        logger.info(f"Auto-approved {req_id}: {tool_name} (session allow-all)")
        return {"req_id": req_id, "status": "pending"}

    logger.info(f"Permission request {req_id}: {tool_name} conv={body.conv_id}")

    # Inject SSE event into the active conversation stream
    if body.conv_id and body.conv_id in active_perm_queues:
        await active_perm_queues[body.conv_id].put((
            "perm",
            {
                "event": "permission_request",
                "data": json.dumps({
                    "req_id": req_id,
                    "tool": tool_name,
                    "input": tool_input,
                }),
            },
        ))

    return {"req_id": req_id, "status": "pending"}


@app.get("/api/permission/decision/{req_id}")
async def permission_decision(req_id: str):
    """Polled by the hook script to get the user's decision."""
    perm = pending_permissions.get(req_id)
    if not perm:
        return {"status": "not_found"}
    if perm.decision is None:
        return {"status": "pending"}
    return {"status": perm.decision}


@app.post("/api/permission/response/{req_id}")
async def permission_response(req_id: str, body: PermDecisionBody):
    """Called by the browser when the user clicks Authorize, Allow All, or Deny."""
    perm = pending_permissions.get(req_id)
    if not perm:
        raise HTTPException(status_code=404, detail="Permission request not found or expired")
    if body.decision not in ("allow", "deny"):
        raise HTTPException(status_code=400, detail="Decision must be 'allow' or 'deny'")
    perm.decision = body.decision
    if body.all_session and body.decision == "allow" and perm.conv_id:
        session_allow_all.add(perm.conv_id)
        logger.info(f"Allow-all-session enabled for conv {perm.conv_id}")
    logger.info(f"Permission {req_id} ({perm.tool_name}): {body.decision} all_session={body.all_session}")
    return {"ok": True}


@app.get("/api/permission/session-status/{conv_id}")
async def session_allow_status(conv_id: str):
    """Let the browser check whether allow-all is currently active."""
    return {"allow_all": conv_id in session_allow_all}


@app.post("/api/permission/session-allow/{conv_id}")
async def enable_session_allow(conv_id: str):
    """Let the browser enable allow-all directly (sidebar button)."""
    session_allow_all.add(conv_id)
    logger.info(f"Allow-all-session enabled via button for conv {conv_id}")
    return {"ok": True}


@app.delete("/api/permission/session-allow/{conv_id}")
async def revoke_session_allow(conv_id: str):
    """Let the browser revoke allow-all (click the indicator to cancel)."""
    session_allow_all.discard(conv_id)
    return {"ok": True}


# ─── Chat stream ───────────────────────────────────────────────────

class ChatRequest(BaseModel):
    conversation_id: str | None = None
    text: str
    images: list[str] = []


@app.post("/api/chat/stream")
async def chat_stream(request: Request, body: ChatRequest):
    if body.conversation_id:
        conv = store.get(body.conversation_id) or store.get_active()
    else:
        conv = store.get_active()

    display_content: list[dict] = []
    for data_uri in body.images:
        header, b64data = data_uri.split(",", 1)
        media_type = header.split(":")[1].split(";")[0]
        display_content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": b64data},
        })
    if body.text.strip():
        display_content.append({"type": "text", "text": body.text})

    if not display_content:
        raise HTTPException(status_code=400, detail="Empty message")

    conv.add_user_message(display_content)
    store._save()

    async def generate():
        collected_text: list[str] = []

        # Combined queue receives both Claude CLI output and injected permission events.
        # Items: ("claude", event_type, payload) | ("perm", sse_event_dict)
        combined_queue: asyncio.Queue = asyncio.Queue()
        active_perm_queues[conv.id] = combined_queue

        try:
            yield {"event": "start", "data": json.dumps({"conversation_id": conv.id})}

            async def fill_queue():
                try:
                    async for event_type, payload in run_claude(
                        text=body.text,
                        images=body.images,
                        session_id=conv.claude_session_id,
                        conv_id=conv.id,
                    ):
                        await combined_queue.put(("claude", event_type, payload))
                finally:
                    await combined_queue.put(("claude", None, None))  # sentinel

            task = asyncio.create_task(fill_queue())

            while True:
                try:
                    item = await asyncio.wait_for(combined_queue.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
                    continue

                source = item[0]

                if source == "perm":
                    # Forward permission request to browser immediately
                    yield item[1]
                    continue

                # source == "claude"
                _, event_type, payload = item

                if event_type is None:  # sentinel — CLI finished
                    break

                if event_type == "session":
                    conv.claude_session_id = payload["session_id"]
                    store._save()
                    yield {"event": "session", "data": json.dumps(payload)}
                elif event_type == "text":
                    collected_text.append(payload["text"])
                    yield {"event": "text", "data": json.dumps(payload)}
                elif event_type == "thinking":
                    yield {"event": "thinking", "data": json.dumps(payload)}
                elif event_type == "tool_use":
                    yield {"event": "tool_use", "data": json.dumps(payload)}
                elif event_type == "result_error":
                    yield {"event": "error", "data": json.dumps({"error": payload["error"]})}
                elif event_type == "usage":
                    yield {"event": "usage", "data": json.dumps(payload)}

            await task

            full_text = "\n".join(collected_text)
            conv.add_assistant_message([{"type": "text", "text": full_text}])
            store._save()

            yield {"event": "done", "data": json.dumps({
                "conversation_id": conv.id,
                "title": conv.title,
            })}

        except asyncio.CancelledError:
            logger.info("Client disconnected")
        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            yield {"event": "error", "data": json.dumps({"error": str(e)})}
        finally:
            active_perm_queues.pop(conv.id, None)

    return EventSourceResponse(generate())
