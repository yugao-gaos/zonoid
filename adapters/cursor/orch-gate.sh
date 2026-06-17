#!/bin/bash
# preToolUse(Write) → normalize Cursor payload, then delegate to the shared write gate.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib.sh"
INPUT=$(cat)
orch_normalize_json "$INPUT" | exec bash "$ORCH_ROOT/hooks/orch-gate.sh"
