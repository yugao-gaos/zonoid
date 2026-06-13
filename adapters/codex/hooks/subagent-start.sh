#!/usr/bin/env bash
# SubagentStart → POST /agent/start (delegates to Claude reference hook).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec bash "$ROOT/hooks/subagent-start.sh"
