#!/usr/bin/env bash
# PostToolUse hook: after a successful claim, register the real hook session with daemon.
set -euo pipefail

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
case "$TOOL" in
  mcp__orchestrator-graph__start_task|mcp__orchestrator_graph__start_task|start_task)
    ;;
  mcp__orchestrator-graph__subconscious_assignment|mcp__orchestrator_graph__subconscious_assignment|subconscious_assignment)
    ACTION=$(printf '%s' "$INPUT" | jq -r '.tool_input.action // empty')
    [[ "$ACTION" == "accept" ]] || exit 0
    SUCCESS=$(printf '%s' "$INPUT" | jq -r '
      def collect:
        if type == "string" then (try (fromjson | collect) catch empty)
        elif type == "array" then .[] | collect
        elif type == "object" then
          .,
          (.structuredContent? | select(. != null) | collect),
          (.result? | select(. != null) | collect),
          (.content? | select(. != null) | collect),
          (.text? | select(. != null) | collect),
          (.git_claim? | select(. != null) | collect),
          (.git_claim_finalize? | select(. != null) | collect)
        else empty end;
      [.tool_response | collect] as $items
      | def advisory_git_claim:
          .advisory? == true and .ok? == false
          and (has("already_claimed") or has("pushed") or has("conflict") or has("skipped"));
        if any($items[]; (.isError? == true or .ok? == false or (.error? != null)) and (advisory_git_claim | not))
        then false
        else any($items[]; .ok? == true)
        end
    ' 2>/dev/null || printf 'false')
    [[ "$SUCCESS" == "true" ]] || exit 0
    ;;
  *) exit 0 ;;
esac

HOOKKIT="$(cd "$(dirname "$0")" && pwd)/lib/hookkit.js"
SID=$(printf '%s' "$INPUT" | node -e '
  const k = require(process.argv[1]);
  k.readInput().then((input) => process.stdout.write(k.hookSessionId(input)));
' "$HOOKKIT" 2>/dev/null || true)
TASK_KEY=$(printf '%s' "$INPUT" | jq -r '.tool_input.task_key // empty')
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.agent_id // empty')
RESPONSE_PERMIT=$(printf '%s' "$INPUT" | jq -c --arg task_key "$TASK_KEY" --arg agent_id "$AGENT_ID" '
  def collect:
    if type == "string" then (try (fromjson | collect) catch empty)
    elif type == "array" then .[] | collect
    elif type == "object" then
      .,
      (.structuredContent? | select(. != null) | collect),
      (.result? | select(. != null) | collect),
      (.content? | select(. != null) | collect),
      (.text? | select(. != null) | collect),
      (.git_claim? | select(. != null) | collect),
      (.git_claim_finalize? | select(. != null) | collect)
    else empty end;
  [.tool_response | collect | .execution_permit?
    | select(type == "object")
    | select((.workspace? | type) == "string" and (.workspace | length) > 0)
    | select((.session_id? | type) == "string" and (.session_id | length) > 0)
    | select(.task_key? == $task_key and .agent_id? == $agent_id)] | first // empty
' 2>/dev/null || true)
RESPONSE_WORKSPACE=$(printf '%s' "$RESPONSE_PERMIT" | jq -r '.workspace // empty' 2>/dev/null || true)
EXPECTED_SESSION_ID=$(printf '%s' "$RESPONSE_PERMIT" | jq -r '.session_id // empty' 2>/dev/null || true)
REQUESTED_SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.session_id // empty')
PORT=${ORCH_PORT:-8787}

[[ -n "$SID" && -n "$TASK_KEY" && -n "$AGENT_ID" ]] || exit 0
[[ -n "$RESPONSE_WORKSPACE" && -n "$EXPECTED_SESSION_ID" ]] || exit 0
if [[ "$SID" != "$EXPECTED_SESSION_ID" && "$REQUESTED_SESSION_ID" == "$EXPECTED_SESSION_ID" ]]; then
  exit 0
fi

BODY=$(jq -nc --arg task_key "$TASK_KEY" --arg session_id "$SID" --arg agent_id "$AGENT_ID" \
  --arg workspace "$RESPONSE_WORKSPACE" --arg expected_session_id "$EXPECTED_SESSION_ID" \
  '{task_key: $task_key, session_id: $session_id, agent_id: $agent_id, workspace: $workspace, expected_session_id: $expected_session_id}')

curl -s --max-time 1 -X POST "http://localhost:$PORT/overlay/claim-session" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  > /dev/null 2>&1 || true

exit 0
