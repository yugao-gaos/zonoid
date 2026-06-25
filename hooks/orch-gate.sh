#!/bin/bash
# Compatibility entrypoint for harnesses that still invoke the POSIX hook path.
# Enforcement lives in orch-gate.js and hooks/lib/gate-policy.js.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HOOK_DIR/orch-gate.js"
