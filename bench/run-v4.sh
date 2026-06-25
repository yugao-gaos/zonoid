#!/bin/bash
# v4 driver: v4-hard x {on (--consult=lean), off} x trials 0..N-1, 2-at-a-time.
# Tests whether a HIGH-HARDNESS task (OFF must re-derive what ON reads from the graph)
# produces real hardness divergence. Emits the W/H/C decomposition + win-guards.
# Usage: bash bench/run-v4.sh [TRIALS]   (default 5)
set -uo pipefail
cd ${ZONOID_REPO:-$HOME/.claude/orchestrator} || exit 1

TRIALS="${1:-5}"
SPEC=bench/specs/v4-hard.md
PROBLEM=v4-hard
TMP=bench/.v4tmp
LOG=bench/run-v4.log
mkdir -p "$TMP"
: > "$LOG"

run_arm() {
  local arm=$1 trial=$2 consult=""
  [ "$arm" = "on" ] && consult="--consult=lean"
  node scripts/bench-arm.js --spec "$SPEC" --arm "$arm" --trial "$trial" \
    --problem "$PROBLEM" --model opus $consult \
    > "$TMP/$arm-$trial.out" 2>> "$LOG"
}

t=0
while [ "$t" -lt "$TRIALS" ]; do
  echo "=== trial $t @ $(date +%H:%M:%S) ===" >> "$LOG"
  run_arm on  "$t" &
  run_arm off "$t" &
  wait
  t=$((t+1))
done

: > bench/results-v4.jsonl
for f in "$TMP"/*.out; do
  grep -E '^\{.*"sessionId"' "$f" | tail -1 >> bench/results-v4.jsonl
done

node scripts/bench-report.js bench/results-v4.jsonl >> "$LOG" 2>&1
cp bench/report.md   bench/report-v4.md   2>/dev/null
cp bench/report.json bench/report-v4.json 2>/dev/null
git checkout -- bench/report.md bench/report.json 2>/dev/null

git worktree list | awk '/worktrees\/bench\//{print $1}' | while read -r w; do
  git worktree remove --force "$w" 2>/dev/null
done
git worktree prune 2>/dev/null
git for-each-ref --format='%(refname:short)' refs/heads/orch/bench 2>/dev/null | while read -r b; do
  git branch -D "$b" 2>/dev/null
done
rm -rf "$TMP"

echo "V4_DONE results=$(wc -l < bench/results-v4.jsonl) @ $(date +%H:%M:%S)"
