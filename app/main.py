import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .conversation import ConversationStore
from .mcp_manager import MCPManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

mcp = MCPManager()
store = ConversationStore()
anthropic_client = anthropic.AsyncAnthropic()

SYSTEM_PROMPT = """You are Claude, an AI assistant running on a local homelab server with full access to the user's MCP tools. You have access to tools for Node-RED, Home Assistant, Proxmox, Grafana, Docker, GitHub, MariaDB, and a persistent memory system (MemPalace).

Be direct and efficient. Use tools proactively when they would help answer a question or complete a task. The user is technically sophisticated — a homelab operator and amateur radio operator (callsign N6LKA)."""


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Connecting MCP servers...")
    connected = await mcp.connect_all()
    logger.info(f"Ready — {connected} MCP servers, {len(mcp.tools)} tools")
    yield
    await mcp.close()


app = FastAPI(title="LCARS Claude Interface", lifespan=lifespan)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    return (static_dir / "index.html").read_text()


@app.get("/api/status")
async def status():
    return {
        "servers": mcp.server_names,
        "tool_count": len(mcp.tools),
        "model": os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8"),
    }


@app.get("/api/conversations")
async def list_conversations():
    return store.list_all()


@app.post("/api/conversations")
async def new_conversation():
    conv = store.new()
    return conv.to_dict()


@app.delete("/api/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    if not store.delete(conv_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"ok": True}


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


class ChatRequest(BaseModel):
    conversation_id: str | None = None
    text: str
    images: list[str] = []  # base64 data URIs


@app.post("/api/chat/stream")
async def chat_stream(request: Request, body: ChatRequest):
    if body.conversation_id:
        conv = store.get(body.conversation_id) or store.get_active()
    else:
        conv = store.get_active()

    # Build content blocks
    content: list[dict] = []
    for data_uri in body.images:
        # data:image/png;base64,<data>
        header, b64data = data_uri.split(",", 1)
        media_type = header.split(":")[1].split(";")[0]
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": b64data},
        })
    if body.text.strip():
        content.append({"type": "text", "text": body.text})

    if not content:
        raise HTTPException(status_code=400, detail="Empty message")

    conv.add_user_message(content)
    model = os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-8")

    async def generate():
        collected_content = []
        try:
            yield {"event": "start", "data": json.dumps({"conversation_id": conv.id})}

            runner = anthropic_client.beta.messages.tool_runner(
                model=model,
                max_tokens=16000,
                thinking={"type": "adaptive"},
                system=SYSTEM_PROMPT,
                tools=mcp.tools,
                messages=conv.messages,
            )

            async for message in runner:
                for block in message.content:
                    if block.type == "text":
                        yield {"event": "text", "data": json.dumps({"text": block.text})}
                    elif block.type == "thinking" and block.thinking:
                        yield {"event": "thinking", "data": json.dumps({"thinking": block.thinking})}
                    elif block.type == "tool_use":
                        yield {"event": "tool_use", "data": json.dumps({
                            "tool": block.name,
                            "input": block.input,
                        })}

                # Collect assistant response content
                collected_content = message.content

            # Serialize content for storage (keep only text blocks for history)
            storable = [
                {"type": b.type, "text": b.text}
                for b in collected_content
                if b.type == "text"
            ]
            if not storable:
                storable = [{"type": "text", "text": ""}]
            conv.add_assistant_message(storable)

            yield {"event": "done", "data": json.dumps({
                "conversation_id": conv.id,
                "title": conv.title,
            })}

        except asyncio.CancelledError:
            logger.info("Client disconnected")
        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            yield {"event": "error", "data": json.dumps({"error": str(e)})}

    return EventSourceResponse(generate())
