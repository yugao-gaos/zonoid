#!/bin/bash
# Live validation helper for Cursor hook payloads (see docs/cursor-compat-spike.md §3).
#
# Wire temporarily in .cursor/hooks.json BEFORE post-todo-adopt.sh to capture real TodoWrite
# stdin while developing H2:
#
#   "postToolUse": [
#     { "command": "scratch/cursor-hook-capture.sh TodoWrite", "matcher": "TodoWrite|todo_write" },
#     { "command": "adapters/cursor/post-todo-adopt.sh", "matcher": "TodoWrite|todo_write", "timeout": 10 }
#   ]
#
# Or use matcher "*" and pass a label filter as $1 to log everything:
#   { "command": "scratch/cursor-hook-capture.sh all-tools", "matcher": "*" }
#
# Captures land in scratch/hook-captures/<UTC-ts>-<label>.jsonl (one JSON object per line).
# Inspect tool_name, tool_input.todos vs tool_input.parameters, and session fields
# (conversation_id vs session_id). Once confirmed, tighten post-todo-adopt.sh parser if needed.
#
# Usage: "command": "/absolute/path/to/scratch/cursor-hook-capture.sh TodoWrite"
LABEL="${1:-hook}"
DIR="${CURSOR_PROJECT_DIR:-$CLAUDE_PROJECT_DIR:-$PWD}/scratch/hook-captures"
mkdir -p "$DIR"
INPUT=$(cat)
TS=$(date -u +%Y%m%dT%H%M%SZ)
printf '%s\n' "$INPUT" >> "$DIR/${TS}-${LABEL}.jsonl"
exit 0
