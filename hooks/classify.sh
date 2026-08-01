#!/bin/bash
# UserPromptSubmit: (a) per-conversation enable/disable toggle, (b) when enabled, classify
# the prompt via POST /classify and inject returned context.
# Default is ON; opt out with 'orch off' (re-enable with "orch on").
# Always exits 0 fast; daemon POST is best-effort.
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // .conversation_id // .sessionId // empty')
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty')
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/runtime-paths.sh
. "$HOOK_DIR/lib/runtime-paths.sh"
DIR="$(orch_data_dir)/sessions"
MARK="$DIR/$SID.off"
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

# --- 'orch auto' / 'orch auto off': atomic per-workspace full-autonomy toggle ---------------
# POST /config { auto } expands server-side to self_plan + automode + headless_driver, so this
# hook shares one code path with the dashboard toggle and curl. The daemon canonicalizes the
# passed cwd to its containing repo root. Check the 'off' form first — the bare 'orch auto'
# pattern also matches 'orch auto off'.
if printf '%s' "$low" | grep -Eq '(^|[[:space:]])@?orch[[:space:]]+auto([[:space:]]|$|[[:punct:]])'; then
  if printf '%s' "$low" | grep -Eq '(^|[[:space:]])@?orch[[:space:]]+auto[[:space:]]+off([[:space:]]|$|[[:punct:]])'; then
    AUTO=false
  else
    AUTO=true
  fi
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
  [ -z "$CWD" ] && CWD=$(pwd)
  AUTO_BODY=$(jq -nc --arg workspace "$CWD" --argjson auto "$AUTO" '{workspace: $workspace, auto: $auto}')
  AUTO_RESP=$(curl -s --max-time 5 -XPOST "http://127.0.0.1:$PORT/config" \
    -H 'content-type: application/json' \
    -d "$AUTO_BODY" 2>/dev/null)
  CFG=$(printf '%s' "$AUTO_RESP" | jq -c '.config // empty' 2>/dev/null)
  if [ -z "$CFG" ]; then
    MSG="[Orchestrator] orch auto toggle FAILED — daemon unreachable, config unchanged."
  else
    WSOUT=$(printf '%s' "$AUTO_RESP" | jq -r '.workspace // empty' 2>/dev/null)
    FLAGS="self_plan=$(printf '%s' "$CFG" | jq -r '.self_plan // false') automode=$(printf '%s' "$CFG" | jq -r '.automode // false') headless_driver=$(printf '%s' "$CFG" | jq -r '.headless_driver // false')"
    if [ "$AUTO" = true ]; then
      # Budget caps mirror lib/loop-autostart AUTOSTART_CONFIG and lib/headless-drain
      # HEADLESS_DRAIN_CONFIG (hooks/classify.js reads them live; bash cannot) — keep in sync.
      MSG="[Orchestrator] Full autonomy ON for ${WSOUT:-$CWD} ($FLAGS). The daemon now plans on a drained DAG (self_plan), executes spawn/plan/optimize + review verdicts headlessly (headless_driver), and auto-answers escalations + auto-merges approved attempts (automode). Budget caps: managed loop 5000000 tokens / 6250 iterations / batch 4 / 6 concurrent workers; headless drains 200000 tokens per daemon boot / 2 concurrent drain children. Disable with \"orch auto off\"."
    else
      MSG="[Orchestrator] Full autonomy OFF for ${WSOUT:-$CWD} ($FLAGS). Headless spawn/plan/review drains stand down; interactive dispatch resumes. Re-enable with \"orch auto\"."
    fi
  fi
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$(printf '%s' "$MSG" | jq -Rs .)"
  exit 0
fi

# --- gate: do nothing if this conversation has opted out (default is on) ---
[ -f "$MARK" ] && exit 0

# --- relay to daemon POST /classify ---
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .conversation_id // .sessionId // empty' 2>/dev/null)
# Auto-mode signal: adapters may pass neutral auto_mode/capabilities.auto_execute; Claude Code also
# carries permission_mode (default|acceptEdits|bypassPermissions|plan). ORCH_AUTO_LOOP=1 is an
# explicit env fallback for harnesses whose payload lacks an auto-execute signal.
PERMISSION_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // .permissionMode // empty' 2>/dev/null)
AUTO_MODE=$(printf '%s' "$INPUT" | jq -r '.auto_mode // .autoMode // empty' 2>/dev/null)
CAPABILITIES=$(printf '%s' "$INPUT" | jq -c '.capabilities // empty' 2>/dev/null)
# Build the POST body with jq (already a hard dependency of this hook) rather than python3, which
# is not present on every platform — notably the Windows Store 'python3' is a non-executing stub,
# which would yield an empty body and drop the auto-mode signal.
BODY=$(jq -nc \
  --arg prompt "$PROMPT" \
  --arg session_id "$SESSION_ID" \
  --arg permission_mode "$PERMISSION_MODE" \
  --arg auto_mode "$AUTO_MODE" \
  --argjson capabilities "${CAPABILITIES:-null}" \
  '{prompt: $prompt}
   + (if $session_id != "" then {session_id: $session_id} else {} end)
   + (if $permission_mode != "" then {permission_mode: $permission_mode} else {} end)
   + (if $auto_mode != "" then {auto_mode: $auto_mode} else {} end)
   + (if $capabilities != null then {capabilities: $capabilities} else {} end)
   + (if env.ORCH_AUTO_LOOP == "1" then {auto_loop_env: true} else {} end)
   + (if env.ORCH_GATE_OFF == "1" then {orch_gate_off: true} else {} end)')

RESP=$(curl -s --max-time 5 -XPOST "http://127.0.0.1:$PORT/classify" \
  -H 'content-type: application/json' \
  -d "$BODY" 2>/dev/null)

CTX=$(printf '%s' "$RESP" | jq -r '.additional_context // empty' 2>/dev/null)
[ -z "$CTX" ] && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
