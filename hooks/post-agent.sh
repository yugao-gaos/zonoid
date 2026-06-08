#!/bin/bash
# PostToolUse(Agent|Task): when a subagent returns, nudge the main agent with the set of
# newly-ready tasks so it can advance immediately (accelerates the heartbeat; does NOT
# advance the loop budget — uses the read-only /ready). Gated on the per-conversation opt-out (default on).
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -f "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions/$SID.off" ] && exit 0  # gate: skip only if opted out (default on)

READY=$(curl -s --max-time 0.5 "localhost:$PORT/ready" 2>/dev/null | jq -r '[.ready[]?.label] | join(", ")' 2>/dev/null)
[ -z "$READY" ] && exit 0

CTX="[Orchestrator] Tasks now ready to start: $READY. Spawn them (with their TASK_IDs) if appropriate, or let the heartbeat handle it."
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}' "$(printf '%s' "$CTX" | jq -Rs .)"
exit 0
