# LCARS Claude Interface

A Picard-era LCARS-styled web interface for Claude Code, with full MCP tool support, streaming responses, and clipboard image paste.

## Features

- **Picard LCARS aesthetic** — dark blue/cyan theme inspired by Star Trek: Picard
- **All MCP tools** — auto-discovers servers from your existing `~/.claude.json`
- **Streaming responses** — real-time token streaming via SSE
- **Clipboard image paste** — Ctrl+V to paste screenshots directly
- **Alt+Enter** for multi-line input, Enter to send
- **Multi-conversation** — manage multiple sessions in the sidebar
- **Local network** — runs on your server, browser connects direct over LAN (fast)

## Requirements

- Python 3.10+
- An Anthropic API key
- Claude Code already configured with MCP servers (reads `~/.claude.json`)

## Quick Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/N6LKA/lcars-claude/main/install.sh)
```

Then edit `/opt/lcars-claude/.env` and add your API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Start the service:

```bash
systemctl start lcars-claude
```

Open in browser: `http://YOUR-SERVER-IP:7842`

## Update

```bash
bash /opt/lcars-claude/install.sh
systemctl restart lcars-claude
```

## Manual Run (dev)

```bash
git clone https://github.com/N6LKA/lcars-claude.git
cd lcars-claude
pip install -r requirements.txt
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY
python3 run.py
```

## Configuration

All config via `/opt/lcars-claude/.env`:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Your Anthropic API key |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Model to use |
| `CLAUDE_CONFIG_PATH` | `~/.claude.json` | Path to Claude Code config (for MCP discovery) |
| `PORT` | `7842` | Port to listen on |
| `HOST` | `0.0.0.0` | Host to bind to |

## Adding to NGINX/Authelia

To expose externally with SSO, proxy `http://127.0.0.1:7842` through your existing NPM/Authelia setup.

## Architecture

```
Browser (LAN) → FastAPI (port 7842 on server)
                    ├── Reads ~/.claude.json for MCP servers
                    ├── Connects to each MCP server
                    ├── Streams responses via SSE
                    └── Anthropic API (for inference only)
```
