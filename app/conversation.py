import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

STORE_PATH = Path(os.environ.get("LCARS_STORE", "/opt/lcars-claude/conversations.json"))


class Conversation:
    def __init__(self, conv_id: str | None = None, title: str = "New Session"):
        self.id = conv_id or str(uuid.uuid4())[:8]
        self.title = title
        self.messages: list[dict] = []
        self.claude_session_id: str | None = None
        self.is_remote: bool = False
        self.created_at = time.time()
        self.updated_at = time.time()

    def add_user_message(self, content: list[dict] | str):
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        self.messages.append({"role": "user", "content": content})
        self.updated_at = time.time()

    def add_assistant_message(self, content: list[dict]):
        self.messages.append({"role": "assistant", "content": content})
        self.updated_at = time.time()
        # Auto-title from first user message
        if self.title == "New Session" and len(self.messages) >= 2:
            for msg in self.messages:
                if msg["role"] == "user":
                    for block in msg["content"]:
                        if block.get("type") == "text":
                            text = block["text"][:50].strip()
                            self.title = text + ("..." if len(block["text"]) > 50 else "")
                            break
                    break

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "message_count": len(self.messages),
            "claude_session_id": self.claude_session_id,
            "is_remote": self.is_remote,
        }

    def to_full_dict(self) -> dict:
        d = self.to_dict()
        d["messages"] = self.messages
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "Conversation":
        conv = cls(conv_id=data["id"], title=data.get("title", "Session"))
        conv.claude_session_id = data.get("claude_session_id")
        conv.is_remote = data.get("is_remote", False)
        conv.created_at = data.get("created_at", time.time())
        conv.updated_at = data.get("updated_at", time.time())
        conv.messages = data.get("messages", [])
        return conv


class ConversationStore:
    def __init__(self):
        self._conversations: dict[str, Conversation] = {}
        self._active_id: str | None = None
        self._load()
        if not self._conversations:
            default = Conversation()
            self._conversations[default.id] = default
            self._active_id = default.id
            self._save()
        elif self._active_id not in self._conversations:
            self._active_id = next(iter(self._conversations))

    # ── persistence ────────────────────────────────────────────────────

    def _load(self):
        try:
            if STORE_PATH.exists():
                data = json.loads(STORE_PATH.read_text())
                for cd in data.get("conversations", []):
                    conv = Conversation.from_dict(cd)
                    self._conversations[conv.id] = conv
                self._active_id = data.get("active_id")
                logger.info(f"Loaded {len(self._conversations)} conversations from {STORE_PATH}")
        except Exception as e:
            logger.warning(f"Could not load conversations: {e}")

    def _save(self):
        try:
            data = {
                "active_id": self._active_id,
                "conversations": [
                    c.to_full_dict() for c in
                    sorted(self._conversations.values(), key=lambda c: c.updated_at, reverse=True)
                ],
            }
            tmp = STORE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2))
            tmp.replace(STORE_PATH)
        except Exception as e:
            logger.error(f"Could not save conversations: {e}")

    # ── store ops ──────────────────────────────────────────────────────

    def get(self, conv_id: str) -> Conversation | None:
        return self._conversations.get(conv_id)

    def get_active(self) -> Conversation:
        return self._conversations[self._active_id]

    def new(self) -> Conversation:
        conv = Conversation()
        self._conversations[conv.id] = conv
        self._active_id = conv.id
        self._save()
        return conv

    def set_active(self, conv_id: str) -> Conversation | None:
        if conv_id in self._conversations:
            self._active_id = conv_id
            self._save()
            return self._conversations[conv_id]
        return None

    def update(self, conv_id: str, **kwargs):
        conv = self._conversations.get(conv_id)
        if not conv:
            return
        for k, v in kwargs.items():
            if hasattr(conv, k):
                setattr(conv, k, v)
        conv.updated_at = time.time()
        self._save()

    def delete(self, conv_id: str) -> bool:
        if conv_id not in self._conversations:
            return False
        del self._conversations[conv_id]
        if self._active_id == conv_id:
            if self._conversations:
                self._active_id = next(iter(self._conversations))
            else:
                default = Conversation()
                self._conversations[default.id] = default
                self._active_id = default.id
        self._save()
        return True

    def list_all(self) -> list[dict]:
        return sorted(
            [c.to_dict() for c in self._conversations.values()],
            key=lambda x: x["updated_at"],
            reverse=True,
        )
