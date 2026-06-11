#!/bin/bash
# PreToolUse(Bash) GATE: refuse Bash commands that write files unless THIS conversation has a task
# claimed in_progress in the orchestrator graph. Mirrors orch-gate.sh but works on Bash commands
# to close the bypass path (e.g. `python3 -c "open('file','w').write(...)"`, tee, cp, redirects).
# Exit 2 = deny; exit 0 = allow.
#
# Escape hatch: export ORCH_GATE_OFF=1 to always allow.
# Fail-open: if the daemon is unreachable we allow (exit 0).
PORT="${ORCH_PORT:-8787}"

[ "$ORCH_GATE_OFF" = "1" ] && exit 0   # escape hatch

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0                # no command -> nothing to check

# ── Write-pattern detection ────────────────────────────────────────────────
# We look for common file-write idioms. We match on the raw command string;
# false-positives are fine (just triggers the claim check), false-negatives
# let a write through (we fail-open rather than brick legitimate work).

WRITE_PATTERN=0

# Redirect to non-/tmp path: "> file" or ">> file" but not "> /tmp/..." or "> /dev/null"
# Exclude fd redirects like 2>&1 (digit or & after >) which are not file writes.
if printf '%s' "$CMD" | grep -qE '(>>?)\s*[^/\s&0-9]' 2>/dev/null; then
  WRITE_PATTERN=1
fi
if printf '%s' "$CMD" | grep -qE '(>>?)\s*/(?!(tmp|private/tmp|dev/null))' 2>/dev/null; then
  WRITE_PATTERN=1
fi

# tee (writes to a file)
if printf '%s' "$CMD" | grep -qE '\btee\b' 2>/dev/null; then
  WRITE_PATTERN=1
fi

# Python/ruby open(..., 'w'/'a'/'wb'/'ab') or f.write(
if printf '%s' "$CMD" | grep -qE "open\s*\(.*['\"]([wWaA]|[wWaA]b)['\"]|\.write\s*\(" 2>/dev/null; then
  WRITE_PATTERN=1
fi

# cp/mv to a non-/tmp path outside home /tmp
if printf '%s' "$CMD" | grep -qE '\b(cp|mv)\b.*(/Users|/home|/root)' 2>/dev/null; then
  WRITE_PATTERN=1
fi

# chmod/chown don't write content but also shouldn't bypass the gate
# (left out intentionally — too noisy, low risk)

[ "$WRITE_PATTERN" = "0" ] && exit 0   # no write pattern detected -> allow

# ── Allowlist: paths that are always exempt ────────────────────────────────
# If the command only touches allowed paths, let it through.
case "$CMD" in
  */tmp/*|*/private/tmp/*)             exit 0 ;;
  *memory/*|*/MEMORY.md*)              exit 0 ;;
  *settings.json*|*settings.local.json*) exit 0 ;;
  */CLAUDE.md*)                        exit 0 ;;
  */keybindings.json*)                 exit 0 ;;
  */.mcp.json*)                        exit 0 ;;
  *.log|*/logs/*)                      exit 0 ;;  # log writes are not substantive work
esac

# ── Session claim check ────────────────────────────────────────────────────
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0                # no session id -> can't correlate; don't block

DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0       # orchestrator disabled for this conversation

RESP=$(curl -s --max-time 0.6 "localhost:$PORT/active-claim?session=$SID" 2>/dev/null)
[ -z "$RESP" ] && exit 0               # daemon unreachable -> fail open

if printf '%s' "$RESP" | jq -e '.claimed == true' >/dev/null 2>&1; then
  # Check if the claimed task has a metric spec (self-learning mode)
  TASK_KEY=$(printf '%s' "$RESP" | jq -r '.task_key // empty')
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
  exit 0                               # claimed in_progress -> allow
fi

echo "orch-gate: file a task (TaskCreate) and start_task before writing files via Bash; set ORCH_GATE_OFF=1 to bypass" >&2
exit 2
