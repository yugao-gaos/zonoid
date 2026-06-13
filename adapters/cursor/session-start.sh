#!/bin/bash
# sessionStart → boot daemon + POST /workspace (Cursor + third-party SessionStart).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib.sh"

INPUT=$(cat)
NORMALIZED=$(orch_normalize_json "$INPUT")
WS=$(orch_workspace "$NORMALIZED")
TX=$(printf '%s' "$NORMALIZED" | jq -r '.transcript_path // empty')
[ -z "$TX" ] && TX="${CURSOR_TRANSCRIPT_PATH:-}"

printf '%s' "$NORMALIZED" | jq --arg cwd "$WS" --arg tx "$TX"   '. + {cwd: (if .cwd != "" then .cwd else $cwd end), transcript_path: (if .transcript_path != "" then .transcript_path else $tx end)}'   | exec bash "$ORCH_ROOT/hooks/start-daemon.sh"
