#!/bin/bash
# v5 GROUNDED driver: v5-grounded x {on (--consult=search), off} x trials 0..N-1, 2-at-a-time.
# Tests whether a grounded + RETRIEVABLE KB note collapses hardness where v4 (general) nulled.
set -uo pipefail
cd ${ZONOID_REPO:-$HOME/.claude/orchestrator} || exit 1
TRIALS="${1:-5}"
SPEC=bench/specs/v5-grounded.md
PROBLEM=v5-grounded
TMP=bench/.v5tmp; LOG=bench/run-v5.log
mkdir -p "$TMP"; : > "$LOG"
run_arm() {
  local arm=$1 trial=$2 consult=""
  [ "$arm" = "on" ] && consult="--consult=search"
  node scripts/bench-arm.js --spec "$SPEC" --arm "$arm" --trial "$trial" \
    --problem "$PROBLEM" --model opus $consult > "$TMP/$arm-$trial.out" 2>> "$LOG"
}
t=0
while [ "$t" -lt "$TRIALS" ]; do
  echo "=== trial $t @ $(date +%H:%M:%S) ===" >> "$LOG"
  run_arm on "$t" & run_arm off "$t" & wait
  t=$((t+1))
done
: > bench/results-v5.jsonl
for f in "$TMP"/*.out; do grep -E '^\{.*"sessionId"' "$f" | tail -1 >> bench/results-v5.jsonl; done
node scripts/bench-report.js bench/results-v5.jsonl >> "$LOG" 2>&1
cp bench/report.md bench/report-v5.md 2>/dev/null; cp bench/report.json bench/report-v5.json 2>/dev/null
git checkout -- bench/report.md bench/report.json 2>/dev/null
git worktree list | awk '/worktrees\/bench\//{print $1}' | while read -r w; do git worktree remove --force "$w" 2>/dev/null; done
git worktree prune 2>/dev/null
git for-each-ref --format='%(refname:short)' refs/heads/orch/bench 2>/dev/null | while read -r b; do git branch -D "$b" 2>/dev/null; done
rm -rf "$TMP"
echo "V5_DONE results=$(wc -l < bench/results-v5.jsonl) @ $(date +%H:%M:%S)"
