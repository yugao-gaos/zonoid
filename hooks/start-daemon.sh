#!/bin/bash
# SessionStart: boot the daemon (idempotent, detached) and register the current workspace.
# Thin delegator to the Node port (start-daemon.js) so the cwd->repo resolution lives in ONE place
# (lib/workspace-registry repoRoot) instead of being re-implemented as a bash walk-up. The install
# wires the .js hooks for Claude Code anyway (bin/install.js hookCmd); this .sh exists only for the
# Cursor/Codex adapters and the test suite, which now share the same resolution by delegating.
# stdin (the hook input JSON) is piped straight through — start-daemon.js reads it via readInput().
DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/orchestrator}"
exec node "$DIR/hooks/start-daemon.js"
