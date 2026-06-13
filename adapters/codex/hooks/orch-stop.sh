#!/usr/bin/env bash
# PreToolUse(*) cooperative stop → GET /should-stop; deny via permissionDecision only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=adapters/codex/hooks/_lib.sh
source "$(dirname "$0")/_lib.sh"
INPUT=$(cat)
relay_claude_gate "$ROOT/hooks/orch-stop.sh" "$INPUT"
exit 0
