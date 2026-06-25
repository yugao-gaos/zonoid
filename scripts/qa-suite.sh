#!/bin/bash
# qa-suite.sh — fixed-behavior test sweep for the nightly QA pass.
#
# Exists so the headless QA agent never needs shell constructs the permission
# classifier can't statically verify (for-loops, $(), env prefixes). The agent
# runs THIS script via an exact allowlist entry in .claude/settings.json; the
# script is the reviewable trust boundary. Keep it argument-validated and
# side-effect-free (stdout only).
#
# Usage:
#   ./scripts/qa-suite.sh                     # run every test/*.test.js
#   ./scripts/qa-suite.sh test/foo.test.js    # rerun one suite (flake check)
set -u
cd "$(dirname "$0")/.." || exit 2

if [ $# -gt 1 ]; then
  echo "usage: qa-suite.sh [test/<name>.test.js]" >&2
  exit 2
fi

if [ $# -eq 1 ]; then
  case "$1" in
    test/*.test.js) ;;
    *) echo "refusing: argument must match test/*.test.js (got: $1)" >&2; exit 2 ;;
  esac
  case "$1" in
    *..*) echo "refusing: no path traversal" >&2; exit 2 ;;
  esac
  [ -f "$1" ] || { echo "no such test: $1" >&2; exit 2; }
  files="$1"
else
  files=$(ls test/*.test.js)
fi

overall=0
for f in $files; do
  out=$(node "$f" 2>&1)
  code=$?
  summary=$(printf '%s\n' "$out" | grep -E 'passed|FAIL|SKIP|Error' | tail -2 | tr '\n' ' ')
  [ -z "$summary" ] && summary=$(printf '%s\n' "$out" | tail -1)
  printf '%-44s exit=%d | %s\n' "$f" "$code" "$summary"
  if [ $code -ne 0 ]; then
    overall=1
    printf '%s\n' "$out" | tail -50
  fi
done
exit $overall
