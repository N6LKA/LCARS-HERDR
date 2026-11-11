#!/bin/bash
# LCARS Permission Hook (PreToolUse)
# Intercepts Edit/Write/Bash tool uses from LCARS Claude subprocesses and
# forwards them to the LCARS web UI for user approval before proceeding.
#
# Only acts on LCARS subprocesses (LCARS_CONV_ID is set by claude_runner.py).
# Terminal sessions have no LCARS_CONV_ID and pass through untouched.

LCARS_PORT="${LCARS_PORT:-7842}"
LCARS_URL="http://localhost:${LCARS_PORT}"
CONV_ID="${LCARS_CONV_ID:-}"

INPUT=$(cat)

# Not a LCARS session — let normal permission flow handle it
if [ -z "${CONV_ID}" ]; then
  exit 0
fi

# POST the tool-use request to LCARS
RESPONSE=$(curl -s --max-time 5 -X POST "${LCARS_URL}/api/permission/request" \
  -H "Content-Type: application/json" \
  -d "{\"conv_id\":\"${CONV_ID}\",\"data\":${INPUT}}" 2>/dev/null)

REQ_ID=$(echo "${RESPONSE}" | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('req_id',''))" 2>/dev/null)

if [ -z "${REQ_ID}" ]; then
  # Can't reach LCARS — deny to be safe
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'
  exit 0
fi

# Poll for user decision (up to 120 seconds)
for i in $(seq 1 120); do
  POLL=$(curl -s --max-time 3 "${LCARS_URL}/api/permission/decision/${REQ_ID}" 2>/dev/null)
  STATUS=$(echo "${POLL}" | python3 -c \
    "import sys,json; print(json.load(sys.stdin).get('status','pending'))" 2>/dev/null)

  if [ "${STATUS}" = "allow" ] || [ "${STATUS}" = "deny" ]; then
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${STATUS}\"}}"
    exit 0
  fi

  sleep 1
done

# Timeout after 120 seconds — deny
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'
exit 0
