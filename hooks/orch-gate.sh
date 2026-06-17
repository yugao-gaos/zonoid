#!/bin/bash
# PreToolUse(Write|Edit) GATE: enforce task-claim discipline for substantive inline edits.
#
# Subagents: zero-tolerance — require a valid active claim before any non-exempt Write/Edit.
# Main/dispatcher sessions: claim, dispatch a subagent, or use 1 trivial patch/turn (<=20 lines,
# <=800 chars) while /dispatcher/children reports at least one running worker.
# Subagents: TaskCreate + start_task before editing.
#
# Default-on: like the other orchestrator hooks, the gate is active by default. A conversation
#   opts out with 'orch off' (drops sessions/<id>.off). If that marker is present, exit 0.
# Fail-open: if the daemon is unreachable we allow (exit 0) rather than bricking edits when the
#   daemon is down. We deny only on a definitive "no claim for this session".
PORT="${ORCH_PORT:-8787}"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=orch-gate-trivial.sh
. "$HOOK_DIR/orch-gate-trivial.sh"

# ── Env off-switch ─────────────────────────────────────────────────────────
# Harnesses that spawn claude processes (e.g. bench runner) can set ORCH_GATE_OFF=1
# in the child process environment to ungate those sessions entirely.
[ "${ORCH_GATE_OFF:-0}" = "1" ] && exit 0

INPUT=$(cat)

# Path allowlist: harness plumbing that is NOT "substantive multi-step work" and must never be
# gated (memory writes, config edits, scratch). Orchestrator SOURCE (~/.claude/orchestrator/**)
# is deliberately NOT exempted -- that's the substantive work the gate exists to route.
FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

