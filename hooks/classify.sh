#!/bin/bash
# UserPromptSubmit: (a) per-conversation enable/disable toggle, (b) when enabled, classify
# the prompt (solo/workflow/team/loop), log the decision to the daemon, and inject routing steer.
# Also calls /context-classify for rag/dag/complexity signals and model recommendation.
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
loop_sig = ["keep running","until","watch","monitor","retry","each time","whenever","poll"]
def hit(s): return [x.strip() for x in s if x in low]
th, wh, lh = hit(team_sig), hit(wf_sig), hit(loop_sig)
list_shaped = low.count(",")>=3 or len(re.findall(r"\b\d+[\.\)]", prompt))>=3
multi_step = words>=40 and low.count(" and ")>=2
if lh: decision="loop"; reason="iterative/loop signals: "+", ".join(lh[:4])
elif th: decision="team"; reason="comparison/perspective signals: "+", ".join(th[:4])
elif wh or list_shaped or multi_step:
    decision="workflow"; bits=wh[:4]+(["list-shaped"] if list_shaped else [])+(["long multi-step"] if multi_step else [])
    reason="parallelizable signals: "+", ".join(bits) if bits else "parallelizable structure"
else: decision="solo"; reason="single-focus task"
print(json.dumps({"decision":decision,"reason":reason,"prompt":prompt[:280]}))
')
DECISION=$(printf '%s' "$RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["decision"])' 2>/dev/null)
[ -z "$DECISION" ] && exit 0
curl -s --max-time 0.5 -XPOST "localhost:$PORT/route" -H 'content-type: application/json' -d "$RESULT" >/dev/null 2>&1

# --- multi-signal classifier: call daemon for rag/dag/complexity/gate signals ---
CLASSIFY_RESP=$(printf '%s' "$PROMPT" | python3 -c "
import sys, json
p = sys.stdin.read().strip()
print(json.dumps({'prompt': p}))
" | curl -s --max-time 1.5 -XPOST "localhost:$PORT/context-classify" \
    -H 'content-type: application/json' -d @- 2>/dev/null)

GATE_DECISION=$(printf '%s' "$CLASSIFY_RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("gate_decision","abstain"))' 2>/dev/null || echo "abstain")
COMPLEXITY=$(printf '%s' "$CLASSIFY_RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("complexity",0.5))' 2>/dev/null || echo "0.5")

# --- model selection ---
# main_model: complexity<0.4 AND abstain -> haiku; complexity>0.7 OR inject -> opus; else -> sonnet
MAIN_MODEL="sonnet"
COMPLEXITY_LT04=$(python3 -c "exit(0 if float('${COMPLEXITY}') < 0.4 else 1)" 2>/dev/null && echo "yes" || echo "no")
COMPLEXITY_GT07=$(python3 -c "exit(0 if float('${COMPLEXITY}') > 0.7 else 1)" 2>/dev/null && echo "yes" || echo "no")
if [ "$COMPLEXITY_LT04" = "yes" ] && [ "${GATE_DECISION}" = "abstain" ]; then
  MAIN_MODEL="haiku"
elif [ "$COMPLEXITY_GT07" = "yes" ] || [ "${GATE_DECISION}" = "inject" ]; then
  MAIN_MODEL="opus"
fi
case "$MAIN_MODEL" in
  opus)   SUB_MODEL="sonnet" ;;
  sonnet) SUB_MODEL="haiku" ;;
  *)      SUB_MODEL="haiku" ;;
esac

# --- build additionalContext ---
CTX=""

# Route steer based on heuristic decision (loop is new; others unchanged)
case "$DECISION" in
  loop)
    CTX="[Orchestrator router] This task is iterative/convergent. Use the loop skill or a run-test-fix Agent loop rather than a one-shot workflow."
    ;;
  workflow)
    CTX="[Orchestrator router] This task looks parallelizable. Strongly prefer invoking the parallel-orchestrate skill, which decomposes the work and runs it through the Workflow tool. If the task is genuinely linear, you may proceed solo."
    ;;
  team)
    CTX="[Orchestrator router] This task benefits from multiple independent perspectives. Consider an agent team (one teammate per angle), or if Agent Teams is not enabled, fall back to the parallel-orchestrate skill (Workflow). Declare dependencies where one angle needs another's output."
    ;;
esac

# Append model recommendation
MODEL_CTX="[Model routing] Recommended: main=${MAIN_MODEL}, subagent=${SUB_MODEL} (complexity=${COMPLEXITY}, gate=${GATE_DECISION})"
CTX="${CTX:+$CTX
}${MODEL_CTX}"

# Append context injection based on gate_decision
case "${GATE_DECISION}" in
  inject)
    NOTE_SUMMARIES=$(printf '%s' "$CLASSIFY_RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin)
notes = d.get("top_notes", [])
if not notes: sys.exit(0)
lines = []
for n in notes[:5]:
    title = n.get("title","(untitled)")
    summary = n.get("summary","")
    lines.append(f"- {title}: {summary}")
print("\n".join(lines))
' 2>/dev/null)
    if [ -n "$NOTE_SUMMARIES" ]; then
      CTX="${CTX}
[Graph context] Relevant prior knowledge found:
${NOTE_SUMMARIES}"
    fi
    ;;
  scaffold)
    SCAFFOLD_LIST=$(printf '%s' "$CLASSIFY_RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin)
keys = d.get("scaffold_keys", [])
lines = [f"- {x.get(\"key\",\"\")} : {x.get(\"label\",\"\")}" for x in keys[:3]]
print("\n".join(lines))
' 2>/dev/null)
    if [ -n "$SCAFFOLD_LIST" ]; then
      CTX="${CTX}
[Graph scaffold] Relevant prior work found — consult search_knowledge or these tasks before opening flat files:
${SCAFFOLD_LIST}"
    fi
    ;;
esac

[ -z "$CTX" ] && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
