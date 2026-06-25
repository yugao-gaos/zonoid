#!/usr/bin/env bash
# Shared ScheduleWakeup substrate: cancel prior wake for a session, arm a delayed re-prompt.
# Pidfiles live under the Zonoid runtime dir's wake/<session>.pid. On fire, prints:
#   ORCH_SCHEDULED_TASK {"delaySeconds":N,"reason":"...","prompt":"..."}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../hooks/lib/runtime-paths.sh
. "$SCRIPT_DIR/../../hooks/lib/runtime-paths.sh"
WAKE_DIR="$(orch_data_dir)/wake"

session_slug() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

pid_file() {
  echo "$WAKE_DIR/$(session_slug "$1").pid"
}

cmd_cancel() {
  local session="$1"
  local pf pid
  pf="$(pid_file "$session")"
  if [[ ! -f "$pf" ]]; then
    printf '%s\n' '{"ok":true,"canceled":false}'
    return 0
  fi
  pid="$(tr -d '[:space:]' <"$pf")"
  rm -f "$pf"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  printf '{"ok":true,"canceled":true,"pid":%s}\n' "${pid:-0}"
}

cmd_arm() {
  local session="$1" delay="$2" reason="$3" prompt="$4"
  if [[ -z "$session" ]]; then
    printf '%s\n' '{"ok":false,"error":"session required"}' >&2
    return 1
  fi
  cmd_cancel "$session" >/dev/null
  mkdir -p "$WAKE_DIR"
  local payload pf child_pid
  payload="$(node -e 'console.log(JSON.stringify({delaySeconds:Number(process.argv[1]),reason:process.argv[2],prompt:process.argv[3]}))' "$delay" "$reason" "$prompt")"
  (
    sleep "$delay"
    printf 'ORCH_SCHEDULED_TASK %s\n' "$payload"
  ) >>"$WAKE_DIR/$(session_slug "$session").fire" 2>/dev/null &
  child_pid=$!
  pf="$(pid_file "$session")"
  printf '%s' "$child_pid" >"${pf}.tmp.$$"
  mv "${pf}.tmp.$$" "$pf"
  printf '{"ok":true,"pid":%s,"delaySeconds":%s}\n' "$child_pid" "$delay"
}

usage() {
  printf '%s\n' '{"ok":false,"error":"usage: schedule-wakeup.sh cancel|arm <session> [delaySeconds reason prompt]"}' >&2
  exit 1
}

case "${1:-}" in
  cancel)
    [[ -n "${2:-}" ]] || usage
    cmd_cancel "$2"
    ;;
  arm)
    [[ -n "${2:-}" ]] || usage
    cmd_arm "$2" "${3:-0}" "${4:-}" "${5:-}"
    ;;
  *) usage ;;
esac
