"""Subprocess wrapper for the Claude Code CLI."""
import asyncio
import base64
import json
import logging
import os
import tempfile
from collections.abc import AsyncGenerator

logger = logging.getLogger(__name__)

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "/root/.local/bin/claude")


async def run_claude(
    text: str,
    images: list[str],
    session_id: str | None,
    conv_id: str = "",
) -> AsyncGenerator[tuple[str, dict], None]:
    """Invoke Claude Code CLI and yield (event_type, payload) tuples."""
    image_files: list[str] = []
    try:
        for data_uri in images:
            try:
                header, b64data = data_uri.split(",", 1)
                media_type = header.split(":")[1].split(";")[0]
                ext = media_type.split("/")[-1].replace("jpeg", "jpg")
                tf = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
                tf.write(base64.b64decode(b64data))
                tf.close()
                image_files.append(tf.name)
            except Exception as e:
                logger.warning(f"Failed to save image temp file: {e}")

        cmd = [
            CLAUDE_BIN,
            "--print",
            "--output-format", "stream-json",
            "--verbose",
            "--add-dir", "/tmp",
            "--permission-mode", "auto",
        ]
        if session_id:
            cmd += ["--resume", session_id]

        # Build effective prompt — embed image paths so the Read tool (vision-enabled)
        # can view them. The CLI has no --image flag.
        effective_text = text
        if image_files:
            image_list = "\n".join(f"- {f}" for f in image_files)
            prefix = (
                "I have provided the following image file(s). "
                "Please use the Read tool to view each one before responding.\n\n"
                f"Image files:\n{image_list}\n\n"
            )
            effective_text = prefix + (text.strip() or "Please describe what you see in the image(s).")

        logger.info(f"Spawning claude CLI (session={session_id}, images={len(image_files)})")
        cli_env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        cli_env["HOME"] = "/root"
        cli_env["LCARS_CONV_ID"] = conv_id
        cli_env["LCARS_PORT"] = os.environ.get("PORT", "7842")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=cli_env,
            cwd="/root",
            limit=10 * 1024 * 1024,  # 10MB — default 64KB is too small for image JSON lines
        )

        proc.stdin.write(effective_text.encode())
        await proc.stdin.drain()
        proc.stdin.close()

        new_session_id = session_id
        async for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            etype = event.get("type", "")
            subtype = event.get("subtype", "")

            if etype == "system" and subtype == "init":
                new_session_id = event.get("session_id")
                yield "session", {"session_id": new_session_id}

            elif etype == "assistant":
                msg = event.get("message", {})
                for block in msg.get("content", []):
                    btype = block.get("type", "")
                    if btype == "text" and block.get("text"):
                        yield "text", {"text": block["text"]}
                    elif btype == "thinking" and block.get("thinking"):
                        yield "thinking", {"thinking": block["thinking"]}
                    elif btype == "tool_use":
                        yield "tool_use", {
                            "tool": block.get("name", ""),
                            "input": block.get("input", {}),
                        }

            elif etype == "result":
                is_error = event.get("is_error") or subtype not in ("success",)
                errors = event.get("errors") or []
                usage = event.get("usage") or {}
                if is_error and errors:
                    yield "result_error", {"error": " | ".join(errors)}
                elif is_error:
                    yield "result_error", {"error": f"CLI error ({subtype})"}
                else:
                    yield "result_ok", {"session_id": new_session_id}
                if usage:
                    yield "usage", {
                        "input_tokens": usage.get("input_tokens", 0),
                        "output_tokens": usage.get("output_tokens", 0),
                        "cache_read": usage.get("cache_read_input_tokens", 0),
                    }

        await proc.wait()

    finally:
        for f in image_files:
            try:
                os.unlink(f)
            except OSError:
                pass
