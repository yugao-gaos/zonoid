#!/bin/bash
# Verification script for the CMD_REDIR masking fix in orch-gate-bash.sh.
# Tests the quote-masking + redirect greps in isolation.

PASS=0
FAIL=0

check() {
  local label="$1"
  local CMD="$2"
  local expected="$3"

  # Replicate the masking
  CMD_REDIR=$(printf '%s' "$CMD" | sed "s/'[^']*'/Q/g; s/\"[^\"]*\"/Q/g")

  WRITE_PATTERN=0
  if printf '%s' "$CMD_REDIR" | grep -qE '(^|[^[:alnum:]._@-])(>>?)[[:space:]]*[^/[:space:]&0-9]' 2>/dev/null; then
    WRITE_PATTERN=1
  fi
  if printf '%s' "$CMD_REDIR" | grep -qP '(>>?)\s*/(?!dev/null)' 2>/dev/null; then
    WRITE_PATTERN=1
  fi

  if [ "$WRITE_PATTERN" = "$expected" ]; then
    echo "PASS  $label  CMD_REDIR='$CMD_REDIR'  WRITE_PATTERN=$WRITE_PATTERN"
    PASS=$((PASS+1))
  else
    echo "FAIL  $label  CMD_REDIR='$CMD_REDIR'  WRITE_PATTERN=$WRITE_PATTERN (expected $expected)"
    FAIL=$((FAIL+1))
  fi
}

# (a) find with quoted glob containing < > — should NOT set WRITE_PATTERN
check "(a) find quoted glob" "find . -name '*[<>:\"|?*]*'" 0

# (b) echo x to a double-quoted file — MUST set WRITE_PATTERN
check "(b) echo x > quoted file" 'echo x > "file"' 1

# (c) plain redirect — MUST set WRITE_PATTERN
check "(c) cmd > out.txt" 'cmd > out.txt' 1

# (d) grep with quoted regex — should NOT set WRITE_PATTERN
check "(d) grep -rE" "grep -rE 'a|b' ." 0

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && exit 0 || exit 1
