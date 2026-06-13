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

# Reset per-turn edit counter for main session scope gate
SID_EARLY=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null)
[ -n "$SID_EARLY" ] && echo "0" > "/tmp/orch-edit-count-$SID_EARLY" 2>/dev/null

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

# --- ready-task flag: check/refresh every message, inject when tasks are waiting ---
if [ -n "$SID" ]; then
  FLAG_FILE="/tmp/orch-ready-$SID"
  NOW=$(date +%s)
  NEED_QUERY=0
  if [ ! -f "$FLAG_FILE" ]; then
    NEED_QUERY=1
  else
    FLAG_TS=$(python3 -c "import json; d=json.load(open('$FLAG_FILE')); print(d.get('ts',0))" 2>/dev/null || echo "0")
    AGE=$((NOW - FLAG_TS))
    if [ "$AGE" -gt 600 ]; then
      NEED_QUERY=1
    fi
  fi
  if [ "$NEED_QUERY" = "1" ]; then
    READY_RESP=$(curl -s --max-time 0.5 "localhost:$PORT/ready" 2>/dev/null)
    READY_COUNT=$(printf '%s' "$READY_RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("ready",[])))' 2>/dev/null || echo "0")
    if [ "$READY_COUNT" -gt 0 ] 2>/dev/null; then
      LABELS=$(printf '%s' "$READY_RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin)
labels = [t.get("label", t.get("key","?")) for t in d.get("ready", [])]
print(json.dumps(labels))
' 2>/dev/null || echo "[]")
      python3 -c "import json; json.dump({'ts': $NOW, 'count': $READY_COUNT, 'labels': $LABELS}, open('$FLAG_FILE','w'))" 2>/dev/null
    else
      rm -f "$FLAG_FILE"
    fi
  fi
fi

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
# main_model: complexity<0.4 AND abstain -> sonnet-4.6; complexity>0.7 OR inject -> fable-5; else -> opus-4.8
MAIN_MODEL="claude-opus-4-8"
COMPLEXITY_LT04=$(python3 -c "exit(0 if float('${COMPLEXITY}') < 0.4 else 1)" 2>/dev/null && echo "yes" || echo "no")
COMPLEXITY_GT07=$(python3 -c "exit(0 if float('${COMPLEXITY}') > 0.7 else 1)" 2>/dev/null && echo "yes" || echo "no")
if [ "$COMPLEXITY_LT04" = "yes" ] && [ "${GATE_DECISION}" = "abstain" ]; then
  MAIN_MODEL="claude-sonnet-4-6"
elif [ "$COMPLEXITY_GT07" = "yes" ] || [ "${GATE_DECISION}" = "inject" ]; then
  MAIN_MODEL="claude-fable-5"
fi
case "$MAIN_MODEL" in
  claude-fable-5)  SUB_MODEL="claude-opus-4-8 (fast)" ;;
  claude-opus-4-8) SUB_MODEL="claude-sonnet-4-6" ;;
  *)               SUB_MODEL="claude-sonnet-4-6" ;;
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

# Check if the active claimed task has a metric spec (self-learning mode hint)
if [ -n "$SID" ]; then
  CLAIM_RESP=$(curl -s --max-time 0.6 "localhost:$PORT/active-claim?session=$SID" 2>/dev/null)
  CLAIM_TASK_KEY=$(printf '%s' "$CLAIM_RESP" | jq -r '.task_key // empty' 2>/dev/null)
  if [ -n "$CLAIM_TASK_KEY" ]; then
    TASK_DETAIL=$(curl -s --max-time 0.6 "localhost:$PORT/task/detail?key=$CLAIM_TASK_KEY" 2>/dev/null)
    HAS_METRIC=$(printf '%s' "$TASK_DETAIL" | jq -e '.task.metric != null' >/dev/null 2>&1 && echo "yes" || echo "no")
    if [ "$HAS_METRIC" = "yes" ]; then
      CTX="${CTX:+$CTX
}[Self-learning mode] This task has a metric spec. You must: (1) call branch_task before editing, (2) measure baseline before changes, (3) follow branch→implement→measure→judge loop."
    fi
  fi
fi

