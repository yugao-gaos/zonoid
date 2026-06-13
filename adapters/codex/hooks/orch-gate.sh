#!/usr/bin/env bash
# PreToolUse(apply_patch|Write|Edit) → GET /active-claim gate; Codex permissionDecision deny.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=adapters/codex/hooks/_lib.sh
source "$(dirname "$0")/_lib.sh"
INPUT=$(cat)
relay_claude_gate "$ROOT/hooks/orch-gate.sh" "$INPUT"
exit 0
