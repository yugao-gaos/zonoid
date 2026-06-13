#!/bin/bash
# preToolUse(*) → cooperative stop gate (exit 2 deny, mirrors orch-stop.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib.sh"
INPUT=$(cat)
orch_normalize_json "$INPUT" | exec bash "$ORCH_ROOT/hooks/orch-stop.sh"
