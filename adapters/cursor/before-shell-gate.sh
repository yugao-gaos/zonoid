#!/bin/bash
# beforeShellExecution → bash write-pattern gate (native Cursor shell hook).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib.sh"
INPUT=$(cat)
orch_to_bash_gate_json "$INPUT" | exec bash "$ORCH_ROOT/hooks/orch-gate-bash.sh"
