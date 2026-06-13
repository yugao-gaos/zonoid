#!/bin/bash
# beforeSubmitPrompt → classify relay (normalize Cursor payload, delegate to hooks/classify.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib.sh"

INPUT=$(cat)
NORMALIZED=$(orch_normalize_json "$INPUT")
SHAPED=$(printf '%s' "$NORMALIZED" | jq '.prompt = (.prompt // .user_message // "")')

OUT=$(printf '%s' "$SHAPED" | bash "$ORCH_ROOT/hooks/classify.sh" 2>/dev/null || true)
[ -z "$OUT" ] && exit 0

# Cursor beforeSubmitPrompt expects beforeSubmitPrompt event name in hookSpecificOutput.
printf '%s' "$OUT" | jq '
  if .hookSpecificOutput.hookEventName == "UserPromptSubmit" then
    .hookSpecificOutput.hookEventName = "beforeSubmitPrompt"
  else . end
'
exit 0
