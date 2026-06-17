#!/bin/bash
# PreToolUse(Bash) GATE: refuse Bash commands that write files unless THIS conversation has a task
# claimed in_progress in the orchestrator graph. Mirrors orch-gate.sh but works on Bash commands
# to close the bypass path (e.g. `python3 -c "open('file','w').write(...)"`, tee, cp, redirects).
# Exit 2 = deny; exit 0 = allow.
#
# Subagents: zero-tolerance — require a valid active claim before any non-exempt Bash file-write.
# Main/dispatcher sessions: claim, dispatch a subagent, or use 1 trivial write/turn (command
# <=20 lines, <=800 chars) while /dispatcher/children reports at least one running worker.
# Fail-open: if the daemon is unreachable we allow (exit 0).
PORT="${ORCH_PORT:-8787}"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=orch-gate-trivial.sh
. "$HOOK_DIR/orch-gate-trivial.sh"

# ── Env off-switch ─────────────────────────────────────────────────────────
# Harnesses that spawn claude processes (e.g. bench runner) can set ORCH_GATE_OFF=1
# in the child process environment to ungate those sessions entirely.
[ "${ORCH_GATE_OFF:-0}" = "1" ] && exit 0

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0                # no command -> nothing to check

# ── Git VCS exemption ──────────────────────────────────────────────────────
# Git plumbing (commit/merge/add/push/...) operates on already-claimed, already-edited work —
# it is NOT "substantive source editing", which is what this gate exists to route. Exempt it so
# workers can commit in their worktrees and the dispatcher can merge, AND so the write-pattern
# detector below doesn't false-positive on '>' chars in commit messages or `git apply` heredocs
# (->, =>, >=). NOT exempt: checkout/restore/reset/clean/rm/stash — those overwrite working-tree
# source, which the gate should still guard.
if printf '%s' "$CMD" | grep -qE '(^|[;&|]|&&|\|\|)[[:space:]]*git[[:space:]]+(-C[[:space:]]+\S+[[:space:]]+)?(commit|merge|add|push|pull|fetch|branch|tag|worktree|rebase|cherry-pick|log|status|diff|show|rev-parse|describe|remote)\b' 2>/dev/null \
   && ! printf '%s' "$CMD" | grep -qE '\bgit[[:space:]]+(-C[[:space:]]+\S+[[:space:]]+)?(checkout|restore|reset|clean|rm|stash)\b' 2>/dev/null; then
  exit 0
fi

# ── Local daemon exemption ─────────────────────────────────────────────────
# curl/wget to the local orchestrator daemon are HTTP calls, not file writes.
# Edge signatures contain '>>' as a separator which false-positives the write
# detector below. Exempt any curl targeting localhost on the orchestrator port.
if printf '%s' "$CMD" | grep -qE '\b(curl|wget)\b.*localhost:'"${PORT}"'(/|$)' 2>/dev/null || \
   printf '%s' "$CMD" | grep -qE '\b(curl|wget)\b.*127\.0\.0\.1:'"${PORT}"'(/|$)' 2>/dev/null; then
  exit 0
fi

# ── Write-pattern detection ────────────────────────────────────────────────
# We look for common file-write idioms. We match on the raw command string;
# false-positives are fine (just triggers the claim check), false-negatives
# let a write through (we fail-open rather than brick legitimate work).

WRITE_PATTERN=0

# Mask quoted spans so literal redirect chars (> <) inside quoted args
# don't false-positive as redirects (e.g. find -name '*[<>]*'). Placeholder
# 'Q' (not deletion) keeps a real `> "file"` redirect detectable.
CMD_REDIR=$(printf '%s' "$CMD" | sed "s/'[^']*'/Q/g; s/\"[^\"]*\"/Q/g")

# Redirect (excluding /dev/null):
# Exclude fd redirects like 2>&1 (digit or & after >) and closing angle brackets in
# strings like "<email@host.com>" where > is immediately preceded by a word/email char.
if printf '%s' "$CMD_REDIR" | grep -qE '(^|[^[:alnum:]._@-])(>>?)\s*[^/\s&0-9]' 2>/dev/null; then
  WRITE_PATTERN=1
