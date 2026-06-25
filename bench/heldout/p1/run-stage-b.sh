#!/bin/bash
# Phase 1 Stage B used the retired JS warm arm (on --consult=search).
# Active ON bench runs now use bench/zonoid_bench/arms.py with an isolated local daemon/workspace.
set -u
echo "[B] JS heldout ON arm is retired; use canonical Python SDK ON arms instead." >&2
exit 2
