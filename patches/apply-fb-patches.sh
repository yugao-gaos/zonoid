#!/usr/bin/env bash
# Re-apply FeatureBench venv patches after uv pip install --upgrade featurebench.
# Run from the repo root: bash patches/apply-fb-patches.sh
set -e

VENV="${1:-.venv-fb}"
FB="$VENV/Lib/site-packages/featurebench"

echo "Patching $FB ..."

# claude_code.py — zonoid pre_run_hook, dynamic AGENTS.md injection, KB call counting
cp patches/featurebench-claude_code.py "$FB/infer/agents/claude_code.py"

# output.py — Windows fcntl shim (fcntl is Unix-only; threading.Lock covers single-process safety)
cp patches/featurebench-output.py "$FB/infer/output.py"

echo "Done."