fi
if printf '%s' "$CMD_REDIR" | grep -qE '(>>?)\s*/(?!(dev/null))' 2>/dev/null; then
  WRITE_PATTERN=1
fi

# tee (writes to a file)
if printf '%s' "$CMD" | grep -qE '\btee\b' 2>/dev/null; then
  WRITE_PATTERN=1
fi

# Python/ruby open(..., 'w'/'a'/'wb'/'ab'), f.write(, or pathlib Path.write_text/write_bytes
if printf '%s' "$CMD" | grep -qE "open\s*\(.*['\"]([wWaA]|[wWaA]b)['\"]|\.write(_text|_bytes)?\s*\(|\.touch\s*\(" 2>/dev/null; then
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

# Helper: normalize path — collapse ../ segments
normalize_path() {
  local p="$1"
  while printf '%s' "$p" | grep -qE '/[^/]+/\.\./'; do
    p=$(printf '%s' "$p" | sed 's|/[^/]*/\.\./|/|g')
  done
  p=$(printf '%s' "$p" | sed 's|/[^/]*/\.\.$||')
  printf '%s' "$p"
}

resolve_target_against_wt() {
  local t="$1" wt="$2" rt
  case "$t" in
    /*|[A-Za-z]:/*) rt="$t" ;;
    *) rt="${wt%/}/$t" ;;
  esac
  normalize_path "$rt"
}

# Helper: is a given path under an exempt location?
is_exempt() {
  local p
  p=$(normalize_path "$1")
  [ -z "$p" ] && return 1
  case "$p" in
    /dev/null|/dev/stderr|/dev/stdout)                 return 0 ;;
    */.claude/projects/*/memory/*)                     return 0 ;;
    */.claude/settings.json|*/.claude/settings.local.json) return 0 ;;
    */.claude/keybindings.json|*/.claude/launch.json)  return 0 ;;
    */.mcp.json)                                       return 0 ;;
    */CLAUDE.md)                                       return 0 ;;
    */logs/*.log)                                      return 0 ;;
    */scratch/*)                                       return 0 ;;
    */.claude/orchestrator/tasks/*)                  return 0 ;;
    */.claude/tasks/*)                                 return 0 ;;
  esac
  return 1
}

# Strip bash comments to avoid comment tokens being treated as targets
CMD_NOCOMMENT=$(printf '%s' "$CMD" | sed 's/ #.*//' | sed 's/	#.*//')

# Collect ALL write targets
TARGETS=""

# All redirect targets
while IFS= read -r t; do
  [ -n "$t" ] && TARGETS="${TARGETS}${t}
"
done < <(printf '%s' "$CMD_NOCOMMENT" | grep -oE '(>>?)\s*\S+' | sed 's/^>*[[:space:]]*//')

# cp/mv/rsync/install: last non-flag token (comment-stripped)
if printf '%s' "$CMD_NOCOMMENT" | grep -qE '\b(cp|mv|rsync|install)\b'; then
  LAST_TOKEN=$(printf '%s' "$CMD_NOCOMMENT" | tr -s ' \t' '\n' | grep -v '^-' | tail -1)
  [ -n "$LAST_TOKEN" ] && TARGETS="${TARGETS}${LAST_TOKEN}
"
fi

# dd of= target
DD_DEST=$(printf '%s' "$CMD_NOCOMMENT" | grep -oE '\bof=\S+' | sed 's/^of=//')
[ -n "$DD_DEST" ] && TARGETS="${TARGETS}${DD_DEST}
"

# Only exit 0 if targets found AND every one is exempt
if [ -n "$TARGETS" ]; then
  all_exempt=1
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    if ! is_exempt "$t"; then
      all_exempt=0
      break
    fi
  done <<EOF
$TARGETS
EOF
  [ "$all_exempt" = "1" ] && exit 0
fi
# tee, python writes, sed -i, or any non-exempt target: fall through to claim check.

# ── Session claim check ────────────────────────────────────────────────────
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0                # no session id -> can't correlate; don't block

DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0       # orchestrator disabled for this conversation

RESP=$(curl -s --max-time 0.6 "localhost:$PORT/active-claim?session=$SID" 2>/dev/null)
[ -z "$RESP" ] && exit 0               # daemon unreachable -> fail open

