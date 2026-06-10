#!/bin/bash
# Test suite for /context-classify endpoint and classify.sh loop detection.
# Usage: bash scripts/test-classifier.sh
set -euo pipefail
PORT="${ORCH_PORT:-8787}"
PASS=0; FAIL=0

check() {
  local name="$1" result="$2" expected_key="$3" expected_val="$4" cmp="${5:-gte}"
  local actual
  actual=$(printf '%s' "$result" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get('$expected_key',''))
except Exception as e:
    print('')
" 2>/dev/null)
  local ok=0
  case "$cmp" in
    gte)  python3 -c "exit(0 if float('${actual:-0}') >= float('$expected_val') else 1)" 2>/dev/null && ok=1 ;;
    eq)   [ "$actual" = "$expected_val" ] && ok=1 ;;
    in)   printf '%s' "$actual" | grep -qE "$expected_val" && ok=1 ;;
  esac
  if [ $ok -eq 1 ]; then
    echo "PASS: $name ($expected_key=$actual)"
    PASS=$((PASS+1))
  else
    echo "FAIL: $name — expected $expected_key $cmp $expected_val, got: $actual"
    echo "      Full response: $result"
    FAIL=$((FAIL+1))
  fi
}

echo "=== test-classifier.sh ==="
echo "Daemon: localhost:$PORT"
echo ""

# Check daemon is up
if ! curl -s --max-time 2 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "ERROR: daemon not reachable at localhost:$PORT"
  exit 1
fi

# --- Case 1: Failure/positioning case → scaffold or inject ---
PROMPT1="what is our latest product positioning and do a review of what we have"
R1=$(curl -s --max-time 5 -XPOST "localhost:$PORT/context-classify" \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"$PROMPT1\"}")
echo "Case 1: product positioning review"
check "dag_score>=0.3 OR gate=inject/scaffold" "$R1" "dag_score" "0.3" "gte"
R1_GATE=$(printf '%s' "$R1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('gate_decision',''))" 2>/dev/null)
if [ "$R1_GATE" = "scaffold" ] || [ "$R1_GATE" = "inject" ]; then
  echo "PASS: gate_decision is scaffold or inject ($R1_GATE)"
  PASS=$((PASS+1))
else
  echo "FAIL: gate_decision expected scaffold or inject, got: $R1_GATE"
  FAIL=$((FAIL+1))
fi
echo ""

# --- Case 2: Simple code question → rag_score low (semantic gate should not inject) ---
# Note: dag_score may be non-zero in a dense KB (many overlay tasks), but RAG gate should abstain.
PROMPT2="what does overlay.js do"
R2=$(curl -s --max-time 5 -XPOST "localhost:$PORT/context-classify" \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"$PROMPT2\"}")
echo "Case 2: simple code question (rag gate abstains)"
R2_GATE=$(printf '%s' "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('gate_decision',''))" 2>/dev/null)
# gate should be abstain or scaffold (not inject — no empirical scar directly about this file)
if [ "$R2_GATE" != "inject" ]; then
  echo "PASS: rag gate did not inject for simple code question (gate_decision=$R2_GATE)"
  PASS=$((PASS+1))
else
  echo "FAIL: expected gate_decision != inject for simple code question, got: $R2_GATE"
  echo "      Full response: $R2"
  FAIL=$((FAIL+1))
fi
echo ""

# --- Case 3: Loop detection via heuristic (classify.sh, not endpoint) ---
PROMPT3="keep running the test suite until all tests pass"
echo "Case 3: loop detection (heuristic)"
LOOP_DECISION=$(printf '{"prompt":"%s","session_id":"test-session"}' "$PROMPT3" \
  | bash "$(dirname "$0")/../hooks/classify.sh" 2>/dev/null \
  | python3 -c "
import sys, json
try:
    raw = sys.stdin.read()
    d = json.loads(raw)
    ctx = d.get('hookSpecificOutput',{}).get('additionalContext','')
    print('loop' if 'iterative' in ctx or 'loop' in ctx.lower() else 'other')
except:
    print('other')
" 2>/dev/null || echo "other")
if [ "$LOOP_DECISION" = "loop" ]; then
  echo "PASS: loop detection fired"
  PASS=$((PASS+1))
else
  echo "FAIL: loop detection did not fire (got: $LOOP_DECISION)"
  FAIL=$((FAIL+1))
fi
echo ""

# --- Case 4: Complexity check → >=0.7 ---
PROMPT4="audit every file in the repo for hardcoded paths and migrate them to use env vars"
R4=$(curl -s --max-time 5 -XPOST "localhost:$PORT/context-classify" \
  -H 'content-type: application/json' \
  -d "{\"prompt\":\"$PROMPT4\"}")
echo "Case 4: complexity check"
check "complexity>=0.7" "$R4" "complexity" "0.7" "gte"
echo ""

echo "=== Results: $PASS passed, $FAIL failed ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1
