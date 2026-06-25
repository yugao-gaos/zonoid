#!/usr/bin/env bash
# Stop → mark worker done (POST /agent/done when agent_id is known). Codex requires JSON stdout.
# CDX-3: also forward Codex token usage as `reported_usage` so the daemon's normalizeReported path
# (routes/exec.js) records a real (priced) cost slice instead of an EMPTY_USAGE stub. Usage is taken
# from the Stop-hook stdin if present, else swept from the latest ~/.codex/sessions rollout file
# (last token_count.total_token_usage, the cumulative-per-session counter). All extraction is
# best-effort — any jq/file failure degrades to an agent_id-only POST and never breaks the hook.
set -euo pipefail
PORT="${ORCH_PORT:-8787}"
INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty')
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../hooks/lib/runtime-paths.sh
. "$SCRIPT_DIR/../../../hooks/lib/runtime-paths.sh"
DIR="$(orch_data_dir)/sessions"
if [ -n "$SID" ] && [ -f "$DIR/$SID.off" ]; then
  # shellcheck source=adapters/codex/hooks/_lib.sh
  source "$SCRIPT_DIR/_lib.sh"
  codex_continue_json
  exit 0
fi

# --- Codex usage extraction → canonical reported_usage --------------------------------------------
# normalize_codex_usage <usage-json> : print {input_tokens,output_tokens,cache_read_input_tokens,model}
# from either shape (token_count total_token_usage OR turn.completed/response.done usage). Canonical
# convention: input_tokens = UNCACHED (gross input − cached); cache_read_input_tokens = cached subset.
normalize_codex_usage() {
  printf '%s' "$1" | jq -c '
    (.cached_input_tokens // .input_token_details.cached_tokens // .input_tokens_details.cached_tokens // 0) as $cached
    | { input_tokens: (((.input_tokens // 0) - $cached) | if . < 0 then 0 else . end),
        output_tokens: (.output_tokens // 0),
        cache_read_input_tokens: $cached,
        model: "gpt-5-codex" }' 2>/dev/null || true
}

REPORTED=""
# (1) Try the hook stdin: a usage block may ride directly, or under .token_count.info / .info.
STDIN_USAGE=$(printf '%s' "$INPUT" | jq -c '
  (.usage // .token_count.info.total_token_usage // .info.total_token_usage // .payload.info.total_token_usage // empty)' 2>/dev/null || true)
if [ -n "$STDIN_USAGE" ] && [ "$STDIN_USAGE" != "null" ]; then
  REPORTED=$(normalize_codex_usage "$STDIN_USAGE")
fi

# (2) Fall back to the latest rollout file: last token_count.total_token_usage wins (cumulative).
if [ -z "$REPORTED" ]; then
  CODEX_SESS="${CODEX_HOME:-$HOME/.codex}/sessions"
  if [ -d "$CODEX_SESS" ]; then
    ROLLOUT=$(node - "$CODEX_SESS" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
let best = null;
function walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, depth + 1);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      try {
        const mtimeMs = fs.statSync(full).mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) best = { file: full, mtimeMs };
      } catch {}
    }
  }
}
walk(root);
if (best) process.stdout.write(best.file);
NODE
)
    if [ -n "$ROLLOUT" ] && [ -f "$ROLLOUT" ]; then
      LAST_USAGE=$(jq -c 'select((.payload.type // .type) == "token_count")
        | .payload.info.total_token_usage // .info.total_token_usage // empty' "$ROLLOUT" 2>/dev/null \
        | tail -1 || true)
      if [ -n "$LAST_USAGE" ] && [ "$LAST_USAGE" != "null" ]; then
        REPORTED=$(normalize_codex_usage "$LAST_USAGE")
      fi
    fi
  fi
fi

if [ -n "$AGENT_ID" ]; then
  if [ -n "$REPORTED" ]; then
    BODY=$(jq -nc --arg a "$AGENT_ID" --argjson u "$REPORTED" '{agent_id:$a, reported_usage:$u}' 2>/dev/null \
      || printf '{"agent_id":"%s"}' "$AGENT_ID")
  else
    BODY=$(printf '{"agent_id":"%s"}' "$AGENT_ID")
  fi
  curl -s --max-time 0.5 -XPOST "localhost:$PORT/agent/done" \
    -H 'content-type: application/json' \
    -d "$BODY" >/dev/null 2>&1 || true
fi

# shellcheck source=adapters/codex/hooks/_lib.sh
source "$SCRIPT_DIR/_lib.sh"
codex_continue_json
exit 0
