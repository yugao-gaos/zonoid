#!/usr/bin/env bash

orch_data_dir() {
  if [[ -n "${ORCH_DATA:-}" ]]; then
    printf '%s\n' "$ORCH_DATA"
    return 0
  fi
  if [[ -n "${ZONOID_DATA:-}" ]]; then
    printf '%s\n' "$ZONOID_DATA"
    return 0
  fi
  if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
    local legacy="${CLAUDE_PLUGIN_DATA%/}"
    if [[ -f "$legacy/daemon.js" && -f "$legacy/mcp-graph.js" && -f "$legacy/package.json" ]]; then
      printf '%s/.zonoid\n' "$legacy"
    else
      printf '%s\n' "$CLAUDE_PLUGIN_DATA"
    fi
    return 0
  fi
  printf '%s/.claude/orchestrator/.zonoid\n' "$HOME"
}
