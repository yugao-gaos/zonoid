#!/bin/bash
# SubagentStart: register the subagent with the daemon for observability. Non-blocking.
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -f "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions/$SID.off" ] && exit 0  # gate: skip only if conversation opted out (default on)
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // "agent"')
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')
[ -z "$AGENT_ID" ] && exit 0
curl -s --max-time 0.5 -XPOST "localhost:$PORT/agent/start" -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AGENT_ID\",\"agent_type\":\"$AGENT_TYPE\",\"transcript_path\":\"$TRANSCRIPT\",\"session\":\"$SID\"}" >/dev/null 2>&1
exit 0
