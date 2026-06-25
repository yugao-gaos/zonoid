#!/usr/bin/env bash
# Primary smoke: held-out retrieval bench against frozen KB snapshot.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SNAPSHOT_GRAPH="$REPO/bench/snapshot/.graph"

if [ ! -d "$SNAPSHOT_GRAPH" ]; then
  echo "refreshing KB snapshot (bench/snapshot/.graph missing)..."
  node -e "require('$REPO/scripts/bench-snapshot-daemon').ensureSnapshot(true)"
fi

chmod +x "$REPO/bench/retrieval/run-heldout-retrieval.sh" 2>/dev/null || true

exec node "$REPO/scripts/retrieval-bench.js" --heldout --isolated --check "$@"
