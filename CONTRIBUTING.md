# Contributing

Thanks for looking. LCARS-HERDR is a small project with no build step: a FastAPI server (`app/`) and a plain JavaScript page
(`app/static/`) with xterm.js vendored in.

## Try a change

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && chmod 600 .env
PORT=7843 HOST=127.0.0.1 LCARS_AUTH_FILE=/tmp/lcars-dev-auth.json .venv/bin/python run.py
```

It needs [herdr-core](https://github.com/herdrdev/herdr-core) running on the same machine (`hc ls` should work).
Use a different port and a scratch `LCARS_AUTH_FILE` so a test copy never touches a real install. Changes under
`app/static` show on a browser reload; Python changes need the server restarted.

## Pull requests

- Keep each pull request to one change, and describe what you saw and what you expect.
- Write interface text in plain words, and keep it working on a phone-width screen.
- Do not add real hostnames, addresses, names or credentials to code, docs or screenshots.
- Be careful with anything that touches sign-in, sessions, uploads or file access, and say so in the description.

## Reporting problems

Bugs and ideas go in GitHub issues. Security problems do not: see [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the project's licence (GPLv3).
