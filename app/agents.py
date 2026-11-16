"""The coding agents LCARS knows how to start, and how a person installs and signs in to each.

Nothing here installs anything. The install and sign-in steps are shown to the person, who runs them.
Steps come from each vendor's own documentation (read 2026-11-10); check the vendor page if one no longer works.
"""
import os
import shutil
from pathlib import Path

# The path the core gives its terminals, so "installed" means "a terminal here can start it".
SEARCH_PATH = f"{Path.home()}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
_NEW_ENV, _OLD_ENV = Path.home() / ".config" / "lcars" / "agents.env", Path.home() / ".config" / "lcars-claude" / "agents.env"
# an agents.env left at the old location by an earlier version keeps working until it is moved
ENV_FILE = Path(os.environ.get("LCARS_AGENT_ENV") or (_OLD_ENV if _OLD_ENV.exists() and not _NEW_ENV.exists() else _NEW_ENV))

# id, name, short (for buttons), commands to look for (first found is used), extra arguments to start it with,
# install steps, sign-in steps, what account it needs, notes.
# caps: optional extras LCARS can add for an agent, beyond starting it. Everything else (status, split, send file...) works for
# any agent. "resume": "claude" means LCARS can list that agent's earlier conversations (the "claude" adapter reads Claude Code's
# saved sessions). Add a capability only when the agent really supports it.
AGENTS = [
    dict(id="claude", short="Claude", name="Claude Code", commands=["claude"], args=[],
         install=["npm install -g @anthropic-ai/claude-code"],
         login=["$ claude", "Then run /login inside it, or set ANTHROPIC_API_KEY in the agents.env file (see below)."],
         account="A Claude subscription or an Anthropic API account.", note="Needs Node 18 or newer. See the Claude Code docs for other install methods.",
         caps={"resume": "claude"}),
    dict(id="copilot", short="Copilot", name="GitHub Copilot", commands=["copilot"], args=[],
         install=["npm install -g @github/copilot"],
         login=["$ copilot login --device-code", "Open github.com/login/device on any device and enter the code it shows."],
         account="A GitHub Copilot plan. The free plan includes the command-line agent. Check github.com/settings/copilot. "
                 "Copilot that comes with Microsoft 365 is a different product and does not work here.",
         note="Needs Node 22 or newer."),
    dict(id="codex", short="Codex", name="OpenAI Codex", commands=["codex"], args=["--no-daemon"],
         install=["npm install -g @openai/codex"],
         login=["$ codex login --device-auth", "Device-code sign-in must first be turned on in your ChatGPT security settings.",
                "Or sign in on another computer and copy ~/.codex/auth.json here (treat that file like a password)."],
         account="ChatGPT Plus or higher, or an OpenAI API key. Whether a free ChatGPT account can use the command-line tool is unconfirmed.",
         note="Started with --no-daemon so each terminal is self-contained."),
    dict(id="grok", short="Grok", name="Grok", commands=["grok"], args=[],
         install=["curl -fsSL https://x.ai/cli/install.sh | bash"],
         login=["Browser sign-in does not work on a server. Add  XAI_API_KEY=your-key  to the agents.env file (see below)."],
         account="An xAI API key, billed by use. I found no free credits.", note=""),
    dict(id="opencode", short="OpenCode", name="OpenCode", commands=["opencode"], args=[],
         install=["curl -fsSL https://opencode.ai/v2/install | bash"],
         login=["$ opencode auth login"],
         account="Your own provider keys or subscriptions. Cheap pay-per-token models are available, or OpenCode Go at $10 a month.",
         note=""),
    dict(id="cursor", short="Cursor", name="Cursor Agent", commands=["cursor-agent", "agent"], args=[],
         install=["curl https://cursor.com/install -fsS | bash"],
         login=["$ NO_OPEN_BROWSER=1 agent login", "Or add  CURSOR_API_KEY=your-key  to the agents.env file."],
         account="A Cursor account. Whether the free plan includes the command-line agent is unconfirmed.",
         note="The current docs call the command agent; older versions call it cursor-agent."),
    dict(id="amp", short="Amp", name="Amp", commands=["amp"], args=[],
         install=["curl -fsSL https://ampcode.com/install.sh | bash"],
         login=["$ amp login", "Or add  AMP_API_KEY=your-key  to the agents.env file."],
         account="An ampcode.com account. The software is free, but model use is paid or bring-your-own-key.", note=""),
    dict(id="pi", short="Pi", name="Pi", commands=["pi"], args=[],
         install=["curl -fsSL https://pi.dev/install.sh | sh"],
         login=["Run /login inside Pi."],
         account="A subscription or API key from a model provider.", note="Needs Node 22.19 or newer."),
    dict(id="antigravity", short="Antigravity", name="Antigravity (Google)", commands=["agy"], args=[],
         install=["curl -fsSL https://antigravity.google/cli/install.sh | bash"],
         login=["$ agy", "Sign in with your Google account when it asks."],
         account="A Google account. There is a free weekly quota.",
         note="Sign-in is stored in the system keyring, which a server may not have. Untested here."),
    dict(id="gemini", short="Gemini", name="Gemini CLI", commands=["gemini"], args=[],
         install=["npm install -g @google/gemini-cli"],
         login=["Add  GEMINI_API_KEY=your-key  to the agents.env file."],
         account="Google moved free and consumer access to Antigravity. This tool now needs a Code Assist enterprise license, or a usage-billed API key.",
         note=""),
]
BY_ID = {a["id"]: a for a in AGENTS}


def find(agent: dict) -> str | None:
    """The command to run for this agent, or None if it is not installed."""
    for cmd in agent["commands"]:
        if shutil.which(cmd, path=SEARCH_PATH):
            return cmd
    return None


def listing() -> list[dict]:
    out = []
    for a in AGENTS:
        cmd = find(a)
        out.append({k: a[k] for k in ("id", "name", "short", "install", "login", "account", "note")}
                   | {"installed": cmd is not None, "command": cmd, "caps": a.get("caps", {})})
    return out


def argv_for(agent_id: str) -> list[str] | None:
    a = BY_ID.get(agent_id)
    cmd = a and find(a)
    return [cmd, *a["args"]] if cmd else None


def extra_env() -> dict[str, str]:
    """KEY=value lines from the agents.env file, for agents that sign in with an API key.

    Read only if just its owner can read it, so keys are not left open to other users.
    """
    try:
        if ENV_FILE.stat().st_mode & 0o077:
            return {}
        env = {}
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if k.strip().replace("_", "").isalnum():
                    env[k.strip()] = v.strip().strip('"').strip("'")
        return env
    except OSError:
        return {}
