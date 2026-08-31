# Runtime Artifacts

Zonoid keeps durable graph data in each workspace's `.graph/` directory. Do not move `.graph/` or `.graph/daemon.port` into the runtime data directory.

Non-graph runtime artifacts live under the Zonoid runtime data dir:

1. `ORCH_DATA`, when set
2. `ZONOID_DATA`, when set
3. `CLAUDE_PLUGIN_DATA`, for legacy installs and tests
4. The OS application-data directory by default:
   - macOS: `~/Library/Application Support/zonoid`
   - Linux: `${XDG_DATA_HOME:-~/.local/share}/zonoid`
   - Windows: `%APPDATA%/zonoid`

If `CLAUDE_PLUGIN_DATA` points at the Zonoid install/source root, runtime state is redirected to `<install>/.zonoid` so source files and daemon state do not share the same directory.

Daemon startup and CLI `init` are the only paths that migrate durable universal state from the live
legacy `~/.claude/orchestrator/.zonoid` directory. Generic runtime resolution and hook helpers are
read-only, so a client starting while the old daemon is still writing cannot begin a competing copy.
Before migration they select the authoritative legacy runtime; after a successful migration they
select the external runtime. While `.legacy-migration-incomplete` exists they continue selecting the
legacy runtime, and daemon startup or CLI `init` can safely resume the copy.

Migration never deletes the legacy source, never copies legacy worktrees, and never overwrites an
external directory that already contains authoritative universal state. An external directory that
contains only newly allocated worktrees is safe to fill; those worktrees are left untouched. If a
copy fails, the current daemon and clients continue using the legacy source.
Process-local PID, log, and socket artifacts are recreated instead of migrated.

## Universal Runtime State

Universal daemon state lives directly under the resolved runtime data directory:

- `agents.json`, `loops.json`, `loop.json`, `workspaces.json`
- `overlay/`, `tasks/`, `worktrees/`, `wake/`, `scheduled-tasks/`
- `op-cache.json`, `tool-analytics.json`, `token`, `certs/`
- `backend.env` for daemon-global hosted LLM backend credentials, such as `ZAI_API_KEY` or `OPENROUTER_API_KEY`
- `embed.pid`, `rerank.pid`, `embed-server.log`, `rerank-server.log`, `*.sock`
- `models/`
- `sessions/` for hook opt-out markers and hook-local counters

`backend.env` is intentionally daemon-global, not workspace-global. A single daemon serving many
projects reads the same hosted-backend credentials from the runtime data dir while each workspace
keeps only its selected provider/model in overlay config. Existing process environment variables
still win over values in `backend.env`.

Legacy root-level ignores remain in `.gitignore` so old installs can be cleaned up without accidentally committing runtime files.

Workspace-scoped wake registries remain graph state at `.graph/scheduled-wakeups.json`.
When `ORCH_WORKSPACE` is unavailable, the fallback registry is `<runtime-data-dir>/scheduled-wakeups.json`.
Each registry's shared wake host publishes its pid as `wake/wake-host-<hash-of-registry-path>.pid`.
It lives in `wake/` rather than beside the registry so every tool that can see the wake dir — the
bash adapter's `cancel` included — can recognize a host pid and refuse to kill it
(see [schedule-wakeup.md](./schedule-wakeup.md)).

## Adapter Runtime State

Adapter-specific runtime state lives under `<runtime-data-dir>/adapters/<adapter>/`.

- Codex Desktop session bridge: `<runtime-data-dir>/adapters/codex/session-bridge.json`

Use adapter-specific paths for state that only one harness understands. Use universal paths only for daemon-owned state shared by all harnesses.
