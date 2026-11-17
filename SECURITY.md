# Security

## What LCARS-HERDR is, and what that means

LCARS-HERDR is a web front end for real terminals. **Anyone who signs in can run any command the service's user can run.**
Treat access to it like an SSH login to that machine:

- Keep it behind HTTPS and, ideally, a second layer such as a VPN or an authenticating reverse proxy.
- Do not expose it directly to the internet.
- Turn on 2FA for every account and add only people you trust.
- Keep each coding agent's own approval prompts turned on.
- Run it as an ordinary user rather than root where you can. Terminals, and the Files and Changes panels, run as the
  service's user and add no access beyond it.

The README's *Safety* section has the details.

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue.

Use GitHub's private reporting: on the repository page open **Security > Report a vulnerability**. Include what you found,
how to reproduce it, and the version (`version.txt`) or commit you tested.

I'll reply as soon as I can, and I'll credit you in the fix if you want that. Only the latest release is supported.

## Scope

In scope: sign-in, sessions, 2FA, the setup code, request origin checks, file upload and the Files and Changes panels,
and anything that lets someone without an account reach a terminal.

Out of scope: problems that need an already signed-in user to be malicious (they already have a shell by design), and
issues in herdr-core or in the coding agents themselves. Report those to their own projects.
