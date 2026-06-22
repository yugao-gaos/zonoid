# Runtime Artifacts

Zonoid keeps durable graph data in each workspace's `.graph/` directory. Do not move `.graph/` or `.graph/daemon.port` into the runtime data directory.

Non-graph runtime artifacts live under the Zonoid runtime data dir:

1. `ORCH_DATA`, when set
2. `ZONOID_DATA`, when set
3. `CLAUDE_PLUGIN_DATA`, for legacy installs and tests
4. `~/.claude/orchestrator/.zonoid` by default

If `CLAUDE_PLUGIN_DATA` points at the Zonoid install/source root, runtime state is redirected to `<install>/.zonoid` so source files and daemon state do not share the same directory.

## Universal Runtime State

Universal daemon state lives directly under `.zonoid/`:

- `agents.json`, `loops.json`, `loop.json`, `workspaces.json`
- `overlay/`, `tasks/`, `worktrees/`, `wake/`, `scheduled-tasks/`
- `op-cache.json`, `tool-analytics.json`, `token`, `certs/`
- `embed.pid`, `rerank.pid`, `embed-server.log`, `rerank-server.log`, `*.sock`
- `models/`
- `sessions/` for hook opt-out markers and hook-local counters

Legacy root-level ignores remain in `.gitignore` so old installs can be cleaned up without accidentally committing runtime files.

Workspace-scoped wake registries remain graph state at `.graph/scheduled-wakeups.json`.
When `ORCH_WORKSPACE` is unavailable, the fallback registry is `<runtime-data-dir>/scheduled-wakeups.json`.

## Adapter Runtime State

Adapter-specific runtime state lives under `.zonoid/adapters/<adapter>/`.

- Codex Desktop session bridge: `.zonoid/adapters/codex/session-bridge.json`

Use adapter-specific paths for state that only one harness understands. Use universal paths only for daemon-owned state shared by all harnesses.
