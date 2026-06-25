#!/usr/bin/env bash
# SubagentStop → POST /agent/done. Codex requires JSON stdout on success.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=adapters/codex/hooks/_lib.sh
source "$(dirname "$0")/_lib.sh"
INPUT=$(cat)
printf '%s' "$INPUT" | bash "$ROOT/hooks/subagent-stop.sh" >/dev/null 2>&1 || true
codex_continue_json
exit 0
