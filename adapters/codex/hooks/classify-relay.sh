#!/usr/bin/env bash
# UserPromptSubmit → classify relay (delegates to hooks/classify.sh; output is already
# Codex-compatible hookSpecificOutput for UserPromptSubmit).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec bash "$ROOT/hooks/classify.sh"
