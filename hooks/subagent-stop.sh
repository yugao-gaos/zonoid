#!/bin/bash
# SubagentStop: mark the subagent done in the daemon. Non-blocking.
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/runtime-paths.sh
. "$HOOK_DIR/lib/runtime-paths.sh"
[ -f "$(orch_data_dir)/sessions/$SID.off" ] && exit 0  # gate: skip only if opted out (default on)
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty')
[ -z "$AGENT_ID" ] && exit 0
curl -s --max-time 0.5 -XPOST "localhost:$PORT/agent/done" -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AGENT_ID\"}" >/dev/null 2>&1
exit 0
