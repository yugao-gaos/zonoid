# Setup guide

Manual setup steps until `npx @zonoid/cli init` exists. The plugin install path handles most of
this automatically — this doc is for contributors and manual installs.

## Prerequisites

- **Node.js >= 18**
- **jq** — used by all hook scripts (`brew install jq` / `apt install jq`)
- **curl** — used by hook scripts (pre-installed on most systems)

## Install

```sh
git clone https://github.com/yugao-gaos/zonoid ~/.claude/orchestrator
cd ~/.claude/orchestrator
npm install          # optional — enables MiniLM semantic search (~90MB)
```

The standard install path is `~/.claude/orchestrator`. Scripts use `ZONOID_REPO` if set.

## Register hooks (workspace)

Copy the settings sample into your workspace `.claude/` folder and substitute the install path:

```sh
INSTALL=$(realpath ~/.claude/orchestrator)
mkdir -p /path/to/your/workspace/.claude
sed "s|__INSTALL_DIR__|$INSTALL|g" \
  ~/.claude/orchestrator/.claude/settings.sample.json \
  > /path/to/your/workspace/.claude/settings.json
```

## Register MCP server (workspace)

Copy the MCP sample into your workspace root and substitute the install path:

```sh
INSTALL=$(realpath ~/.claude/orchestrator)
sed "s|__INSTALL_DIR__|$INSTALL|g" \
  ~/.claude/orchestrator/mcp.sample.json \
  > /path/to/your/workspace/.mcp.json
```

Commit `.mcp.json` so every Claude Code session in the workspace gets the graph tools.

## Workspace CLAUDE.md

The orchestrator's routing behaviour (background dispatch, dashboard link, decision capture) is
driven by `CLAUDE.md` rules in the **workspace**, not the install dir. Copy or merge
`~/.claude/orchestrator/CLAUDE.md` into your project's `CLAUDE.md`. Without it the tools are
available but Claude won't use them automatically.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ZONOID_REPO` | `~/.claude/orchestrator` | Install directory (scripts use `__dirname` by default) |
| `ZONOID_WORKSPACE` | `process.cwd()` | Workspace path for bench scripts and live tests |
| `ORCH_PORT` | `8787` | Daemon HTTP port |
| `ORCH_TOKEN` | _(unset)_ | Bearer token if daemon auth is enabled |
| `ORCH_GATE_OFF` | _(unset)_ | Set to `1` to bypass the orch-gate hook |
| `ZONOID_SKIP_LIVE` | _(unset)_ | Set to `1` to skip live-KB-dependent tests |
| `CLAUDE_PLUGIN_DATA` | `~/.claude/orchestrator` | Runtime data dir (overlay, sessions, worktrees) |

## First run

The daemon starts automatically via the `SessionStart` hook. On first use with semantic search
enabled, MiniLM downloads (~90MB) and loads (~90s cold boot). Subsequent starts are instant.

Daemon logs: `/tmp/orch-daemon.log`

Check health: `curl -s http://localhost:8787/health`

## Nightly self-learning QA (optional)

The self-learning loop runs continuously during sessions. For overnight background optimization,
set up a scheduled task pointing to the `self-learn-qa` skill:

In Claude Code: `/schedule` → every night at 2am → prompt: `/self-learn-qa`

Or use the setup skill: `/setup` → "Set up nightly QA"

## Upgrade

After `git pull`, restart the daemon so it picks up new code:

```sh
curl -s http://localhost:8787/health || true   # check if running
pkill -f "node.*daemon.js" && sleep 1          # stop old process
# SessionStart hook will relaunch on next Claude Code session
# or: nohup node ~/.claude/orchestrator/daemon.js &
```
