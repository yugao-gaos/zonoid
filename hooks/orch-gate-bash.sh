#!/bin/bash
# PreToolUse(Bash) GATE: refuse Bash commands that write files unless THIS conversation has a task
# claimed in_progress in the orchestrator graph. Mirrors orch-gate.sh but works on Bash commands
# to close the bypass path (e.g. `python3 -c "open('file','w').write(...)"`, tee, cp, redirects).
# Exit 2 = deny; exit 0 = allow.
#
# Main/driving sessions: allowed up to 2 file-write commands per turn; blocked on 3rd+.
# Fail-open: if the daemon is unreachable we allow (exit 0).
PORT="${ORCH_PORT:-8787}"

# ── Env off-switch ─────────────────────────────────────────────────────────
# Harnesses that spawn claude processes (e.g. bench runner) can set ORCH_GATE_OFF=1
# in the child process environment to ungate those sessions entirely.
[ "${ORCH_GATE_OFF:-0}" = "1" ] && exit 0

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

# cp/mv/rsync/install/dd: detect write regardless of destination shape.
# DEFECT-2 FIX: the old pattern required /Users|/home|/root in the command, so
# `cp /tmp/x.js file.js` (relative dest) was never flagged. Now we flag ANY
# cp/mv/rsync/install/dd=.../sed -i invocation and let the allowlist decide exemption.
if printf '%s' "$CMD" | grep -qE '\b(cp|mv|rsync|install)\b' 2>/dev/null; then
  WRITE_PATTERN=1
fi
if printf '%s' "$CMD" | grep -qE '\bdd\b.*\bof=' 2>/dev/null; then
  WRITE_PATTERN=1
fi
if printf '%s' "$CMD" | grep -qE '\bsed\b.*-i' 2>/dev/null; then
  WRITE_PATTERN=1
fi

[ "$WRITE_PATTERN" = "0" ] && exit 0   # no write pattern detected -> allow

# ── Allowlist: check WRITE TARGET, not the whole command ──────────────────
# DEFECT-1 FIX: the old `case "$CMD" in */tmp/*` matched ANY command containing
# /tmp/ anywhere (e.g. `cp /tmp/evil.js /Users/x/main.js` was exempted because
# the SOURCE mentioned /tmp). We now extract the write target and check only it.
#
# For redirects: the token after > or >> is the target.
# For cp/mv/rsync/install: the LAST whitespace-separated token is the destination.
# For dd of=...: extract the of= value.
# For sed -i: in-place edit, target is the last non-option arg (approximate).
# For tee/python/ruby: these write arbitrary paths; we cannot cheaply extract targets,
# so we let them fall through to the claim check (correct behavior).

# Extract redirect target (last token after > or >>)
REDIR_TARGET=$(printf '%s' "$CMD" | grep -oE '(>>?)\s*\S+' | tail -1 | sed 's/^>*[[:space:]]*//')

# Extract cp/mv/rsync/install destination (last whitespace-separated token)
LAST_TOKEN=$(printf '%s' "$CMD" | tr -s ' \t' '\n' | grep -v '^-' | tail -1)

# Extract dd of= value
DD_DEST=$(printf '%s' "$CMD" | grep -oE '\bof=\S+' | sed 's/^of=//')

# Helper: is a given path under an exempt location?
is_exempt() {
  local p="$1"
  [ -z "$p" ] && return 1
  case "$p" in
    /tmp/*|/private/tmp/*)         return 0 ;;
    /dev/null|/dev/stderr|/dev/stdout) return 0 ;;
    */.claude/projects/*/memory/*) return 0 ;;
    */.claude/settings.json|*/.claude/settings.local.json) return 0 ;;
    */.claude/keybindings.json|*/.claude/launch.json) return 0 ;;
    */.mcp.json)                   return 0 ;;
    */CLAUDE.md)                   return 0 ;;
    *.log)                         return 0 ;;
    */logs/*)                      return 0 ;;
    */scratch/*)                   return 0 ;;
  esac
  return 1
}

# For redirect commands, check the redirect target
if printf '%s' "$CMD" | grep -qE '>>?\s*\S'; then
  if is_exempt "$REDIR_TARGET"; then
    exit 0
  fi
# For cp/mv/rsync/install, check the destination (last token)
elif printf '%s' "$CMD" | grep -qE '\b(cp|mv|rsync|install)\b'; then
  if is_exempt "$LAST_TOKEN"; then
    exit 0
  fi
# For dd of=, check the of= target
elif printf '%s' "$CMD" | grep -qE '\bdd\b.*\bof='; then
  if is_exempt "$DD_DEST"; then
    exit 0
  fi
fi
# tee, python writes, sed -i: fall through to claim check — we can't cheaply
# extract targets, and blocking is the safer side.

# ── Session claim check ────────────────────────────────────────────────────
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0                # no session id -> can't correlate; don't block

DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0       # orchestrator disabled for this conversation

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
  exit 0                               # claimed in_progress -> allow
fi

# No active claim. Check whether this is a subagent session or a main/driving session.
SINFO=$(curl -s --max-time 0.6 "localhost:$PORT/session-info?session=$SID" 2>/dev/null)
IS_SUB=$(printf '%s' "$SINFO" | jq -r '.is_subagent // "unknown"' 2>/dev/null)

if [ "$IS_SUB" = "true" ]; then
  # Registered subagent with no claim — must file a task first.
  echo "orch-gate: file a task (TaskCreate) and start_task before writing files via Bash" >&2
  exit 2
fi

# Main/driving session (or daemon lacks session-info endpoint — fail open toward main-session path).
# Allow up to 2 file-write commands per turn; block on 3rd+.
COUNTER_FILE="/tmp/orch-edit-count-$SID"
COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")

if [ "$COUNT" -ge 2 ]; then
  echo "orch-gate: Main session multi-file or large edit detected — dispatch a subagent (TaskCreate + Agent tool) for substantive work." >&2
  exit 2
fi

# Allow and increment counter
echo $((COUNT + 1)) > "$COUNTER_FILE"
exit 0
