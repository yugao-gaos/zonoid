#!/bin/bash
# Deterministic driver for the v2 forced-graph-usage benchmark.
# Runs graph-dependent x {on(mandatory),off} x trials 0..4 = 10 opus arms,
# 2-at-a-time (on+off per trial), collects results, builds report-v2, cleans up.
set -uo pipefail
cd ${ZONOID_REPO:-$HOME/.claude/orchestrator} || exit 1

SPEC=bench/specs/graph-dependent.md
TMP=bench/.v2tmp
LOG=bench/run-v2.log
mkdir -p "$TMP"
: > "$LOG"

run_arm() {
  local arm=$1 trial=$2 consult=""
  [ "$arm" = "on" ] && consult="--consult=mandatory"
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

# Collect the JSON result line from each arm's stdout (last line that looks like our result).
: > bench/results-v2.jsonl
for f in "$TMP"/*.out; do
  grep -E '^\{.*"sessionId"' "$f" | tail -1 >> bench/results-v2.jsonl
done

# Build the report (writes fixed report.md/json), copy to v2 names, restore the committed v1 reports.
node scripts/bench-report.js bench/results-v2.jsonl >> "$LOG" 2>&1
cp bench/report.md   bench/report-v2.md   2>/dev/null
cp bench/report.json bench/report-v2.json 2>/dev/null
git checkout -- bench/report.md bench/report.json 2>/dev/null

# Cleanup all bench worktrees + branches.
git worktree list | awk '/worktrees\/bench\//{print $1}' | while read -r w; do
  git worktree remove --force "$w" 2>/dev/null
done
git worktree prune 2>/dev/null
git for-each-ref --format='%(refname:short)' refs/heads/orch/bench 2>/dev/null | while read -r b; do
  git branch -D "$b" 2>/dev/null
done
rm -rf "$TMP"

echo "V2_DONE results=$(wc -l < bench/results-v2.jsonl) @ $(date +%H:%M:%S)"
