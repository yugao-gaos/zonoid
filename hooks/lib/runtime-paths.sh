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

orch_migrate_legacy_data() {
  local source destination marker name failed=0
  source="$(orch_canonical_dir "$HOME/.claude/orchestrator/.zonoid")"
  destination="$(orch_canonical_dir "$(orch_external_data_dir)")"
  marker="$destination/.legacy-migration-incomplete"

  if [[ "$source" == "$destination" ]] || ! orch_has_authoritative_data "$source"; then
    printf '%s\n' "$destination"
    return 0
  fi
  if [[ ! -e "$marker" ]] && orch_has_authoritative_data "$destination"; then
    printf '%s\n' "$destination"
    return 0
  fi

  mkdir -p "$destination" || { printf '%s\n' "$source"; return 0; }
  if [[ ! -e "$marker" ]]; then
    : > "$marker" || { printf '%s\n' "$source"; return 0; }
  fi

  for name in overlay sessions wake scheduled-tasks tasks adapters models certs \
    agents.json loops.json loop.json workspaces.json token backend.env op-cache.json \
    tool-analytics.json scheduled-wakeups.json; do
    [[ -e "$source/$name" ]] || continue
    [[ -e "$destination/$name" ]] && continue
    cp -R -n "$source/$name" "$destination/$name" || failed=1
  done

  if [[ "$failed" -eq 0 ]]; then
    rm -f "$marker"
    printf '%s\n' "$destination"
  else
    printf '%s\n' "$source"
  fi
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
  orch_migrate_legacy_data
}
