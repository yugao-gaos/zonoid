#!/bin/bash
# preToolUse(Shell) → normalize Cursor payload, then delegate to the shared bash write gate.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib.sh"
INPUT=$(cat)
orch_to_bash_gate_json "$INPUT" | exec bash "$ORCH_ROOT/hooks/orch-gate-bash.sh"
