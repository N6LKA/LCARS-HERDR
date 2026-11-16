#!/usr/bin/env bash
# LCARS installer. Run it from the folder you cloned LCARS into:
#
#     git clone https://github.com/N6LKA/LCARS-HERDR.git && cd LCARS-HERDR && ./install.sh
#
# It checks the requirements, makes a private Python environment, creates the .env file (with a random access
# code), and sets LCARS up as a service that starts at boot. Run as root it installs a system service; run as an
# ordinary user it installs a user service. It never touches herdr-core: that must already be installed.
#
# Options:  --port N      port to serve on (default 7842, or what .env already says)
#           --host ADDR   address to listen on (default 0.0.0.0; use 127.0.0.1 behind a reverse proxy on this machine)
#           --no-service  set up the files only; start it yourself with  .venv/bin/python run.py
#           --dry-run     show what would be done and change nothing
#           --uninstall   stop and remove the service (your files and accounts are kept)
#           -h, --help    this text
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=""; HOST=""; SERVICE=1; DRY=0; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --host) HOST="${2:?--host needs an address}"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then say "   [dry run] $*"; else "$@"; fi; }

if [ "$(id -u)" = 0 ]; then
  MODE=system; UNIT_DIR=/etc/systemd/system; SYSCTL=(systemctl)
else
  MODE=user; UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; SYSCTL=(systemctl --user)
fi
UNIT="$UNIT_DIR/lcars.service"

if [ "$UNINSTALL" = 1 ]; then
  step "Removing the LCARS service ($MODE)"
  run "${SYSCTL[@]}" disable --now lcars.service 2>/dev/null || true
  run rm -f "$UNIT"
  run "${SYSCTL[@]}" daemon-reload
  say "Done. Your files ($DIR), .env and accounts (auth.json) were left in place."
  exit 0
fi

step "Checking requirements"
command -v python3 >/dev/null || die "python3 is not installed. LCARS needs Python 3.10 or newer."
python3 - <<'PY' || die "Python 3.10 or newer is needed (found $(python3 -V 2>&1))."
import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)
PY
say "Python: $(python3 -V 2>&1)"
python3 -c 'import venv, ensurepip' 2>/dev/null || die "Python's venv module is missing. On Debian or Ubuntu:  sudo apt install python3-venv"

HC="$(command -v hc || true)"
[ -z "$HC" ] && [ -x "$HOME/.local/bin/hc" ] && HC="$HOME/.local/bin/hc"
if [ -z "$HC" ]; then
  die "herdr-core (the 'hc' command) was not found. LCARS is an add-on for it and cannot work without it.
       Install herdr-core first: https://github.com/herdrdev/herdr-core  then run this script again."
fi
say "herdr-core: $HC"
if "$HC" ls >/dev/null 2>&1; then say "herdr-core is running."; else say "Note: herdr-core is not answering yet. The service will try to start it; if you run herdr-core another way, start it first."; fi

step "Python environment"
run python3 -m venv "$DIR/.venv"
run "$DIR/.venv/bin/pip" install --quiet --upgrade pip
run "$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt"
say "Installed into $DIR/.venv"

step "Settings (.env)"
ENVF="$DIR/.env"
if [ -f "$ENVF" ]; then
  say ".env already exists; keeping it."
else
  if [ "$DRY" = 1 ]; then say "   [dry run] would create $ENVF with a random access code (mode 600)"; else
    TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    ( umask 077; sed "s|^LCARS_TOKEN=.*|LCARS_TOKEN=$TOKEN|" "$DIR/.env.example" > "$ENVF" )
    chmod 600 "$ENVF"; say "Created $ENVF"
  fi
fi
setenv() {   # setenv KEY VALUE: set or replace a line in .env
  [ "$DRY" = 1 ] && { say "   [dry run] .env: $1=$2"; return; }
  if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else printf '%s=%s\n' "$1" "$2" >> "$ENVF"; fi
}
[ -n "$PORT" ] && setenv PORT "$PORT"
[ -n "$HOST" ] && setenv HOST "$HOST"
[ "$DRY" = 1 ] || PORT="$(grep -m1 '^PORT=' "$ENVF" | cut -d= -f2)"
PORT="${PORT:-7842}"

if [ "$SERVICE" = 0 ]; then
  step "Finished (no service installed)"
  say "Start it with:  cd $DIR && .venv/bin/python run.py"
else
  step "Service ($MODE)"
  if [ "$MODE" = system ]; then
    AFTER="network.target user@$(id -u).service"; WANTED=multi-user.target
    RUNAS="User=$(id -un)"
  else
    AFTER="network.target"; WANTED=default.target; RUNAS="# runs as you (user service)"
  fi
  UNIT_TEXT="[Unit]
Description=LCARS (web console for herdr-core terminals)
After=$AFTER

[Service]
Type=simple
$RUNAS
WorkingDirectory=$DIR
Environment=HOME=$HOME
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u)
# make sure the core is up after a reboot; a no-op when it already runs
ExecStartPre=-$HC server start
ExecStart=$DIR/.venv/bin/python $DIR/run.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=$WANTED
"
  if [ "$DRY" = 1 ]; then
    say "   [dry run] would write $UNIT:"; printf '%s\n' "$UNIT_TEXT" | sed 's/^/        /'
  else
    mkdir -p "$UNIT_DIR"; printf '%s' "$UNIT_TEXT" > "$UNIT"; say "Wrote $UNIT"
  fi
  run "${SYSCTL[@]}" daemon-reload
  run "${SYSCTL[@]}" enable --now lcars.service
  if [ "$MODE" = user ]; then
    say "A user service only runs while you are logged in. To keep it running after you log out and across reboots:"
    say "    sudo loginctl enable-linger $(id -un)"
  fi
  if [ "$DRY" = 0 ]; then
    sleep 2
    if "${SYSCTL[@]}" is-active --quiet lcars.service; then say "LCARS is running."; else say "The service did not start. See why with:  ${SYSCTL[*]} status lcars.service   and   journalctl $([ "$MODE" = user ] && echo --user )-u lcars -n 50"; fi
  fi
fi

step "Next"
ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
LISTEN="${HOST:-$( [ -f "$ENVF" ] && grep -m1 '^HOST=' "$ENVF" | cut -d= -f2 )}"
if [ "$LISTEN" = 127.0.0.1 ] || [ "$LISTEN" = localhost ]; then
  say "LCARS only listens on this machine (127.0.0.1:$PORT). Point your reverse proxy at it, then open the proxy's address and create the first account."
else
  say "Open  http://${ADDR:-localhost}:$PORT  in a browser on the same network and create the first account."
fi
say "From outside the local network, the first visit needs a one-time setup code. Get it with:"
say "    cd $DIR && .venv/bin/python -m app.auth setup-code"
say "LCARS is a shell on this machine: keep it behind a login and a trusted network or HTTPS reverse proxy (see README.md)."
