#!/usr/bin/env bash
# PostToolUse after subagent dispatch → GET /ready nudge (spawn / MCP lifecycle).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
case "$TOOL" in
  spawn_agents*|mcp__orchestrator-graph__complete_task|Agent|Task) ;;
  *) exit 0 ;;
esac
# post-agent.sh matcher is Agent|Task; reuse its ready-nudge logic when a dispatch completes.
printf '%s' "$INPUT" | bash "$ROOT/hooks/post-agent.sh" 2>/dev/null || true
exit 0
