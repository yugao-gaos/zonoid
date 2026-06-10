#!/bin/bash
# Rigging guard: 3 cold (off) trials. Direct node invocation, NO timeout wrapper. Incremental writes.
set -u
REPO=__INSTALL_DIR__
OUT=$REPO/bench/heldout/n2/locale-sum.results.jsonl
for t in 0 1 2; do
  echo "[guard] cold trial $t starting $(date -u +%H:%M:%S)" >&2
  node $REPO/scripts/bench-heldout.js --candidate locale-sum --arm off --trial $t >> "$OUT" 2>>"$REPO/bench/heldout/n2/cold.err"
  echo "[guard] cold trial $t done $(date -u +%H:%M:%S)" >&2
done
echo "[guard] ALL COLD DONE $(date -u +%H:%M:%S)" >&2
