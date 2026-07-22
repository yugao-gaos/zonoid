#!/usr/bin/env bash

orch_canonical_dir() {
  local dir="${1%/}"
  if [[ -d "$dir" ]]; then
    (
      cd -P "$dir" >/dev/null 2>&1 &&
      pwd -P
    ) || printf '%s\n' "$dir"
  else
    printf '%s\n' "$dir"
  fi
}

orch_external_data_dir() {
  case "$(uname -s)" in
    Darwin)
      printf '%s/Library/Application Support/zonoid\n' "$HOME"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if [[ -n "${APPDATA:-}" ]]; then
        printf '%s/zonoid\n' "${APPDATA%/}"
      else
        printf '%s/AppData/Roaming/zonoid\n' "$HOME"
      fi
      ;;
    *)
      if [[ -n "${XDG_DATA_HOME:-}" ]]; then
        printf '%s/zonoid\n' "${XDG_DATA_HOME%/}"
      else
        printf '%s/.local/share/zonoid\n' "$HOME"
      fi
      ;;
  esac
}

orch_has_live_data() {
  local dir="${1%/}"
  [[ -d "$dir/overlay" ]] ||
  [[ -d "$dir/sessions" ]] ||
  [[ -d "$dir/worktrees" ]] ||
  [[ -d "$dir/wake" ]] ||
  [[ -d "$dir/scheduled-tasks" ]] ||
  [[ -d "$dir/tasks" ]] ||
  [[ -d "$dir/adapters" ]] ||
  [[ -d "$dir/models" ]] ||
  [[ -d "$dir/certs" ]] ||
  [[ -f "$dir/agents.json" ]] ||
  [[ -f "$dir/loops.json" ]] ||
  [[ -f "$dir/loop.json" ]] ||
  [[ -f "$dir/workspaces.json" ]] ||
  [[ -f "$dir/token" ]] ||
  [[ -f "$dir/backend.env" ]] ||
  [[ -f "$dir/op-cache.json" ]] ||
  [[ -f "$dir/tool-analytics.json" ]] ||
  [[ -f "$dir/scheduled-wakeups.json" ]]
}

orch_has_authoritative_data() {
  local dir="${1%/}"
  [[ -d "$dir/overlay" ]] ||
  [[ -d "$dir/sessions" ]] ||
  [[ -d "$dir/wake" ]] ||
  [[ -d "$dir/scheduled-tasks" ]] ||
  [[ -d "$dir/tasks" ]] ||
  [[ -d "$dir/adapters" ]] ||
  [[ -d "$dir/models" ]] ||
  [[ -d "$dir/certs" ]] ||
  [[ -f "$dir/agents.json" ]] ||
  [[ -f "$dir/loops.json" ]] ||
  [[ -f "$dir/loop.json" ]] ||
  [[ -f "$dir/workspaces.json" ]] ||
  [[ -f "$dir/token" ]] ||
  [[ -f "$dir/backend.env" ]] ||
  [[ -f "$dir/op-cache.json" ]] ||
  [[ -f "$dir/tool-analytics.json" ]] ||
  [[ -f "$dir/scheduled-wakeups.json" ]]
}

orch_data_dir() {
  if [[ -n "${ORCH_DATA:-}" ]]; then
    orch_canonical_dir "$ORCH_DATA"
    return 0
  fi
  if [[ -n "${ZONOID_DATA:-}" ]]; then
    orch_canonical_dir "$ZONOID_DATA"
    return 0
  fi
  if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
    local legacy
    legacy="$(orch_canonical_dir "${CLAUDE_PLUGIN_DATA%/}")"
    if [[ -f "$legacy/daemon.js" && -f "$legacy/mcp-graph.js" && -f "$legacy/package.json" ]]; then
      printf '%s/.zonoid\n' "$legacy"
    else
      printf '%s\n' "$legacy"
    fi
    return 0
  fi
  local legacy_runtime external_runtime marker
  legacy_runtime="$(orch_canonical_dir "$HOME/.claude/orchestrator/.zonoid")"
  external_runtime="$(orch_canonical_dir "$(orch_external_data_dir)")"
  marker="$external_runtime/.legacy-migration-incomplete"

  if [[ -e "$marker" ]] && orch_has_authoritative_data "$legacy_runtime"; then
    printf '%s\n' "$legacy_runtime"
  elif orch_has_authoritative_data "$external_runtime"; then
    printf '%s\n' "$external_runtime"
  elif orch_has_authoritative_data "$legacy_runtime"; then
    printf '%s\n' "$legacy_runtime"
  else
    printf '%s\n' "$external_runtime"
  fi
}
