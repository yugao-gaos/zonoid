#!/bin/bash
# v7 driver: retest v1 (graph-dependent, self-contained) and v4 (v4-hard) with a 4-arm matrix:
#   OFF (baseline, no MCP)
#   ON --consult=dagrag  (DAG context via get_task_detail + semantic RAG via search_knowledge) — headline
#   ON --consult=search  (semantic RAG only) — isolates retrieval
#   ON --consult=lean     (DAG/dump only, no search) — isolates structural context
#
# Each arm uses a DISTINCT --problem label (v{N}-{arm}) so it gets its own git worktree (bench-arm.js
# derives the worktree path from problem+arm and all 3 ON arms share arm=on). ON arms are therefore
# run SERIALLY within a trial; OFF runs in parallel alongside the first ON arm.
#
# Usage: bash bench/run-v7.sh [TRIALS]   (default 5)
set -uo pipefail
cd ${ZONOID_REPO:-$HOME/.claude/orchestrator} || exit 1

TRIALS="${1:-5}"
TMP=bench/.v7tmp
LOG=bench/run-v7.log
mkdir -p "$TMP"
: > "$LOG"

# spec_for <problem-base>  ->  spec path
spec_for() {
  case "$1" in
    v1) echo bench/specs/graph-dependent.md ;;
    v4) echo bench/specs/v4-hard.md ;;
  esac
}

# run_arm <base> <consult|off> <trial>
run_arm() {
  local base=$1 mode=$2 trial=$3 spec arm consult problem
  spec=$(spec_for "$base")
  problem="$base-$mode"
  if [ "$mode" = "off" ]; then
    arm=off; consult=""
  else
    arm=on; consult="--consult=$mode"
  fi
  node scripts/bench-arm.js --spec "$spec" --arm "$arm" --trial "$trial" \
    --problem "$problem" --model opus $consult \
    > "$TMP/$problem-$trial.out" 2>> "$LOG"
}

t=0
while [ "$t" -lt "$TRIALS" ]; do
  echo "=== trial $t @ $(date +%H:%M:%S) ===" >> "$LOG"
  for base in v1 v4; do
    # OFF in parallel with the first ON arm; the other two ON arms serialize (shared arm=on worktree base differs by problem so they could parallelize, but keep load bounded).
    run_arm "$base" off    "$t" &
    run_arm "$base" dagrag "$t"
    wait
    run_arm "$base" search "$t"
    run_arm "$base" lean   "$t"
  done
  t=$((t+1))
done

# Assemble results JSONL. Real arm lines first.
RAW=bench/results-v7.jsonl
: > "$RAW"
for f in "$TMP"/*.out; do
  grep -E '^\{.*"sessionId"' "$f" | tail -1 >> "$RAW"
done

# The reporter pairs ON/OFF within the SAME problem string. Our real OFF runs are labeled v{N}-off,
# while ON arms are v{N}-dagrag / v{N}-search / v{N}-lean — none pair. So synthesize OFF rows under
# each ON problem label, pointing at the SAME real OFF transcripts (relabel only; no extra runs).
node - "$RAW" <<'NODE'
const fs = require('fs');
const raw = process.argv[2];
const lines = fs.readFileSync(raw, 'utf8').split('\n').filter(s => s.trim());
const rows = lines.map(l => JSON.parse(l));
const extra = [];
for (const r of rows) {
  if (String(r.arm).toLowerCase() !== 'off') continue;
  const m = /^(v\d+)-off$/.exec(r.problem);
  if (!m) continue;
  for (const mode of ['dagrag', 'search', 'lean']) {
    extra.push({ ...r, problem: `${m[1]}-${mode}` });   // relabel OFF to pair with each ON arm
  }
}
fs.writeFileSync(raw, rows.concat(extra).map(o => JSON.stringify(o)).join('\n') + '\n');
console.error(`assembled ${rows.length} real + ${extra.length} relabeled-OFF = ${rows.length + extra.length} rows`);
NODE

node scripts/bench-report.js "$RAW" >> "$LOG" 2>&1
cp bench/report.md   bench/report-v7.md   2>/dev/null
cp bench/report.json bench/report-v7.json 2>/dev/null
git checkout -- bench/report.md bench/report.json 2>/dev/null

# Cleanup worktrees + branches.
git worktree list | awk '/worktrees\/bench\//{print $1}' | while read -r w; do
  git worktree remove --force "$w" 2>/dev/null
done
git worktree prune 2>/dev/null
git for-each-ref --format='%(refname:short)' refs/heads/orch/bench 2>/dev/null | while read -r b; do
  git branch -D "$b" 2>/dev/null
done
rm -rf "$TMP"

echo "V7_DONE results=$(wc -l < "$RAW") @ $(date +%H:%M:%S)"
