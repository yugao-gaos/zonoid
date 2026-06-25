#!/bin/bash
# v3 driver: graph-dependent x {on (--consult=lean), off} x trials 0..4 = 10 opus arms,
# 2-at-a-time (on+off per trial). ON arm calls get_learnings(compact:true) — the lean index.
# Collects results, builds the cost-weighted report-v3, cleans up.
set -uo pipefail
cd ${ZONOID_REPO:-$HOME/.claude/orchestrator} || exit 1

SPEC=bench/specs/graph-dependent.md
TMP=bench/.v3tmp
LOG=bench/run-v3.log
mkdir -p "$TMP"
: > "$LOG"

run_arm() {
  local arm=$1 trial=$2 consult=""
  [ "$arm" = "on" ] && consult="--consult=lean"
  node scripts/bench-arm.js --spec "$SPEC" --arm "$arm" --trial "$trial" \
    --problem graph-dependent --model opus $consult \
    > "$TMP/$arm-$trial.out" 2>> "$LOG"
}

for t in 0 1 2 3 4; do
  echo "=== trial $t @ $(date +%H:%M:%S) ===" >> "$LOG"
  run_arm on  "$t" &
  run_arm off "$t" &
  wait
done

# Collect the JSON result line from each arm's stdout.
: > bench/results-v3.jsonl
for f in "$TMP"/*.out; do
  grep -E '^\{.*"sessionId"' "$f" | tail -1 >> bench/results-v3.jsonl
done

# Build the (cost-weighted) report, copy to v3 names, restore committed reports.
node scripts/bench-report.js bench/results-v3.jsonl >> "$LOG" 2>&1
cp bench/report.md   bench/report-v3.md   2>/dev/null
cp bench/report.json bench/report-v3.json 2>/dev/null
git checkout -- bench/report.md bench/report.json 2>/dev/null

# Cleanup bench worktrees + branches.
git worktree list | awk '/worktrees\/bench\//{print $1}' | while read -r w; do
  git worktree remove --force "$w" 2>/dev/null
done
git worktree prune 2>/dev/null
git for-each-ref --format='%(refname:short)' refs/heads/orch/bench 2>/dev/null | while read -r b; do
  git branch -D "$b" 2>/dev/null
done
rm -rf "$TMP"

echo "V3_DONE results=$(wc -l < bench/results-v3.jsonl) @ $(date +%H:%M:%S)"
