#!/bin/bash
# PreToolUse(*) ENFORCED COOPERATIVE-STOP gate: if THIS conversation's claimed task has a
# cancel_requested flag, OR its assigned agent has a stop_requested flag, deny the tool call so
# the worker halts and reports instead of grinding on after a human cancel/stop. This is the
# enforcement half of the cooperative-stop primitives (cancel_requested[key]/stop_requested[agent]);
# it turns the advisory flags into an actual halt. Exit 2 = deny; exit 0 = allow.
#
# Mirrors orch-gate.sh's wiring/escapes:
#   - ORCH_GATE_OFF=1            -> always allow (escape hatch)
#   - sessions/<id>.off present  -> orchestrator disabled for this conversation -> allow
#   - daemon unreachable / empty -> fail open (don't brick a worker when the daemon is down)
PORT="${ORCH_PORT:-8787}"

[ "$ORCH_GATE_OFF" = "1" ] && exit 0   # escape hatch

INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0                # no session id -> can't correlate; don't block
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0       # orchestrator disabled for this conversation

# agent_id is present only when this tool call fires inside a SUBAGENT's context; absent for the
# main/driver thread. Forward it so the daemon halts ONLY the worker a stop targets — not the driver
# that requested the stop (which shares this session_id and would otherwise self-block).
AGENT=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty')
URL="localhost:$PORT/should-stop?session=$SID"
[ -n "$AGENT" ] && URL="$URL&agent=$AGENT"
RESP=$(curl -s --max-time 0.6 "$URL" 2>/dev/null)
[ -z "$RESP" ] && exit 0               # daemon unreachable -> fail open

if printf '%s' "$RESP" | jq -e '.stop == true' >/dev/null 2>&1; then
  echo "STOP: cancellation/stop requested — halt and report" >&2
  exit 2
fi
exit 0
