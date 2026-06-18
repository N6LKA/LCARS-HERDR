import asyncio
import json
import logging
import os
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from anthropic.lib.tools.mcp import async_mcp_tool
from mcp import ClientSession
from mcp.client.stdio import stdio_client, StdioServerParameters
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger(__name__)


def _load_claude_config() -> dict:
    config_path = os.environ.get("CLAUDE_CONFIG_PATH", "~/.claude.json")
    path = Path(config_path).expanduser()
    if not path.exists():
        logger.warning(f"Claude config not found at {path}")
        return {}
    with open(path) as f:
        data = json.load(f)
    # claude.json has mcpServers at top level (global) and nested under projects
    servers = data.get("mcpServers", {})
    logger.info(f"Loaded {len(servers)} MCP servers from {path}")
    return servers


class MCPManager:
    def __init__(self):
        self._exit_stack = AsyncExitStack()
        self._sessions: dict[str, ClientSession] = {}
        self.tools: list[Any] = []
        self._lock = asyncio.Lock()

    async def connect_all(self) -> int:
        servers = _load_claude_config()
        if not servers:
            logger.warning("No MCP servers found in config")
            return 0

        await self._exit_stack.__aenter__()
        connected = 0
        for name, cfg in servers.items():
            try:
                session = await self._connect_one(name, cfg)
                if session:
                    self._sessions[name] = session
                    connected += 1
            except Exception as e:
                logger.error(f"Failed to connect MCP server '{name}': {e}")

        await self._discover_tools()
        logger.info(f"Connected {connected}/{len(servers)} MCP servers, {len(self.tools)} tools total")
        return connected

    async def _connect_one(self, name: str, cfg: dict) -> ClientSession | None:
        server_type = cfg.get("type", "stdio")

        if server_type == "http":
            url = cfg["url"]
            headers = cfg.get("headers", {})
            read, write, _ = await self._exit_stack.enter_async_context(
                streamablehttp_client(url, headers=headers)
            )
        elif server_type == "stdio":
            command = cfg.get("command")
            args = cfg.get("args", [])
            env = {**os.environ, **cfg.get("env", {})}
            params = StdioServerParameters(command=command, args=args, env=env)
            read, write = await self._exit_stack.enter_async_context(
                stdio_client(params)
            )
        else:
            logger.warning(f"Unknown MCP server type '{server_type}' for '{name}'")
            return None

        session = await self._exit_stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        logger.debug(f"Connected MCP server '{name}' ({server_type})")
        return session

    async def _discover_tools(self):
        all_tools = []
        for name, session in self._sessions.items():
            try:
                result = await session.list_tools()
                for t in result.tools:
                    all_tools.append(async_mcp_tool(t, session))
            except Exception as e:
                logger.error(f"Failed to list tools from '{name}': {e}")
        self.tools = all_tools

    async def close(self):
        await self._exit_stack.__aexit__(None, None, None)

    @property
    def server_names(self) -> list[str]:
        return list(self._sessions.keys())
