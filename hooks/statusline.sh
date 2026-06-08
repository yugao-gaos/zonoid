#!/bin/bash
# Status line: latest routing decision + live subagent counts + web-view link.
# Reads daemon /state; degrades gracefully if the daemon is down.
PORT="${ORCH_PORT:-8787}"
STATE=$(curl -s --max-time 0.4 "localhost:$PORT/state" 2>/dev/null)
if [ -z "$STATE" ]; then
  printf '🕸 orchestrator: daemon down'
  exit 0
fi

read -r ROUTE RUNNING DONE TOTAL <<EOF
$(printf '%s' "$STATE" | jq -r '[.summary.lastRoute.decision // "—", (.summary.agents.running|tostring), (.summary.agents.done|tostring), (.summary.agents.total|tostring)] | join(" ")')
EOF

# OSC 8 clickable link to the web view (iTerm2/Kitty/WezTerm; harmless elsewhere).
LINK=$(printf '\033]8;;http://localhost:%s/graph\033\\graph\033]8;;\033\\' "$PORT")

ICON="·"
case "$ROUTE" in
  workflow) ICON="⚙" ;;
  team) ICON="👥" ;;
  solo) ICON="•" ;;
esac

printf '🕸 route %s %s · agents %s▶/%s✓ (%s) · %s' "$ICON" "$ROUTE" "$RUNNING" "$DONE" "$TOTAL" "$LINK"
exit 0