if printf '%s' "$RESP" | jq -e '.claimed == true' >/dev/null 2>&1; then
  # Check if any claimed task has a registered worktree that covers the target file path.
  # With multiple active claims a session may legitimately write to different worktrees;
  # we must iterate ALL claims and allow if ANY claim's worktree is an ancestor of the target.
  CLAIM_COUNT=$(printf '%s' "$RESP" | jq -r '.claims | length' 2>/dev/null)
  CLAIM_COUNT="${CLAIM_COUNT:-0}"
  ANY_WORKTREE=0   # did we find at least one claim with a registered worktree?
  MATCHED=0        # did any target fall inside one of those worktrees?
  MISMATCH_BRANCH=""
  i=0
  while [ "$i" -lt "$CLAIM_COUNT" ]; do
    TASK_KEY=$(printf '%s' "$RESP" | jq -r ".claims[$i].key // empty" 2>/dev/null)
    if [ -n "$TASK_KEY" ]; then
      DETAIL=$(curl -s --max-time 0.6 "localhost:$PORT/task/detail?key=$TASK_KEY" 2>/dev/null)
      TASK_BRANCH=$(printf '%s' "$DETAIL" | jq -r '.task.git.branch // empty' 2>/dev/null)
      TASK_WT=$(printf '%s' "$DETAIL" | jq -r '.task.git.worktree // empty' 2>/dev/null)
      if [ -n "$TASK_BRANCH" ]; then
        ANY_WORKTREE=1
        MISMATCH_BRANCH="$TASK_BRANCH"
        # Allow if target is inside this claim's worktree, or if TARGETS is empty.
        # Guard on non-empty TASK_WT: an empty worktree (e.g. malformed daemon JSON) would make the
        # prefix glob "$TASK_WT"/* degrade to /* and falsely match ANY absolute path — silently
        # allowing out-of-worktree writes. Empty worktree → no match → fall through to block.
        _MATCH_FOUND=0
        if [ -n "$TASK_WT" ]; then
          while IFS= read -r _t; do
            [ -z "$_t" ] && continue
            _rt=$(resolve_target_against_wt "$_t" "$TASK_WT")
            case "$_rt" in "$TASK_WT"/*|"$TASK_WT") _MATCH_FOUND=1; break ;; esac
          done <<TARGETEOF
$TARGETS
TARGETEOF
        fi
        if [ "$_MATCH_FOUND" = "1" ] || [ -z "$TARGETS" ]; then
          MATCHED=1
          break
        fi
      fi
    fi
    i=$((i + 1))
  done
  if [ "$ANY_WORKTREE" = "1" ] && [ "$MATCHED" = "0" ]; then
    printf 'orch-gate: task has a registered worktree (%s) — Bash file writes must happen inside the worktree path, not at %s. Use the path returned by branch_task.\n' "$MISMATCH_BRANCH" "$(printf '%s' "$TARGETS" | sed '/^$/d' | head -1)" >&2
    exit 2
  fi
  exit 0                               # claimed in_progress -> allow
fi

# No active claim. Check whether this is a subagent session or a main/driving session.
SINFO=$(curl -s --max-time 0.6 "localhost:$PORT/session-info?session=$SID" 2>/dev/null)
IS_SUB=$(printf '%s' "$SINFO" | jq -r '.is_subagent // "unknown"' 2>/dev/null)

if [ "$IS_SUB" = "true" ]; then
  # Registered subagent with no claim — must file a task first.
  printf 'orch-gate: no task claimed. Worker subagents must call branch_task then start_task before editing. To create new tasks use Claude TaskCreate or an adapter file-drop create_task/task_create tool.\n' >&2
  exit 2
fi

# Main/driving session (or unknown session-info): try 1 trivial write/turn if workers in flight.
if try_trivial_main_allow "$SID" "$CMD"; then
  bash_chars=$(printf '%s' "$CMD" | wc -c | tr -d ' ')
  bash_file=$(printf '%s' "$TARGETS" | sed '/^$/d' | head -1)
  [ -z "$bash_file" ] && bash_file="(bash)"
  report_dispatcher_edit "$SID" "$bash_chars" "$bash_file"
  exit 0
fi
main_session_deny_message >&2
exit 2
