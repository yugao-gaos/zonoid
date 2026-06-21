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
| `ORCH_DATA` | unset | Exact runtime data-dir override; wins over all other data-dir env vars |
| `ZONOID_DATA` | `~/.claude/orchestrator/.zonoid` | Runtime data dir for universal and adapter runtime artifacts |
| `CLAUDE_PLUGIN_DATA` | unset | Legacy runtime data-dir override; if it points at the Zonoid install root, state is redirected into `.zonoid` |
| `ZONOID_EMBED_PROVIDER` | `minilm` | Optional embedding provider override. Supported values are intentionally limited to MiniLM compatibility plus instruction-aware/tunable providers: `local-instruct`, `voyage`, `cohere`, `gemini`. |
| `ZONOID_EMBED_MODEL` | provider default | Optional embedding model override. Unknown/generic models are rejected by `/config/embedding`. |
| `ZONOID_EMBED_DIMENSIONS` | provider default | Optional output dimension where the selected provider/model supports it. |
| `ZONOID_EMBED_LOCAL_BASE_URL` / `OLLAMA_HOST` | `http://127.0.0.1:11434` | Local instruct embedding endpoint for Ollama-style or OpenAI-compatible local servers. |
| `ZONOID_EMBED_LOCAL_API_STYLE` | inferred | `ollama` or `openai` for the local instruct provider. |
| `ZONOID_EMBED_LOCAL_API_KEY` | unset | Optional bearer token for local OpenAI-compatible embedding servers. |
| `VOYAGE_API_KEY` / `COHERE_API_KEY` / `GEMINI_API_KEY` | unset | Hosted embedding provider credentials. Missing keys make the provider return `null` and retrieval falls back lexically. |

## First run

The daemon starts automatically via the `SessionStart` hook. On first use with semantic search
enabled, MiniLM downloads (~90MB) and loads (~90s cold boot). Subsequent starts are instant.

Embedding provider selection is exposed at `GET/POST /config/embedding`. MiniLM remains the default
compatibility provider. Additional providers are admitted only when they support retrieval
query/document instruction semantics and have a credible customization path (custom, fine-tune, or
LoRA). Generic raw-vector providers such as OpenAI text embeddings are intentionally not listed in
this slice.

Changing provider, model, or dimensions changes vector identity. Existing vectors are ignored for
semantic scoring until `/overlay/backfill-embeddings` or `/overlay/reembed` refreshes them; lexical
fallback remains active during the transition.

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
