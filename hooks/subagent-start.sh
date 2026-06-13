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
# Extract the subagent's own session ID from its transcript path (e.g. /path/<session_id>.jsonl)
SUBAGENT_SID=$(basename "$TRANSCRIPT" .jsonl 2>/dev/null)
[ "$SUBAGENT_SID" = "$TRANSCRIPT" ] && SUBAGENT_SID=""  # basename unchanged = no extension stripped = not a .jsonl path
[ -n "$SUBAGENT_SID" ] && [ "$SUBAGENT_SID" = "$SID" ] && SUBAGENT_SID=""
PAYLOAD=$(jq -n \
  --arg agent_id "$AGENT_ID" \
  --arg agent_type "$AGENT_TYPE" \
  --arg transcript_path "$TRANSCRIPT" \
  --arg session "$SID" \
  --arg subagent_session "$SUBAGENT_SID" \
  '{agent_id:$agent_id,agent_type:$agent_type,transcript_path:$transcript_path,session:$session}
   + (if ($subagent_session|length) > 0 then {subagent_session:$subagent_session} else {} end)')
curl -s --max-time 0.5 -XPOST "localhost:$PORT/agent/start" -H 'content-type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1
exit 0
