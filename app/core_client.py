"""Async client for herdr-core (`hc`).

Talks JSON-RPC 2.0 over the core's Unix socket. After `hello {framed: true}` the
connection switches to framed mode (herdr-core schema/README.md, wire.rs):

    [channel u32 LE][kind u8][len u32 LE][payload]

Channel 0 carries JSON-RPC (one message per DATA frame). Every other channel is
a byte stream the core opened for us (a terminal attach, or the event feed).
"""
import asyncio
import json
import os
import struct

HEADER = struct.Struct("<IBI")
MAX_PAYLOAD = 16 << 20

# frame kinds
DATA, CREDIT, CLOSE, RESIZE, FOCUS, FACTS, AUTOMATIC_INPUT = range(7)

DEFAULT_DISPLAY = {"fg": "#c8d8ff", "bg": "#000000", "cursor": "#ff9900", "cell": [9, 18]}


def default_socket_path() -> str:
    if path := os.environ.get("HC_SOCKET"):
        return path
    session = os.environ.get("HC_SESSION", "default")
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return f"{base}/herdr-core/{session}.sock"


class CoreError(Exception):
    """An error reply from the core (carries its stable `data.kind`)."""

    def __init__(self, error: dict):
        self.code = error.get("code")
        self.kind = (error.get("data") or {}).get("kind")
        self.data = error.get("data")
        super().__init__(f"{error.get('message', 'core error')} ({self.kind or self.code})")


class CoreClosed(ConnectionError):
    """The connection or a stream ended."""


class Stream:
    """One core channel. Frames are consumed with recv(); consuming returns credit."""

    def __init__(self, core: "Core", channel: int):
        self._core = core
        self.channel = channel
        self._queue: asyncio.Queue = asyncio.Queue()
        self.close_reason: dict | None = None

    def _push(self, kind: int, payload: bytes):
        self._queue.put_nowait((kind, payload))

    async def recv(self) -> tuple[int, bytes]:
        """Next (kind, payload): DATA bytes, a RESIZE, or the final CLOSE."""
        kind, payload = await self._queue.get()
        if kind == DATA:
            await self._core._send(self.channel, CREDIT, struct.pack("<I", len(payload)))
        elif kind == CLOSE:
            try:
                self.close_reason = json.loads(payload) if payload else {}
            except ValueError:
                self.close_reason = {}
            self._core._streams.pop(self.channel, None)
        return kind, payload

    async def send_data(self, data: bytes):
        await self._core._send(self.channel, DATA, data)

    async def resize(self, cols: int, rows: int):
        await self._core._send(self.channel, RESIZE, struct.pack("<HH", cols, rows))

    async def focus(self, focused: bool):
        await self._core._send(self.channel, FOCUS, bytes([1 if focused else 0]))

    async def detach(self):
        """Leave without ending the program."""
        await self._core._send(self.channel, CLOSE, b"")


class EventFeed:
    """The `events.subscribe` channel: newline-delimited JSON notifications."""

    def __init__(self, stream: Stream):
        self._stream = stream
        self._buf = b""

    async def next(self) -> dict:
        while b"\n" not in self._buf:
            kind, payload = await self._stream.recv()
            if kind == CLOSE:
                raise CoreClosed(f"event feed closed: {self._stream.close_reason}")
            if kind == DATA:
                self._buf += payload
        line, self._buf = self._buf.split(b"\n", 1)
        return json.loads(line)

    async def close(self):
        await self._stream.detach()


class Core:
    def __init__(self, path: str | None = None):
        self.path = path or default_socket_path()
        self.hello: dict = {}
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._write_lock = asyncio.Lock()
        self._ids = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._streams: dict[int, Stream] = {}
        self._early: dict[int, list[tuple[int, bytes]]] = {}
        self._task: asyncio.Task | None = None
        self.closed = asyncio.Event()

    async def connect(self) -> "Core":
        self._reader, self._writer = await asyncio.open_unix_connection(self.path, limit=MAX_PAYLOAD)
        hello = {"jsonrpc": "2.0", "id": 0, "method": "hello", "params": {"framed": True}}
        self._writer.write(json.dumps(hello).encode() + b"\n")
        await self._writer.drain()
        reply = json.loads(await self._reader.readline())
        if "error" in reply:
            raise CoreError(reply["error"])
        self.hello = reply["result"]
        self._task = asyncio.create_task(self._read_loop())
        return self

    async def close(self):
        if self._task:
            self._task.cancel()
        if self._writer:
            self._writer.close()
        self._fail_all()

    # ── framing ──────────────────────────────────────────────────────
    async def _send(self, channel: int, kind: int, payload: bytes):
        if self.closed.is_set() or not self._writer:
            raise CoreClosed("core connection is closed")
        async with self._write_lock:
            self._writer.write(HEADER.pack(channel, kind, len(payload)) + payload)
            await self._writer.drain()

    async def _read_loop(self):
        try:
            while True:
                channel, kind, length = HEADER.unpack(await self._reader.readexactly(HEADER.size))
                if length > MAX_PAYLOAD:
                    raise ValueError("frame too large")
                payload = await self._reader.readexactly(length) if length else b""
                if channel == 0:
                    if kind == DATA:
                        self._on_rpc(json.loads(payload))
                    continue
                stream = self._streams.get(channel)
                if stream:
                    stream._push(kind, payload)
                else:  # the attach reply is queued before its stream, but we may not have registered yet
                    self._early.setdefault(channel, []).append((kind, payload))
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError, ValueError):
            pass
        finally:
            self._fail_all()

    def _on_rpc(self, msg: dict):
        fut = self._pending.pop(msg.get("id"), None)
        if fut and not fut.done():
            if "error" in msg:
                fut.set_exception(CoreError(msg["error"]))
            else:
                fut.set_result(msg.get("result"))

    def _fail_all(self):
        self.closed.set()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(CoreClosed("core connection closed"))
        self._pending.clear()
        for stream in self._streams.values():
            stream._push(CLOSE, b'{"reason":"connection_lost"}')

    def _open_stream(self, channel: int) -> Stream:
        stream = Stream(self, channel)
        self._streams[channel] = stream
        for kind, payload in self._early.pop(channel, []):
            stream._push(kind, payload)
        return stream

    # ── calls ────────────────────────────────────────────────────────
    async def call(self, method: str, params: dict | None = None, timeout: float = 30):
        self._ids += 1
        rid = self._ids
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        await self._send(0, DATA, json.dumps(msg).encode())
        return await asyncio.wait_for(fut, timeout)

    async def attach(self, terminal: str, cols: int, rows: int, *, observe: bool = False,
                     history: int = 0, display: dict | None = None) -> tuple[Stream, dict]:
        res = await self.call("terminal.attach", {
            "terminal": terminal, "cols": cols, "rows": rows, "observe": observe,
            "history": history, "display": display or DEFAULT_DISPLAY,
        })
        return self._open_stream(res["channel"]), res

    async def subscribe(self, **params) -> tuple[dict, EventFeed]:
        res = await self.call("events.subscribe", params)
        return res, EventFeed(self._open_stream(res["channel"]))