# Inject ready-task context when flag file exists (first time only; suppress while busy)
if [ -n "$SID" ]; then
  FLAG_FILE="/tmp/orch-ready-$SID"
  BUSY_FILE="/tmp/orch-busy-$SID"
  # Determine if this is an autonomous loop tick (re-surface on wakeup turns)
  IS_LOOP_TICK=0
  if printf '%s' "$PROMPT" | grep -qiE '(Autonomous loop tick|autonomous-loop-dynamic)'; then
    IS_LOOP_TICK=1
    rm -f "$BUSY_FILE"
  fi
  # If flag file was deleted (tasks dispatched or no more ready tasks), clear busy marker too
  if [ ! -f "$FLAG_FILE" ]; then
    rm -f "$BUSY_FILE"
  fi
  if [ -f "$FLAG_FILE" ] && [ ! -f "$BUSY_FILE" ]; then
    READY_INFO=$(python3 -c "
import json, sys
try:
    d = json.load(open('$FLAG_FILE'))
    count = d.get('count', 0)
    labels = d.get('labels', [])
    label_str = ', '.join(labels)
    print(f\"{count}|{label_str}\")
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$READY_INFO" ]; then
      READY_N=$(printf '%s' "$READY_INFO" | cut -d'|' -f1)
      READY_LABELS=$(printf '%s' "$READY_INFO" | cut -d'|' -f2-)
      FLAG_TS=$(python3 -c "import json; d=json.load(open('$FLAG_FILE')); print(d.get('ts',0))" 2>/dev/null || echo "0")
      CTX="${CTX:+$CTX
}[Orchestrator] ${READY_N} tasks ready: [${READY_LABELS}].
If you are working on something higher priority, use ScheduleWakeup(delaySeconds=7200, reason=\"idle heartbeat\", prompt=\"<<autonomous-loop-dynamic>>\") as a fallback.
If user accepts or 2hr wakeup fires with no user activity since flag was set (check flag ts=${FLAG_TS} vs now): call loop_control({action:\"start\", tokenBudget:80000, maxIterations:100, minPoll:30, maxPoll:300, batch:4, maxConcurrency:6}) then delete the flag file /tmp/orch-ready-$SID.
If loop already active: ScheduleWakeup(delaySeconds=270, reason=\"watching active loop\", prompt=\"<<autonomous-loop-dynamic>>\").
Never claim tasks directly — loop_control handles dispatch to subagents."
      # Mark busy so subsequent messages skip this nudge
      : > "$BUSY_FILE"
    fi
  fi
fi

# Standing gate reminder (always emitted)
CTX="${CTX:+$CTX
}[Orch gate] Claim only the task matching the work at hand — NEVER force-claim a task to unlock edits for unrelated work; create a new task instead. Force-claims are capped at 3 per task; over cap requires user approval on the dashboard."

# Always append ScheduleWakeup heartbeat instruction
CTX="${CTX:+$CTX
}[Orchestrator heartbeat] Call ScheduleWakeup(delaySeconds=7200, reason=\"idle heartbeat\", prompt=\"<<autonomous-loop-dynamic>>\") to keep this session alive for background work. On wakeup: check ready tasks + active loop via next_action. If BOTH are empty (nothing ready, no active loop) — do NOT reschedule. Let the loop end."

# Judge queue pressure nudge. Skipped entirely when ORCH_GATE_OFF=1 (bench sandbox must not be
# nudged into judge work — it would contaminate bench measurements). Fail-silent on curl error.
if [ "${ORCH_GATE_OFF:-0}" != "1" ]; then
  PRESSURE=$(curl -s --max-time 0.6 "localhost:${PORT}/judge/pressure" 2>/dev/null)
  if [ -n "$PRESSURE" ]; then
    NUDGE=$(printf '%s' "$PRESSURE" | jq -r '.nudge // false' 2>/dev/null)
    if [ "$NUDGE" = "true" ]; then
      JDEPTH=$(printf '%s' "$PRESSURE" | jq -r '.depth // 0' 2>/dev/null)
      JDUPS=$(printf '%s' "$PRESSURE" | jq -r '.dupClusters // 0' 2>/dev/null)
      JKEY=$(printf '%s' "$PRESSURE" | jq -r '.harness_task_key // "followup/harness-judge-drain"' 2>/dev/null)
      # Generate a short random suffix for the per-pass agent_id (ensures each hourly pass gets a
      # unique agent identity; complete_task after each pass resets the task to 'done' so the next
      # start_task sees no in_progress conflict regardless of suffix).
      JSUFFIX=$(head -c 4 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' | head -c 8 || echo "$(date +%s | tail -c 8)")
      CTX="${CTX:+$CTX
}[Judge] backlog: ${JDEPTH} items (${JDUPS} dup-clusters) — dispatch ONE background self-learn-edge-judge subagent (model: sonnet — NOT haiku, verdict discrimination degrades; budget 20) this turn; do not block the user's request on it. The subagent MUST: (1) call mcp__orchestrator-graph__start_task with task_key=\"${JKEY}\" and agent_id=\"judge-drain-${JSUFFIX}\" BEFORE judging; (2) call mcp__orchestrator-graph__complete_task with the same task_key and agent_id, and a summary including the count of items judged, AFTER finishing."
    fi
  fi
fi

# Grader queue pressure nudge. Skipped entirely when ORCH_GATE_OFF=1 (bench sandbox must not be
# nudged into label work — it would contaminate bench measurements). Fail-silent on curl error.
if [ "${ORCH_GATE_OFF:-0}" != "1" ]; then
  LABEL_PRESSURE=$(curl -s --max-time 0.6 "localhost:${PORT}/label/pressure" 2>/dev/null)
  if [ -n "$LABEL_PRESSURE" ]; then
    LABEL_NUDGE=$(printf '%s' "$LABEL_PRESSURE" | jq -r '.nudge // false' 2>/dev/null)
    if [ "$LABEL_NUDGE" = "true" ]; then
      LDEPTH=$(printf '%s' "$LABEL_PRESSURE" | jq -r '.depth // 0' 2>/dev/null)
      LKEY=$(printf '%s' "$LABEL_PRESSURE" | jq -r '.harness_task_key // "followup/harness-label-drain"' 2>/dev/null)
      # Generate a short random suffix for the per-pass agent_id (ensures each hourly pass gets a
      # unique agent identity; complete_task after each pass resets the task to 'done' so the next
      # start_task sees no in_progress conflict regardless of suffix).
      JSUFFIX=$(head -c 4 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' | head -c 8 || echo "$(date +%s | tail -c 8)")
      CTX="${CTX:+$CTX
}[Grader] backlog: ${LDEPTH} gradable journal rows — dispatch ONE background subagent (cheap/default model; this is a deterministic script run, no LLM reasoning needed) this turn; do not block the user's request on it. The subagent MUST: (1) call mcp__orchestrator-graph__start_task with task_key=\"${LKEY}\" and agent_id=\"label-drain-${JSUFFIX}\" BEFORE running; (2) run \`node scripts/gate-label.js\` and read the coverage summary from its stdout; (3) call mcp__orchestrator-graph__complete_task with the same task_key and agent_id, and a summary including the newly-labeled count from the script's coverage output, AFTER finishing."
    fi
  fi
fi

[ -z "$CTX" ] && exit 0
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
