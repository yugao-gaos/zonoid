#!/bin/bash
# Phase 1 Stage B: warm corroboration arm (on --consult=search), N=2 per candidate.
# All rigging guards FAILED (cold at ceiling) so these are parity/harm checks, not win runs.
set -u
REPO=${ZONOID_REPO:-$(cd "$(dirname "$0")/../.."; pwd)}
P1=$REPO/bench/heldout/p1
OUT=$P1/results.jsonl
run() {
  echo "[B] $1 on trial $2 starting $(date -u +%H:%M:%S)" >&2
  node $REPO/scripts/bench-heldout.js --candidate "$1" --arm on --consult=search --trial "$2" >> "$OUT" 2>>"$P1/stage-b.err"
  echo "[B] $1 on trial $2 done $(date -u +%H:%M:%S)" >&2
}
for c in native-store claim-task wt-gc tls-local ctl-loop-next ctl-stale-claims ctl-agg-report; do
  for t in 0 1; do run $c $t; done
done
echo "[B] ALL STAGE B DONE $(date -u +%H:%M:%S)" >&2
