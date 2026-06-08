#!/bin/bash
# UserPromptSubmit: (a) per-conversation enable/disable toggle, (b) when enabled, classify
# the prompt (solo/workflow/team), log the decision to the daemon, and inject routing steer.
# Default is ON; opt out with 'orch off' (re-enable with "orch on").
# Always exits 0 fast; daemon POST is best-effort.
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty')
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
MARK="$DIR/$SID.off"

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

# --- classify (heuristic; instant, offline) ---
RESULT=$(printf '%s' "$INPUT" | python3 -c '
import sys, json, re
try: data = json.load(sys.stdin)
except Exception: data = {}
prompt = (data.get("prompt") or "").strip(); low = prompt.lower(); words = len(low.split())
team_sig = ["compare","perspective","perspectives","debate","pros and cons","devil\x27s advocate","critique","brainstorm","trade-off","tradeoff","different angles","weigh"," vs "," versus "]
wf_sig = ["all ","every ","each ","audit","refactor","migrate","across ","for each","sweep","every file","all files","entire codebase","throughout","rename all","update all"]
def hit(s): return [x.strip() for x in s if x in low]
th, wh = hit(team_sig), hit(wf_sig)
list_shaped = low.count(",")>=3 or len(re.findall(r"\b\d+[\.\)]", prompt))>=3
multi_step = words>=40 and low.count(" and ")>=2
if th: decision="team"; reason="comparison/perspective signals: "+", ".join(th[:4])
elif wh or list_shaped or multi_step:
    decision="workflow"; bits=wh[:4]+(["list-shaped"] if list_shaped else [])+(["long multi-step"] if multi_step else [])
    reason="parallelizable signals: "+", ".join(bits) if bits else "parallelizable structure"
else: decision="solo"; reason="single-focus task"
print(json.dumps({"decision":decision,"reason":reason,"prompt":prompt[:280]}))
')
DECISION=$(printf '%s' "$RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["decision"])' 2>/dev/null)
[ -z "$DECISION" ] && exit 0
curl -s --max-time 0.5 -XPOST "localhost:$PORT/route" -H 'content-type: application/json' -d "$RESULT" >/dev/null 2>&1

case "$DECISION" in
  workflow) CTX="[Orchestrator router] This task looks parallelizable. Strongly prefer invoking the parallel-orchestrate skill, which decomposes the work and runs it through the Workflow tool. If the task is genuinely linear, you may proceed solo." ;;
  team)     CTX="[Orchestrator router] This task benefits from multiple independent perspectives. Consider an agent team (one teammate per angle), or if Agent Teams is not enabled, fall back to the parallel-orchestrate skill (Workflow). Declare dependencies where one angle needs another's output." ;;
  *) exit 0 ;;
esac
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
