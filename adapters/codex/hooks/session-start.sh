#!/usr/bin/env bash
# SessionStart → boot daemon + POST /workspace (delegates to Claude reference hook).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  AUGMENTED=$(printf '%s' "$INPUT" | jq -c '. + {harness:"codex"}' 2>/dev/null || printf '%s' "$INPUT")
  printf '%s' "$AUGMENTED" | bash "$ROOT/hooks/start-daemon.sh"
else
  printf '%s' "$INPUT" | bash "$ROOT/hooks/start-daemon.sh"
fi
