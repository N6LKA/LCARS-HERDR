import time
import uuid
from typing import Any


class Conversation:
    def __init__(self, conv_id: str | None = None, title: str = "New Session"):
        self.id = conv_id or str(uuid.uuid4())[:8]
        self.title = title
        self.messages: list[dict] = []
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
        }


class ConversationStore:
    def __init__(self):
        self._conversations: dict[str, Conversation] = {}
        # Start with one default conversation
        default = Conversation()
        self._conversations[default.id] = default
        self._active_id = default.id

    def get(self, conv_id: str) -> Conversation | None:
        return self._conversations.get(conv_id)

    def get_active(self) -> Conversation:
        return self._conversations[self._active_id]

    def new(self) -> Conversation:
        conv = Conversation()
        self._conversations[conv.id] = conv
        self._active_id = conv.id
        return conv

    def set_active(self, conv_id: str) -> Conversation | None:
        if conv_id in self._conversations:
            self._active_id = conv_id
            return self._conversations[conv_id]
        return None

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
        return True

    def list_all(self) -> list[dict]:
        return sorted(
            [c.to_dict() for c in self._conversations.values()],
            key=lambda x: x["updated_at"],
            reverse=True,
        )
