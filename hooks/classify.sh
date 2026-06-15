#!/bin/bash
# UserPromptSubmit: (a) per-conversation enable/disable toggle, (b) when enabled, classify
# the prompt via POST /classify and inject returned context.
# Default is ON; opt out with 'orch off' (re-enable with "orch on").
# Always exits 0 fast; daemon POST is best-effort.
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // .conversation_id // .sessionId // empty')
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty')
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
MARK="$DIR/$SID.off"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=orch-gate-trivial.sh
. "$HOOK_DIR/orch-gate-trivial.sh"
[ -n "$SID" ] && reset_trivial_counter "$SID"

# --- toggle directives (match "orch on/off", optionally @-prefixed, as the whole intent) ---
low=$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]')
if printf '%s' "$low" | grep -Eq '(^|[[:space:]])@?orch[[:space:]]+on([[:space:]]|$|[[:punct:]])'; then
  rm -f "$MARK"
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[Orchestrator] Enabled (default) for this conversation. Prompts will be auto-routed and tasks tracked in the graph."}}'
  exit 0
fi
if printf '%s' "$low" | grep -Eq '(^|[[:space:]])@?orch[[:space:]]+off([[:space:]]|$|[[:punct:]])'; then
  mkdir -p "$DIR"; : > "$MARK"
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[Orchestrator] Disabled for this conversation."}}'
  exit 0
fi

# --- gate: do nothing if this conversation has opted out (default is on) ---
[ -f "$MARK" ] && exit 0

# --- relay to daemon POST /classify ---
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .conversation_id // .sessionId // empty' 2>/dev/null)
# Auto-mode signal: Claude Code's UserPromptSubmit payload carries permission_mode
# (default|acceptEdits|bypassPermissions|plan). Forward it so the daemon can enforce loop-default-on
# in auto-accept modes. ORCH_AUTO_LOOP=1 is an explicit env fallback for harnesses whose payload
# lacks permission_mode.
PERMISSION_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // .permissionMode // empty' 2>/dev/null)
BODY=$(python3 -c "
import json, sys, os
prompt = sys.argv[1]
session_id = sys.argv[2] or None
permission_mode = sys.argv[3] or None
body = {'prompt': prompt}
if session_id:
    body['session_id'] = session_id
if permission_mode:
    body['permission_mode'] = permission_mode
if os.environ.get('ORCH_AUTO_LOOP') == '1':
    body['auto_mode'] = True
if os.environ.get('ORCH_GATE_OFF') == '1':
    body['orch_gate_off'] = True
print(json.dumps(body))
" "$PROMPT" "$SESSION_ID" "$PERMISSION_MODE")

RESP=$(curl -s --max-time 2 -XPOST "localhost:$PORT/classify" \
  -H 'content-type: application/json' \
  -d "$BODY" 2>/dev/null)

CTX=$(printf '%s' "$RESP" | jq -r '.additional_context // empty' 2>/dev/null)
[ -z "$CTX" ] && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
