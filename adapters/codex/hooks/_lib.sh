#!/usr/bin/env bash
# Shared helpers for Codex hook relays. Codex PreToolUse fail-closed rules: only emit
# supported fields (permissionDecision, permissionDecisionReason, hookEventName,
# systemMessage, additionalContext). Never emit continue/stopReason/suppressOutput on PreToolUse.
set -euo pipefail

codex_deny_pretooluse() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  printf '%s\n' "$reason" >&2
}

# Run a Claude hook that blocks via exit 2; translate to Codex permissionDecision deny JSON.
relay_claude_gate() {
  local script="$1"
  local input="$2"
  local err
  err=$(mktemp)
  if printf '%s' "$input" | bash "$script" 2>"$err" >/dev/null; then
    rm -f "$err"
    return 0
  else
    local code=$?
  fi
  if [ "$code" -eq 2 ]; then
    local reason
    reason=$(tr -d '\0' <"$err" | sed '/^$/d' | tail -1)
    [ -z "$reason" ] && reason="blocked by orchestrator gate"
    codex_deny_pretooluse "$reason"
    rm -f "$err"
    return 0
  fi
  rm -f "$err"
  return "$code"
}

codex_continue_json() {
  jq -n '{continue: true}'
}
