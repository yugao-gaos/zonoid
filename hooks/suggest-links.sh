#!/bin/bash
# PostToolUse(TaskCreate): after a task is created, ask the daemon which existing tasks
# (including COMPLETED ones) the new task should link to, and inject the candidates so the
# agent can add context/blocking edges — stops new tasks piling up as orphan root nodes.
# Gated on the per-conversation opt-out (same mark as classify.sh; default on). Best-effort; always exit 0.
# CLI-only: the desktop app does not run hooks.
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0   # skip only when orchestrator is disabled for this conversation (default on)

# new native task id from the TaskCreate response text ("Task #12 created successfully: ...")
ID=$(printf '%s' "$INPUT" | grep -oE 'Task #[0-9]+' | head -1 | grep -oE '[0-9]+')
[ -z "$ID" ] && exit 0
KEY="$SID/$ID"

# fetch suggestions; brief retry for the daemon's task-dir re-read after the new file lands
SUG=""
for i in 1 2 3; do
  SUG=$(curl -s --max-time 0.6 "localhost:$PORT/task/suggest?key=$KEY" 2>/dev/null)
  printf '%s' "$SUG" | jq -e '.suggestions | length > 0' >/dev/null 2>&1 && break
  sleep 0.2
done
# Quarantine reminder ALWAYS fires (even with zero candidates) — a new task is unwired and
# cannot be claimed by start_task until it's wired (add_dependency) or declared a root (mark_root).
QUAR=$(printf 'Task %s created — it is QUARANTINED as unwired. Wire it now: suggest_links + add_dependency (blocking for prerequisites, context for related done work), or mark_root if genuinely standalone. Unwired tasks cannot be claimed by start_task.' "$KEY")
if printf '%s' "$SUG" | jq -e '.suggestions | length > 0' >/dev/null 2>&1; then
  LINES=$(printf '%s' "$SUG" | jq -r '.suggestions[] | "  - \(.key) [\(.status)] \(.label) (score \(.score), suggest \(.suggest_kind))"' | head -5)
  CTX=$(printf '[Orchestrator] %s\nCandidate links among existing tasks (incl. completed):\n%s\nFor relevant DONE matches call add_dependency(from=<match>, to=%s, kind="context") so their summary becomes Tier-1 context; for a true prerequisite use kind="blocking". Skip unrelated ones.' "$QUAR" "$LINES" "$KEY")
else
  CTX=$(printf '[Orchestrator] %s' "$QUAR")
fi
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
