#!/usr/bin/env bash
# PostToolUse hook: after start_task, register session→task_key with daemon
# so /active-claim can find cross-session claims (gate Fix B).
set -euo pipefail

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[[ "$TOOL" == "mcp__orchestrator-graph__start_task" ]] || exit 0

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
TASK_KEY=$(printf '%s' "$INPUT" | jq -r '.tool_input.task_key // empty')
PORT=${ORCH_PORT:-8787}

[[ -n "$SID" && -n "$TASK_KEY" ]] || exit 0

curl -s --max-time 1 -X POST "http://localhost:$PORT/overlay/claim-session" \
  -H "Content-Type: application/json" \
  -d "{\"task_key\": \"$TASK_KEY\", \"session_id\": \"$SID\"}" \
  > /dev/null 2>&1 || true

exit 0
