#!/usr/bin/env bash
# PostToolUse hook: after a successful claim, register the real hook session with daemon.
set -euo pipefail

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
REQUIRE_WORKSPACE=false
case "$TOOL" in
  mcp__orchestrator-graph__start_task|mcp__orchestrator_graph__start_task|start_task)
    ;;
  mcp__orchestrator-graph__subconscious_assignment|mcp__orchestrator_graph__subconscious_assignment|subconscious_assignment)
    REQUIRE_WORKSPACE=true
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
          (.text? | select(. != null) | collect)
        else empty end;
      [.tool_response | collect] as $items
      | if any($items[]; .isError? == true or .ok? == false or (.error? != null))
        then false
        else any($items[]; .ok? == true)
        end
    ' 2>/dev/null || printf 'false')
    [[ "$SUCCESS" == "true" ]] || exit 0
    ;;
  *) exit 0 ;;
esac

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
TASK_KEY=$(printf '%s' "$INPUT" | jq -r '.tool_input.task_key // empty')
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.tool_input.agent_id // empty')
INPUT_WORKSPACE=$(printf '%s' "$INPUT" | jq -r '.tool_input.graph_repo // .tool_input.workspace // empty')
RESPONSE_WORKSPACE=$(printf '%s' "$INPUT" | jq -r '
  def collect:
    if type == "string" then (try (fromjson | collect) catch empty)
    elif type == "array" then .[] | collect
    elif type == "object" then
      .,
      (.structuredContent? | select(. != null) | collect),
      (.result? | select(. != null) | collect),
      (.content? | select(. != null) | collect),
      (.text? | select(. != null) | collect)
    else empty end;
  [.tool_response | collect | .execution_permit?.workspace?
    | select(type == "string" and length > 0)] | first // empty
' 2>/dev/null || true)
if [[ "$REQUIRE_WORKSPACE" == "true" ]]; then
  WORKSPACE=$RESPONSE_WORKSPACE
else
  WORKSPACE=$INPUT_WORKSPACE
fi
PORT=${ORCH_PORT:-8787}

[[ -n "$SID" && -n "$TASK_KEY" && -n "$AGENT_ID" ]] || exit 0
[[ "$REQUIRE_WORKSPACE" != "true" || -n "$WORKSPACE" ]] || exit 0

if [[ -n "$WORKSPACE" ]]; then
  BODY=$(jq -nc --arg task_key "$TASK_KEY" --arg session_id "$SID" --arg agent_id "$AGENT_ID" \
    --arg workspace "$WORKSPACE" \
    '{task_key: $task_key, session_id: $session_id, agent_id: $agent_id, workspace: $workspace}')
else
  BODY=$(jq -nc --arg task_key "$TASK_KEY" --arg session_id "$SID" --arg agent_id "$AGENT_ID" \
    '{task_key: $task_key, session_id: $session_id, agent_id: $agent_id}')
fi

curl -s --max-time 1 -X POST "http://localhost:$PORT/overlay/claim-session" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  > /dev/null 2>&1 || true

exit 0
