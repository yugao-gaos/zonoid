#!/bin/bash
# Shared trivial-patch allowance for unclaimed main/dispatcher sessions.
# Sourced by orch-gate.sh and orch-gate-bash.sh; counter reset in classify.sh.
TRIVIAL_MAX_LINES=20
TRIVIAL_MAX_CHARS=800
TRIVIAL_COUNTER_SUFFIX=".trivial-edit"

trivial_counter_path() {
  printf '%s/%s%s' "$DIR" "$1" "$TRIVIAL_COUNTER_SUFFIX"
}

reset_trivial_counter() {
  local sid="$1"
  [ -z "$sid" ] && return 0
  mkdir -p "$DIR" 2>/dev/null || true
  printf '0\n' > "$(trivial_counter_path "$sid")" 2>/dev/null || true
}

patch_within_limits() {
  local content="$1"
  local chars lines
  chars=$(printf '%s' "$content" | wc -c | tr -d ' ')
  lines=$(printf '%s' "$content" | awk 'END { print (NR == 0 ? 0 : NR) }')
  [ "$chars" -le "$TRIVIAL_MAX_CHARS" ] && [ "$lines" -le "$TRIVIAL_MAX_LINES" ]
}

dispatcher_children_json() {
  local sid="$1"
  curl -s --max-time 0.6 "localhost:$PORT/dispatcher/children?session=$sid" 2>/dev/null
}

has_inflight_workers() {
  local sid="$1"
  local resp
  resp=$(dispatcher_children_json "$sid")
  [ -n "$resp" ] && printf '%s' "$resp" | jq -e '(.children | length) > 0' >/dev/null 2>&1
}

trivial_attribution_ok() {
  local sid="$1"
  local resp
  TRIVIAL_ATTRIBUTION=""
  resp=$(dispatcher_children_json "$sid")
  [ -z "$resp" ] && return 1
  if printf '%s' "$resp" | jq -e '.needs_focus == true and ((.attribution // "") | length == 0)' >/dev/null 2>&1; then
    TRIVIAL_DENY_REASON="focus"
    return 1
  fi
  TRIVIAL_ATTRIBUTION=$(printf '%s' "$resp" | jq -r '.attribution // empty' 2>/dev/null)
  [ -n "$TRIVIAL_ATTRIBUTION" ]
}

report_dispatcher_edit() {
  local sid="$1" chars="$2" file="$3"
  [ -z "$sid" ] && return 0
  curl -s --max-time 0.6 -X POST "localhost:$PORT/usage/dispatcher-edit" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg ps "$sid" --arg tk "${TRIVIAL_ATTRIBUTION:-}" --arg f "${file:-}" --argjson c "${chars:-0}" \
      '{parent_session:$ps, task_key:($tk|if .=="" then null else . end), chars:$c, file:($f|if .=="" then null else . end)}')" \
    >/dev/null 2>&1 || true
}

try_trivial_main_allow() {
  local sid="$1" content="$2"
  TRIVIAL_DENY_REASON=""
  [ -z "$sid" ] && return 1
  if ! patch_within_limits "$content"; then return 1; fi
  if ! has_inflight_workers "$sid"; then TRIVIAL_DENY_REASON="no_workers"; return 1; fi
  if ! trivial_attribution_ok "$sid"; then
    [ -z "$TRIVIAL_DENY_REASON" ] && TRIVIAL_DENY_REASON="focus"
    return 1
  fi
  local cf count=0
  cf=$(trivial_counter_path "$sid")
  [ -f "$cf" ] && count=$(tr -d '[:space:]' < "$cf" 2>/dev/null || echo 0)
  [ -z "$count" ] && count=0
  if [ "$count" -ge 1 ]; then TRIVIAL_DENY_REASON="budget"; return 1; fi
  mkdir -p "$DIR" 2>/dev/null || true
  printf '1\n' > "$cf" 2>/dev/null || return 1
  return 0
}

main_session_deny_message() {
  case "${TRIVIAL_DENY_REASON:-}" in
    budget) printf 'orch-gate: trivial patch budget exhausted for this turn (1 allowed). Dispatch a subagent for further edits.\n' ;;
    no_workers) printf 'orch-gate: no in-flight workers. Dispatch a subagent (Agent tool) before editing.\n' ;;
    focus) printf 'orch-gate: multiple in-flight workers — set dispatcher focus (POST /overlay/dispatcher-focus) before trivial edits.\n' ;;
    *) printf 'orch-gate: no task claimed. Create a graph task then start_task, or dispatch a subagent (Agent tool).\n' ;;
  esac
}
