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
# Agent-tool spawns (background agents) use .output paths, not .jsonl — session extraction is
# unreliable. Register with agent_tool_spawn:true; the daemon matches on agent_id instead.
PAYLOAD=$(jq -n \
  --arg agent_id "$AGENT_ID" \
  --arg agent_type "$AGENT_TYPE" \
  --arg transcript_path "$TRANSCRIPT" \
  --arg session "$SID" \
  '{agent_id:$agent_id,agent_type:$agent_type,transcript_path:$transcript_path,
    session:$session,parent_session_id:$session,agent_tool_spawn:true}')
curl -s --max-time 0.5 -XPOST "localhost:$PORT/agent/start" -H 'content-type: application/json' \
  -d "$PAYLOAD" >/dev/null 2>&1
exit 0
