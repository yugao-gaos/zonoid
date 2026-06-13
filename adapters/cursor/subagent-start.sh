#!/bin/bash
# subagentStart → POST /agent/start (maps Cursor payload fields).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib.sh"

INPUT=$(cat)
MAPPED=$(orch_to_subagent_start_json "$INPUT")
SID=$(printf '%s' "$MAPPED" | jq -r '.session_id // empty')
orch_session_off "$SID" && exit 0

AGENT_ID=$(printf '%s' "$MAPPED" | jq -r '.agent_id // empty')
[ -z "$AGENT_ID" ] && exit 0

AGENT_TYPE=$(printf '%s' "$MAPPED" | jq -r '.agent_type // "agent"')
TRANSCRIPT=$(printf '%s' "$MAPPED" | jq -r '.transcript_path // empty')
WS=$(orch_workspace "$INPUT")
TASK=$(printf '%s' "$INPUT" | jq -r '.task // empty')
SUBAGENT_SID=$(basename "$TRANSCRIPT" .jsonl 2>/dev/null)
[ "$SUBAGENT_SID" = "$TRANSCRIPT" ] && SUBAGENT_SID=""

PAYLOAD=$(jq -n   --arg agent_id "$AGENT_ID"   --arg agent_type "$AGENT_TYPE"   --arg transcript_path "$TRANSCRIPT"   --arg session "$SID"   --arg subagent_session "$SUBAGENT_SID"   --arg workspace "$WS"   --arg task "$TASK"   '{agent_id:$agent_id,agent_type:$agent_type,transcript_path:$transcript_path,session:$session,subagent_session:$subagent_session,workspace:$workspace,task:$task}')

orch_curl_post 0.5 "agent/start" "$PAYLOAD"
exit 0
