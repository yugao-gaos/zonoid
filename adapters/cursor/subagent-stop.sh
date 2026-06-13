#!/bin/bash
# subagentStop → POST /agent/done (maps Cursor payload fields).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

INPUT=$(cat)
MAPPED=$(orch_to_subagent_stop_json "$INPUT")
SID=$(printf '%s' "$MAPPED" | jq -r '.session_id // empty')
orch_session_off "$SID" && exit 0

AGENT_ID=$(printf '%s' "$MAPPED" | jq -r '.agent_id // empty')
# Cursor subagentStop may omit subagent_id; derive from transcript path when present.
if [ -z "$AGENT_ID" ]; then
  TX=$(printf '%s' "$INPUT" | jq -r '.agent_transcript_path // empty')
  [ -n "$TX" ] && AGENT_ID=$(basename "$TX" .jsonl)
  [ "$AGENT_ID" = "$TX" ] && AGENT_ID=""
fi
[ -z "$AGENT_ID" ] && exit 0

WS=$(orch_workspace "$INPUT")
PAYLOAD=$(jq -n --arg agent_id "$AGENT_ID" --arg workspace "$WS" \
  '{agent_id:$agent_id,workspace:$workspace}')
orch_curl_post 0.5 "agent/done" "$PAYLOAD"
exit 0
