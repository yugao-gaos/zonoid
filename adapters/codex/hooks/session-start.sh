#!/usr/bin/env bash
# SessionStart → boot daemon + POST /workspace (delegates to Claude reference hook).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec bash "$ROOT/hooks/start-daemon.sh"
