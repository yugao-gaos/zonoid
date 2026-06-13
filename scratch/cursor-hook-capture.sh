#!/bin/bash
# Manual spike helper: wire as a Cursor/Claude hook command to log stdin payloads.
# Usage in hooks.json: "command": "/path/to/scratch/cursor-hook-capture.sh TodoWrite"
LABEL="${1:-hook}"
DIR="${CURSOR_PROJECT_DIR:-$CLAUDE_PROJECT_DIR:-$PWD}/scratch/hook-captures"
mkdir -p "$DIR"
INPUT=$(cat)
TS=$(date -u +%Y%m%dT%H%M%SZ)
printf '%s\n' "$INPUT" >> "$DIR/${TS}-${LABEL}.jsonl"
exit 0
