#!/bin/bash
# Warm arm: 5 trials, on --consult=search. Direct node, NO timeout wrapper, incremental append.
set -u
REPO=__INSTALL_DIR__
OUT=$REPO/bench/heldout/n2/locale-sum.warm.jsonl
: > "$OUT"
for t in 0 1 2 3 4; do
  echo "[warm] trial $t starting $(date -u +%H:%M:%S)" >&2
  node $REPO/scripts/bench-heldout.js --candidate locale-sum --arm on --consult=search --trial $t >> "$OUT" 2>>"$REPO/bench/heldout/n2/warm.err"
  echo "[warm] trial $t done $(date -u +%H:%M:%S)" >&2
done
echo "[warm] ALL WARM DONE $(date -u +%H:%M:%S)" >&2
