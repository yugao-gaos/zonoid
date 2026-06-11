#!/bin/bash
# run-trial.sh — run a single held-out bench trial and optionally wire a KB note to the trial's
# task in the orchestrator graph so future related tasks inherit it via context edges (no cosine
# discovery needed).
#
# Usage:
#   bash bench/heldout/run-trial.sh \
#     --candidate locale-sum \
#     --arm off \
#     --trial 0 \
#     [--consult search] \
#     [--model opus] \
#     [--context-note note-mqa1dtbxirw]
#
# Flags:
#   --candidate <name>       Candidate key (matches CANDIDATES in bench-heldout.js)
#   --arm <on|off>           Graph access arm
#   --trial <int>            Trial index (0-based)
#   --consult <mode>         Consult mode for ON arm (default: search)
#   --model <model>          Claude model (default: opus)
#   --context-note <key>     Note key to wire as context edge to the trial's task node.
#                            When provided, posts POST /overlay/edge to the daemon after the trial
#                            completes, creating edge: note:<key> -> ht-<candidate>-<arm>-<trial>
#                            (kind=context, weight=1.0). Idempotent — safe to re-run.
#
set -uo pipefail

REPO="${ZONOID_REPO:-$HOME/.claude/orchestrator}"
DAEMON="${ZONOID_DAEMON:-http://localhost:8787}"
WORKSPACE="${ORCH_WORKSPACE:-$REPO}"

CANDIDATE=""
ARM=""
TRIAL="0"
CONSULT=""
MODEL="opus"
CONTEXT_NOTE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate)    CANDIDATE="$2"; shift 2 ;;
    --arm)          ARM="$2"; shift 2 ;;
    --trial)        TRIAL="$2"; shift 2 ;;
    --consult)      CONSULT="$2"; shift 2 ;;
    --model)        MODEL="$2"; shift 2 ;;
    --context-note) CONTEXT_NOTE="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$CANDIDATE" || -z "$ARM" ]]; then
  echo "usage: run-trial.sh --candidate <name> --arm on|off --trial <int> [--consult <mode>] [--model <model>] [--context-note <key>]" >&2
  exit 2
fi

# Build the bench-heldout.js argument list
ARGS=(--candidate "$CANDIDATE" --arm "$ARM" --trial "$TRIAL" --model "$MODEL")
if [[ -n "$CONSULT" ]]; then
  ARGS+=(--consult "$CONSULT")
fi

# Run the trial
node "$REPO/scripts/bench-heldout.js" "${ARGS[@]}"

# Wire the context note to the trial's task node if --context-note was supplied
if [[ -n "$CONTEXT_NOTE" ]]; then
  ARM_LABEL="$ARM"
  if [[ "$ARM" == "on" && -n "$CONSULT" ]]; then
    ARM_LABEL="$CONSULT"
  fi
  TRIAL_TASK_KEY="ht-${CANDIDATE}-${ARM_LABEL}-${TRIAL}"
  echo "[run-trial] wiring note:${CONTEXT_NOTE} -> ${TRIAL_TASK_KEY} (context edge)" >&2
  curl -s -X POST "${DAEMON}/overlay/edge" \
    -H 'Content-Type: application/json' \
    -d "{\"ws\":\"${WORKSPACE}\",\"from\":\"note:${CONTEXT_NOTE}\",\"to\":\"${TRIAL_TASK_KEY}\",\"kind\":\"context\",\"weight\":1.0}" \
    | (grep -q '"ok":true' && echo "[run-trial] edge wired ok" || echo "[run-trial] edge wire response: $(cat)") >&2 || true
fi
