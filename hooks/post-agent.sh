#!/bin/bash
# PostToolUse(Agent|Task): when a subagent returns, nudge the main agent with the set of
# newly-ready tasks so it can advance immediately (accelerates the heartbeat; does NOT
# advance the loop budget — uses the read-only /ready). Gated on the per-conversation opt-out (default on).
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -f "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions/$SID.off" ] && exit 0  # gate: skip only if opted out (default on)

READY=$(curl -s --max-time 0.5 "localhost:$PORT/ready?session=$SID" 2>/dev/null | jq -r '[.ready[]?.label] | join(", ")' 2>/dev/null)
[ -z "$READY" ] && exit 0

CTX="[Orchestrator] Downstream tasks now ready (unblocked by work you just dispatched): $READY. Dispatch them as background subagents (pass their TASK_IDs) before reporting to the user."
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
