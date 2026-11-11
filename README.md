# LCARS

A Star Trek LCARS-styled web console for the coding-agent terminals running on a server.
It does not talk to any model itself: it shows the real terminals that
[herdr-core](https://github.com/herdrdev/herdr-core) keeps alive on the machine, so Claude Code,
GitHub Copilot, Codex and other agents run exactly as they do in a terminal, with their own tools and
logins, and keep running when you close the page.

## What you get

- **Spaces, tabs and split panes**, the same model as the Herdr desktop app: split right or down, drag
  dividers, drag a pane by its header to move or swap it, zoom, rename, close.
- **Live agent status** (working, needs you, done, idle) with moving bars and alert sounds.
- **An agents menu** that starts any installed agent beside the focused pane, and shows setup steps for the
  ones that are not installed yet.
- **Images and documents**: paste a screenshot (Ctrl+V), drop a file on a pane, or use SEND FILE. The file is
  placed beside the terminal and its path is pasted in.
- **Keyboard shortcuts and menus** after Herdr's defaults: right-click a pane, tab or space; Ctrl+Shift+P for
  every command; Ctrl+Shift+K to find a space, tab or agent; F1 lists every shortcut.
- **Layout shared between browsers** (stored in the core). Installable as an app from the browser.

## How it fits together

```
browser  ->  FastAPI server (this repo, :7842)  ->  herdr-core socket  ->  real terminals
```

- `app/core_client.py` speaks herdr-core's JSON-RPC and framed-stream protocol.
- `app/main.py` is the web server: REST for terminals, WebSockets for live terminal streams and events,
  uploads, and the layout document.
- `app/agents.py` is the list of known coding agents (how to start them, how to install and sign in).
- `app/static/` is the page (xterm.js, no build step).

## Run

Needs Python 3.10+, herdr-core running on the same machine, and `pip install -r requirements.txt`.

```bash
cp .env.example .env     # set LCARS_TOKEN to a long random string
python3 run.py           # serves on :7842
```

Access needs the token (cookie or Bearer). Behind a proxy that has already signed people in (for example
Nginx Proxy Manager with Authelia), set `LCARS_TRUSTED_PROXIES` to the proxy's address and
`LCARS_PROXY_HOSTS` to the host names it serves. Everything else is refused.

## Safety

This is a shell on the machine. Keep it behind a login, never expose it directly to the internet, and keep
each agent's approval prompts on.

## Licences

Apache-2.0 herdr-core and Herdr app inspire the model and shortcuts. xterm.js (MIT) is vendored under
`app/static/vendor`; Antonio (SIL OFL 1.1) is in `app/static/fonts`. The look is an unofficial fan-styled
interpretation of LCARS from Star Trek, with no affiliation.
