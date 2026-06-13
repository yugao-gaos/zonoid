#!/usr/bin/env bash
# PostToolUse(mcp start_task) → POST /overlay/claim-session for cross-session gate lookup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
case "$TOOL" in
  mcp__orchestrator-graph__start_task|start_task) ;;
  *) exit 0 ;;
esac
printf '%s' "$INPUT" | bash "$ROOT/hooks/orch-posttool-starttask.sh" >/dev/null 2>&1 || true
exit 0