# ── Codex apply_patch path extraction ──────────────────────────────────────
# Codex's apply_patch tool does NOT populate tool_input.file_path — the target path(s) live inside
# the patch envelope under a build-dependent field (input / patch / changes[] / …). We mirror the
# multi-key fallback used in orch-gate.js: pull the first string carrier that looks like a patch,
# then parse the per-file headers (`*** Add/Update/Delete File: <path>` + the rename `*** Move to:
# <path>`). A single apply_patch may touch MANY files — collect EVERY path so each is confine-checked.
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
PATCH_PATHS=""
if [ "$TOOL_NAME" = "apply_patch" ] || [ -z "$FP" ]; then
  PATCH_TEXT=$(printf '%s' "$INPUT" | jq -r '
    .tool_input as $t
    | ( $t.input // $t.patch // $t.patch_text // $t.diff // $t.content // $t.text
        // ( ($t.changes // []) | map(if type=="string" then . else (.patch // .diff // .content // "") end) | join("\n") )
        // "" )' 2>/dev/null)
  case "$PATCH_TEXT" in
    *'*** '*)
      PATCH_PATHS=$(printf '%s' "$PATCH_TEXT" \
        | grep -E '^\*\*\*[[:space:]]+(Add File|Update File|Delete File|Move to):' \
        | sed -E 's/^\*\*\*[[:space:]]+(Add File|Update File|Delete File|Move to):[[:space:]]*//' \
        | sed -E 's/[[:space:]]+$//')
      ;;
  esac
fi

case "$FP" in
  */.claude/projects/*/memory/*)         exit 0 ;;  # auto-memory store (incl. MEMORY.md)
  */.claude/settings.json|*/.claude/settings.local.json) exit 0 ;;  # harness settings
  */.claude/keybindings.json|*/.claude/launch.json)      exit 0 ;;  # harness config
  */.mcp.json)                           exit 0 ;;  # MCP server config
  */CLAUDE.md)                           exit 0 ;;  # instruction file
  /tmp/*|/private/tmp/*)                 ;;         # /tmp is NOT exempt: workers must use proper claimed worktrees
  */.claude/orchestrator/tasks/*)       exit 0 ;;  # file-drop task mint (task_create / create_task / post-todo-adopt)
  */.claude/tasks/*)                     exit 0 ;;  # Claude native TaskCreate / TaskUpdate files
  */.claude/orchestrator/*)              ;;         # orchestrator source: never exempt, fall through to claim check
  */scratch/*)                           exit 0 ;;  # workspace scratch dir
  *.log|*/logs/*)                        exit 0 ;;  # log writes are not substantive work
esac

# Helper: collapse '/x/../' segments (mirrors hookkit.normalizePath / orch-gate-bash normalize_path).
normalize_path() {
  local p="$1"
  while printf '%s' "$p" | grep -qE '/[^/]+/\.\./'; do
    p=$(printf '%s' "$p" | sed 's|/[^/]*/\.\./|/|g')
  done
  p=$(printf '%s' "$p" | sed 's|/[^/]*/\.\.$||')
  printf '%s' "$p"
}
# Helper: resolve a (possibly relative) apply_patch target against the worktree, then test ancestry.
# apply_patch headers may carry a path relative to the worker's cwd (== the claim worktree). Absolute
# paths (POSIX /… or Windows C:/…) pass through; relatives are joined onto WT; '..' is collapsed so an
# escape can't hide inside the prefix. Returns 0 (true) if the resolved target is inside WT.
target_under_wt() {
  local t="$1" wt="$2" rt
  [ -z "$wt" ] && return 1
  case "$t" in
    /*|[A-Za-z]:/*) rt="$t" ;;
    *) rt="${wt%/}/$t" ;;
  esac
  rt=$(normalize_path "$rt")
  case "$rt" in "$wt"/*|"$wt") return 0 ;; *) return 1 ;; esac
}

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0                # no session id -> can't correlate; don't block
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0       # skip only when orchestrator is disabled for this conversation (default on)

RESP=$(curl -s --max-time 0.6 "localhost:$PORT/active-claim?session=$SID" 2>/dev/null)
[ -z "$RESP" ] && exit 0               # daemon unreachable -> fail open

if printf '%s' "$RESP" | jq -e '.claimed == true' >/dev/null 2>&1; then
  # Check if any claimed task has a registered worktree that covers EVERY target path.
  # Targets = the Write/Edit file_path PLUS every path an apply_patch envelope touches (apply_patch
  # may write multiple files in one call; if ANY lands outside the worktree we must block). With
  # multiple active claims a session may legitimately write to different worktrees, so we iterate ALL
  # claims and allow if ANY claim's worktree is an ancestor of all targets.
  TARGETS=""
  [ -n "$FP" ] && TARGETS="$FP"
  if [ -n "$PATCH_PATHS" ]; then
    if [ -n "$TARGETS" ]; then TARGETS=$(printf '%s\n%s' "$TARGETS" "$PATCH_PATHS"); else TARGETS="$PATCH_PATHS"; fi
  fi
  CLAIM_COUNT=$(printf '%s' "$RESP" | jq -r '.claims | length' 2>/dev/null)
  CLAIM_COUNT="${CLAIM_COUNT:-0}"
  ANY_WORKTREE=0   # did we find at least one claim with a registered worktree?
  MATCHED=0        # did EVERY target fall inside one of those worktrees?
  MISMATCH_BRANCH=""
  OFFENDING=""     # first target that fell outside (for the deny message)
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
        # Empty targets (non-file tool) => allow. Otherwise require EVERY target inside this claim's
        # worktree. target_under_wt resolves relative apply_patch paths against TASK_WT and guards on
        # a non-empty TASK_WT (an empty worktree must never degrade to a universal match).
        if [ -z "$TARGETS" ]; then
          MATCHED=1
          break
        fi
        _ALL_INSIDE=1
        _OFFENDING=""
        while IFS= read -r _t; do
          [ -z "$_t" ] && continue
          if ! target_under_wt "$_t" "$TASK_WT"; then _ALL_INSIDE=0; _OFFENDING="$_t"; break; fi
        done <<TARGETEOF
$TARGETS
TARGETEOF
        if [ "$_ALL_INSIDE" = "1" ]; then
          MATCHED=1
          break
        fi
        OFFENDING="$_OFFENDING"
      fi
    fi
    i=$((i + 1))
  done
  if [ "$ANY_WORKTREE" = "1" ] && [ "$MATCHED" = "0" ]; then
    _BAD="${OFFENDING:-$FP}"
    [ -z "$_BAD" ] && _BAD="(apply_patch)"
    printf 'orch-gate: task has a registered worktree (%s) — writes must happen inside the worktree path, not at %s. Use the path returned by branch_task.\n' "$MISMATCH_BRANCH" "$_BAD" >&2
    exit 2
  fi
  exit 0                               # an in_progress task is claimed for this session -> allow
fi

# No active claim. Check whether this is a subagent session or a main/driving session.
SINFO=$(curl -s --max-time 0.6 "localhost:$PORT/session-info?session=$SID" 2>/dev/null)
IS_SUB=$(printf '%s' "$SINFO" | jq -r '.is_subagent // "unknown"' 2>/dev/null)

if [ "$IS_SUB" = "true" ]; then
  # Registered subagent with no claim — must file a task first.
  printf 'orch-gate: no task claimed. Worker subagents must call branch_task then start_task before editing. To create new tasks use Claude TaskCreate or an adapter file-drop create_task/task_create tool.\n' >&2
  exit 2
fi

# Main/driving session (or unknown session-info): try 1 trivial patch/turn if workers in flight.
PATCH=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // .tool_input.content // empty')
if try_trivial_main_allow "$SID" "$PATCH"; then
  chars=$(printf '%s' "$PATCH" | wc -c | tr -d ' ')
  report_dispatcher_edit "$SID" "$chars" "$FP"
  exit 0
fi
main_session_deny_message >&2
exit 2
