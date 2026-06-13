#!/usr/bin/env bash
# Stop → mark worker done (POST /agent/done when agent_id is known). Codex requires JSON stdout.
set -euo pipefail
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty')
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
if [ -n "$SID" ] && [ -f "$DIR/$SID.off" ]; then
  # shellcheck source=adapters/codex/hooks/_lib.sh
  source "$(dirname "$0")/_lib.sh"
  codex_continue_json
  exit 0
fi

if [ -n "$AGENT_ID" ]; then
  curl -s --max-time 0.5 -XPOST "localhost:$PORT/agent/done" \
    -H 'content-type: application/json' \
    -d "{\"agent_id\":\"$AGENT_ID\"}" >/dev/null 2>&1 || true
fi

# shellcheck source=adapters/codex/hooks/_lib.sh
source "$(dirname "$0")/_lib.sh"
codex_continue_json
exit 0
