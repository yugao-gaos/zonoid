#!/usr/bin/env bash
# Re-apply FeatureBench venv patches after uv pip install --upgrade featurebench.
# Run from the repo root: bash patches/apply-fb-patches.sh
set -e

VENV="${1:-.venv-fb}"
if [ -d "$VENV/Lib/site-packages/featurebench" ]; then
  FB="$VENV/Lib/site-packages/featurebench"
else
  FB="$(find "$VENV/lib" -path '*/site-packages/featurebench' -type d -print -quit 2>/dev/null || true)"
fi

if [ -z "$FB" ] || [ ! -d "$FB" ]; then
  echo "Could not find featurebench package under $VENV" >&2
  exit 1
fi

echo "Patching $FB ..."

# claude_code.py — zonoid pre_run_hook, dynamic AGENTS.md injection, KB call counting
cp patches/featurebench-claude_code.py "$FB/infer/agents/claude_code.py"

# output.py — Windows fcntl shim (fcntl is Unix-only; threading.Lock covers single-process safety)
cp patches/featurebench-output.py "$FB/infer/output.py"

echo "Done."
