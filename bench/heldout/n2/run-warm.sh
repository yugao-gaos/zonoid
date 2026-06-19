#!/bin/bash
# Warm arm used the retired JS ON path. Active ON runs now use the canonical Python SDK arms.
set -u
echo "[warm] JS heldout ON arm is retired; use bench/zonoid_bench/arms.py canonical SDK ON arms instead." >&2
exit 2
