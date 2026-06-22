#!/bin/bash
# Shared helpers for Cursor → Zonoid daemon relays.
# Sourced by thin adapter scripts; not executed directly.

# Install root: zonoid repo or ~/.claude/orchestrator after `zonoid init`.
ORCH_ROOT="${ZONOID_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/orchestrator}}"
PORT="${ORCH_PORT:-8787}"
CURSOR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../hooks/lib/runtime-paths.sh
. "$CURSOR_LIB_DIR/../../hooks/lib/runtime-paths.sh"
DATA_DIR="$(orch_data_dir)"

# Extract session id from Claude or Cursor hook JSON (stdin or argument).
orch_session_id() {
  local input="${1:-}"
  if [ -z "$input" ]; then input=$(cat); fi
  printf '%s' "$input" | jq -r '.session_id // .conversation_id // .sessionId // empty'
}

# First workspace root from Cursor payload, else cwd / env.
orch_workspace() {
  local input="${1:-}"
  if [ -z "$input" ]; then input=$(cat); fi
  local ws
  ws=$(printf '%s' "$input" | jq -r '.cwd // .workspace_roots[0] // empty')
  if [ -n "$ws" ]; then
    printf '%s' "$ws"
    return
  fi
  printf '%s' "${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}"
}

# True when orchestrator is disabled for this session (orch off marker).
orch_session_off() {
  local sid="$1"
  [ -z "$sid" ] && return 1
  [ -f "$DATA_DIR/sessions/$sid.off" ]
}

# Normalize Cursor / third-party payloads to Claude-shaped JSON for shared hooks.
orch_normalize_json() {
  local input="$1"
  printf '%s' "$input" | jq '
    .session_id = (.session_id // .conversation_id // .sessionId // "")
    | .cwd = (.cwd // .workspace_roots[0] // "")
    | .transcript_path = (.transcript_path // "")
  '
}

# Map preToolUse(Shell) or beforeShellExecution to orch-gate-bash PreToolUse shape.
orch_to_bash_gate_json() {
  local input="$1"
  if printf '%s' "$input" | jq -e '.tool_input.command' >/dev/null 2>&1; then
    orch_normalize_json "$input"
    return
  fi
  printf '%s' "$input" | jq '
    {
      session_id: (.session_id // .conversation_id // .sessionId // empty),
      tool_input: { command: (.command // "") }
    }
  '
}

# Map Cursor subagentStart to Claude subagent-start shape.
orch_to_subagent_start_json() {
  local input="$1"
  printf '%s' "$input" | jq '
    {
      session_id: (.parent_conversation_id // .session_id // .conversation_id // .sessionId // empty),
      agent_id: (.subagent_id // .agent_id // empty),
      agent_type: (.subagent_type // .agent_type // "agent"),
      transcript_path: (.agent_transcript_path // .transcript_path // empty)
    }
  '
}

# Map Cursor subagentStop to Claude subagent-stop shape.
orch_to_subagent_stop_json() {
  local input="$1"
  printf '%s' "$input" | jq '
    {
      session_id: (.parent_conversation_id // .conversation_id // .session_id // .sessionId // empty),
      agent_id: (.subagent_id // .agent_id // empty)
    }
  '
}

# Fail-open GET helper; prints body or empty on failure.
orch_curl_get() {
  curl -s --max-time "${1:-0.6}" "localhost:$PORT/${2}" 2>/dev/null
}

# Fail-open POST helper (stdout discarded).
orch_curl_post() {
  curl -s --max-time "${1:-0.5}" -XPOST "localhost:$PORT/${2}" \
    -H 'content-type: application/json' -d "$3" >/dev/null 2>&1
}
