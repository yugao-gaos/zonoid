#!/bin/bash
# postToolUse(TodoWrite|todo_write): mint file-drop stubs for Cursor todos → POST /sync.
# Mirrors Claude TaskCreate adoption (suggest-links quarantine nudge after sync).
# Payload shape is unconfirmed — best-effort parser; validate with scratch/cursor-hook-capture.sh.
set -euo pipefail

PORT="${ORCH_PORT:-8787}"
HARNESS="cursor"
INPUT=$(cat)

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // .conversation_id // empty')
if [ -n "$SID" ]; then
  OFF="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions/$SID.off"
  [ -f "$OFF" ] && exit 0
fi

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
case "$TOOL" in
  TodoWrite|todo_write) ;;
  *) exit 0 ;;
esac

WS=$(printf '%s' "$INPUT" | jq -r '.workspace_roots[0] // .cwd // empty')
[ -z "$WS" ] && WS="${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Windows/Cygwin: `pwd` yields a Cygwin path (/d/zonoid) that the native Windows `node` cannot
# require(). Convert to a node-friendly mixed path (D:/zonoid) when cygpath is present; no-op on POSIX.
REPO_ROOT_NODE="$REPO_ROOT"
if command -v cygpath >/dev/null 2>&1; then REPO_ROOT_NODE="$(cygpath -m "$REPO_ROOT")"; fi
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}"
STUB_DIR="$DATA/tasks/$(node -e "console.log(require('$REPO_ROOT_NODE/lib/filedrop-tasks').workspaceKey(process.argv[1]))" "$WS")/$HARNESS"
mkdir -p "$STUB_DIR"

AGENT=$(printf '%s' "$INPUT" | jq -r '.agent_id // .generation_id // empty')

# Best-effort: tool_input.todos, tool_input.parameters.todos, or parameters[] at top level.
TODOS_JSON=$(printf '%s' "$INPUT" | jq -c '
  (.tool_input.todos // .tool_input.parameters.todos // .parameters.todos // empty)
  | if type == "array" then . else empty end
')
[ -z "$TODOS_JSON" ] || [ "$TODOS_JSON" = "null" ] && exit 0

MINTED=()
while IFS= read -r row; do
  [ -z "$row" ] && continue
  ID=$(printf '%s' "$row" | jq -r '.id // empty')
  SUBJECT=$(printf '%s' "$row" | jq -r '.content // .subject // empty')
  [ -z "$ID" ] || [ -z "$SUBJECT" ] && continue

  RAW_STATUS=$(printf '%s' "$row" | jq -r '.status // "pending"')
  case "$RAW_STATUS" in
    pending|in_progress|completed) STATUS="$RAW_STATUS" ;;
    cancelled|canceled) STATUS="completed" ;;
    *) STATUS="pending" ;;
  esac

  STUB=$(jq -n \
    --arg id "$ID" \
    --arg subject "$SUBJECT" \
    --arg status "$STATUS" \
    --arg harness "$HARNESS" \
    --arg agent "$AGENT" \
    '{id:$id, subject:$subject, description:"", status:$status, blockedBy:[], created_by:{harness:$harness, agent_id:(if $agent=="" then null else $agent end)}}')

  FILE="$STUB_DIR/${ID}.json"
  TMP="${FILE}.$$.$RANDOM.tmp"
  printf '%s\n' "$STUB" > "$TMP"
  mv "$TMP" "$FILE"
  MINTED+=("$HARNESS/$ID")
done < <(printf '%s' "$TODOS_JSON" | jq -c '.[]')

[ ${#MINTED[@]} -eq 0 ] && exit 0

SYNC=$(curl -s --max-time 2 -X POST "localhost:$PORT/sync" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg ws "$WS" '{workspace:$ws}')" 2>/dev/null || echo '{}')

CTX_PARTS=()
for KEY in "${MINTED[@]}"; do
  QUAR=$(printf 'Task %s minted from Cursor todo — it is QUARANTINED as unwired. Wire it now: suggest_links + add_dependency (blocking for prerequisites, context for related done work), or mark_root if genuinely standalone. Unwired tasks cannot be claimed by start_task.' "$KEY")
  SUG=$(printf '%s' "$SYNC" | jq -r --arg k "$KEY" '.suggestions[$k] // empty')
  if [ -n "$SUG" ] && [ "$SUG" != "null" ] && printf '%s' "$SUG" | jq -e 'length > 0' >/dev/null 2>&1; then
    LINES=$(printf '%s' "$SUG" | jq -r '.[] | "  - \(.key) [\(.status)] \(.label) (score \(.score), suggest \(.suggest_kind))"' | head -5)
    CTX=$(printf '[Orchestrator] %s\nCandidate links among existing tasks (incl. completed):\n%s\nFor relevant DONE matches call add_dependency(from=<match>, to=%s, kind="context"); for a true prerequisite use kind="blocking". Skip unrelated ones.' "$QUAR" "$LINES" "$KEY")
  else
    CTX=$(printf '[Orchestrator] %s' "$QUAR")
  fi
  CTX_PARTS+=("$CTX")
done

COMBINED=$(printf '%s\n\n' "${CTX_PARTS[@]}" | sed '/^$/d')
printf '{"additional_context":%s}\n' "$(printf '%s' "$COMBINED" | jq -Rs .)"
exit 0
