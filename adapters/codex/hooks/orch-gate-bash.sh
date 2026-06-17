#!/usr/bin/env bash
# PreToolUse(Bash) → shared bash write gate; Codex permissionDecision deny.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=adapters/codex/hooks/_lib.sh
source "$(dirname "$0")/_lib.sh"
INPUT=$(cat)
relay_claude_gate "$ROOT/hooks/orch-gate-bash.sh" "$INPUT"
exit 0
