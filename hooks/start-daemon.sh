#!/bin/bash
# SessionStart: boot the daemon (idempotent, detached, returns instantly) and register the
# current workspace so the graph reflects this project. Harmless if the conversation hasn't
# opted in — the daemon just runs; the gated hooks stay silent until "orch on".
PORT="${ORCH_PORT:-8787}"
DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/orchestrator}"
INPUT=$(cat 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
TX=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD="$PWD"

if ! curl -s --max-time 0.3 "localhost:$PORT/ping" >/dev/null 2>&1; then
  nohup node "$DIR/daemon.js" >/tmp/orch-daemon.log 2>&1 &
  disown
  for i in $(seq 1 30); do curl -s --max-time 0.2 "localhost:$PORT/ping" >/dev/null 2>&1 && break; sleep 0.1; done
fi
curl -s --max-time 0.5 -XPOST "localhost:$PORT/workspace" -H 'content-type: application/json' -d "{\"path\":\"$CWD\",\"transcript\":\"$TX\"}" >/dev/null 2>&1
exit 0
