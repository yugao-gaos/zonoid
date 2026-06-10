#!/bin/bash
# Phase 1 Stage A: ALL COLD runs (rigging guards + cold arms). Direct node, NO timeout wrapper,
# incremental appends. Trap candidates x3, tls-local probe x2, controls x3.
set -u
REPO=__INSTALL_DIR__
P1=$REPO/bench/heldout/p1
OUT=$P1/results.jsonl
run() {
  echo "[A] $1 off trial $2 starting $(date -u +%H:%M:%S)" >&2
  node $REPO/scripts/bench-heldout.js --candidate "$1" --arm off --trial "$2" >> "$OUT" 2>>"$P1/stage-a.err"
  echo "[A] $1 off trial $2 done $(date -u +%H:%M:%S)" >&2
}
for t in 0 1 2; do run native-store $t; done
for t in 0 1 2; do run claim-task $t; done
for t in 0 1 2; do run wt-gc $t; done
for t in 0 1; do run tls-local $t; done
for t in 0 1 2; do run ctl-loop-next $t; done
for t in 0 1 2; do run ctl-stale-claims $t; done
for t in 0 1 2; do run ctl-agg-report $t; done
echo "[A] ALL STAGE A DONE $(date -u +%H:%M:%S)" >&2
