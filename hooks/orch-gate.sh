#!/bin/bash
# PreToolUse(Write|Edit) GATE: refuse inline file edits unless THIS conversation has a task
# claimed in_progress in the orchestrator graph (enforces "file a task + start_task before
# editing"). Exit 2 = deny (blocks the tool call in this harness); exit 0 = allow.
#
# Escape hatch: export ORCH_GATE_OFF=1 to always allow.
# Default-on: like the other orchestrator hooks, the gate is active by default. A conversation
#   opts out with 'orch off' (drops sessions/<id>.off). If that marker is present, exit 0.
# Fail-open: if the daemon is unreachable we allow (exit 0) rather than bricking edits when the
#   daemon is down. We deny only on a definitive "no claim for this session".
PORT="${ORCH_PORT:-8787}"

[ "$ORCH_GATE_OFF" = "1" ] && exit 0   # escape hatch

INPUT=$(cat)

# Path allowlist: harness plumbing that is NOT "substantive multi-step work" and must never be
# gated (memory writes, config edits, scratch). Orchestrator SOURCE (~/.claude/orchestrator/**)
# is deliberately NOT exempted -- that's the substantive work the gate exists to route.
FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
case "$FP" in
  */.claude/projects/*/memory/*)         exit 0 ;;  # auto-memory store (incl. MEMORY.md)
  */.claude/settings.json|*/.claude/settings.local.json) exit 0 ;;  # harness settings
  */.claude/keybindings.json|*/.claude/launch.json)      exit 0 ;;  # harness config
  */.mcp.json)                           exit 0 ;;  # MCP server config
  */CLAUDE.md)                           exit 0 ;;  # instruction file
  /tmp/*|/private/tmp/*)                 exit 0 ;;  # scratch / task output
esac

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0                # no session id -> can't correlate; don't block
DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/sessions"
[ -f "$DIR/$SID.off" ] && exit 0       # skip only when orchestrator is disabled for this conversation (default on)

RESP=$(curl -s --max-time 0.6 "localhost:$PORT/active-claim?session=$SID" 2>/dev/null)
[ -z "$RESP" ] && exit 0               # daemon unreachable -> fail open

if printf '%s' "$RESP" | jq -e '.claimed == true' >/dev/null 2>&1; then
  exit 0                               # an in_progress task is claimed for this session -> allow
fi

echo "orch-gate: file a task (TaskCreate) and start_task before editing; set ORCH_GATE_OFF=1 to bypass" >&2
exit 2
