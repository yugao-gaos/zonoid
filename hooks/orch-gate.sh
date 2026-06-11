#!/bin/bash
# PreToolUse(Write|Edit) GATE: enforce task-claim discipline for substantive inline edits.
#
# Subagents (spawned via the Agent tool): must have a valid active claim — same as before.
# Main/driving sessions: allowed up to 2 single-file edits per turn (reset by classify.sh);
#   blocked on 3rd+ edit OR if the new_string/content exceeds 100 lines (large inline work).
#   Both cases print a message guiding the user to dispatch a subagent.
#
# Default-on: like the other orchestrator hooks, the gate is active by default. A conversation
#   opts out with 'orch off' (drops sessions/<id>.off). If that marker is present, exit 0.
# Fail-open: if the daemon is unreachable we allow (exit 0) rather than bricking edits when the
#   daemon is down. We deny only on a definitive "no claim for this session".
PORT="${ORCH_PORT:-8787}"

INPUT=$(cat)

# Path allowlist: harness plumbing that is NOT "substantive multi-step work" and must never be
# gated (memory writes, config edits, scratch). Orchestrator SOURCE (~/.claude/orchestrator/**)
# is deliberately NOT exempted -- that's the substantive work the gate exists to route.
FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
case "$FP" in
  */.claude/projects/*/memory/*)         exit 0 ;;  # auto-memory store (incl. MEMORY.md)
  */.claude/settings.json|*/.claude/settings.local.json) exit 0 ;;  # harness settings
  */.claude/keybindings.json|*/.claude/launch.json)      exit 0 ;;  # harness config
  */.mcp.json)                           exit 0 ;;  # MCP server config
  */CLAUDE.md)                           exit 0 ;;  # instruction file
  /tmp/*|/private/tmp/*)                 exit 0 ;;  # scratch / task output
  */.claude/orchestrator/*)              ;;         # orchestrator source: never exempt, fall through to claim check
  */scratch/*)                           exit 0 ;;  # workspace scratch dir
  *.log|*/logs/*)                        exit 0 ;;  # log writes are not substantive work
esac

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0                # no session id -> can't correlate; don't block
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0       # skip only when orchestrator is disabled for this conversation (default on)

RESP=$(curl -s --max-time 0.6 "localhost:$PORT/active-claim?session=$SID" 2>/dev/null)
[ -z "$RESP" ] && exit 0               # daemon unreachable -> fail open

if printf '%s' "$RESP" | jq -e '.claimed == true' >/dev/null 2>&1; then
  # Check if the claimed task has a metric spec (self-learning mode)
  TASK_KEY=$(printf '%s' "$RESP" | jq -r '.claims[0].key // empty')
  if [ -n "$TASK_KEY" ]; then
    DETAIL=$(curl -s --max-time 0.6 "localhost:$PORT/task/detail?key=$TASK_KEY" 2>/dev/null)
    HAS_METRIC=$(printf '%s' "$DETAIL" | jq -e '.task.metric != null' >/dev/null 2>&1 && echo "yes" || echo "no")
    if [ "$HAS_METRIC" = "yes" ]; then
      BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
      case "$BRANCH" in
        orch/attempt/*) ;;  # correct branch -> allow
        *)
          echo "self-learning mode: task has a metric spec — call branch_task first before editing" >&2
          exit 2
          ;;
      esac
    fi
  fi
  exit 0                               # an in_progress task is claimed for this session -> allow
fi

# No active claim. Check whether this is a subagent session or a main/driving session.
SINFO=$(curl -s --max-time 0.6 "localhost:$PORT/session-info?session=$SID" 2>/dev/null)
IS_SUB=$(printf '%s' "$SINFO" | jq -r '.is_subagent // "unknown"' 2>/dev/null)

if [ "$IS_SUB" = "true" ]; then
  # Registered subagent with no claim — must file a task first.
  echo "orch-gate: file a task (TaskCreate) and start_task before editing" >&2
  exit 2
fi

# Main/driving session (or daemon lacks session-info endpoint — fail open toward main-session path).
# Allow up to 2 edits per turn; block large content (>100 lines).
COUNTER_FILE="/tmp/orch-edit-count-$SID"
COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")

# Extract content size: new_string (Edit) or content (Write)
CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // .tool_input.content // empty' 2>/dev/null)
LINE_COUNT=$(printf '%s' "$CONTENT" | wc -l | tr -d ' ')

if [ "$COUNT" -ge 2 ] || [ "${LINE_COUNT:-0}" -gt 100 ]; then
  echo "orch-gate: Main session multi-file or large edit detected — dispatch a subagent (TaskCreate + Agent tool) for substantive work." >&2
  exit 2
fi

# Allow and increment counter
echo $((COUNT + 1)) > "$COUNTER_FILE"
exit 0
