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
# Build the POST body with jq (already a hard dependency of this hook) rather than python3, which
# is not present on every platform — notably the Windows Store 'python3' is a non-executing stub,
# which would yield an empty body and drop the auto-mode signal.
BODY=$(jq -nc \
  --arg prompt "$PROMPT" \
  --arg session_id "$SESSION_ID" \
  --arg permission_mode "$PERMISSION_MODE" \
  '{prompt: $prompt}
   + (if $session_id != "" then {session_id: $session_id} else {} end)
   + (if $permission_mode != "" then {permission_mode: $permission_mode} else {} end)
   + (if env.ORCH_AUTO_LOOP == "1" then {auto_mode: true} else {} end)
   + (if env.ORCH_GATE_OFF == "1" then {orch_gate_off: true} else {} end)')

RESP=$(curl -s --max-time 2 -XPOST "localhost:$PORT/classify" \
  -H 'content-type: application/json' \
  -d "$BODY" 2>/dev/null)

CTX=$(printf '%s' "$RESP" | jq -r '.additional_context // empty' 2>/dev/null)
[ -z "$CTX" ] && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
