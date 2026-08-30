# @zonoid/cli

One-command installer for [Zonoid](https://github.com/yugao-gaos/zonoid), the agent's
subconscious for coding work. Run it in any repo to wire up the task-graph daemon, hooks or
plugins, and MCP server that let agents activate project-local task history, decisions, and
learned skills.

## Usage

```sh
npx @zonoid/cli init
npx @zonoid/cli init --harness cursor
npx @zonoid/cli init --harness codex
npx @zonoid/cli init --harness dsh
npx @zonoid/cli init --harness opencode
npx @zonoid/cli init --service   # optional: always-on daemon via launchd/systemd
npx @zonoid/cli onboard          # mine + validate repo KB, then stop for review
```

## Init flags

| Flag | Values | Effect |
|---|---|---|
| `--harness` | `claude` (default) | Core install + merge `.claude/settings.json`, `.mcp.json`, `CLAUDE.md` (unchanged from pre-harness behavior) |
| `--harness` | `cursor` | Core install + write `.cursor/hooks.json` from `adapters/cursor/hooks.json.sample` (project hooks) + `.mcp.json`; chmod cursor adapter scripts; chmod `adapters/common/schedule-wakeup.sh`; MCP `ScheduleWakeup` + monitored `.fire` tail workflow in next steps |
| `--harness` | `codex` | Core install + merge `~/.codex/hooks.json` from `adapters/codex/hooks.json.sample` + Codex MCP in `~/.codex/config.toml` (`ORCH_CLIENT=codex`) + client-repo `.codex/skills/zonoid-orchestrator`; skips Claude settings; `ScheduleWakeup` MCP + Codex `delivery.command` monitor documented in next steps |
| `--harness` | `dsh` | Core install + materialize the Zonoid Cordis/MCP bundle under `$DSH_HOME/zonoid/packages/dsh` and add it to the DSH `headless` profile through `dsh plugin`; the installed stdio MCP row uses `ORCH_CLIENT=dsh` and an absolute Zonoid entry path. Existing profile dependencies and bundle layers are preserved, user Cordis patches are never edited, and profile metadata gets `.zonoid.bak` backups before changes |
| `--harness` | `opencode` | Core install + symlink `packages/opencode-plugin` into `.opencode/plugins/` (includes `schedule_wakeup` tool) + write `.opencode/package.json` deps (pinned to the installed opencode's minor — `latest` triggers opencode's broken `@local` resolution and the plugin won't load) + OpenCode MCP in `opencode.json` (`ORCH_CLIENT=opencode`) + install `.opencode/skills/zonoid-orchestrator` repo skill; chmod `schedule-wakeup.sh` |
| `--service` | (flag) | Install user-level launchd (macOS) or systemd (Linux) daemon service with `ORCH_PORT`, optional `ORCH_BIND_HOST`, and `ZONOID_DATA` pinned to the resolved runtime data dir |

All harnesses: clone Zonoid to `~/.claude/orchestrator` (if missing), `npm install`, install skills, start/register the daemon, and register the workspace. Runtime files live under `.zonoid/` by default; `.graph/` remains in each workspace. Combine `--harness` with `--service` when the IDE uses HTTP MCP and cannot rely on session-start hooks to boot the daemon.

The dashboard remains loopback-only by default. For trusted-LAN access, configure a runtime token
file and run `ORCH_BIND_HOST=0.0.0.0 npx @zonoid/cli init --service`; the daemon refuses the LAN
bind when authentication is not configured. See `docs/setup.md` for the authenticated dashboard URL.

## Local Ollama backend

Backend/headless API-kind runs can use a local Ollama server without an API key. Start Ollama, read
the models reported by the daemon, then select the backend for a workspace:

```sh
ollama serve
curl -s 'http://localhost:8787/config/backend?workspace=/path/to/repo'

curl -s -X POST http://localhost:8787/config/backend \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"/path/to/repo","provider":"ollama","model":"qwen3.6:35b"}'
```

The `GET /config/backend` response includes live Ollama `supportedModels` from `/api/tags`; choose
one of those ids for the POST body. The default endpoint is `http://127.0.0.1:11434/v1`. Override it
with `ZONOID_OLLAMA_BASE_URL` or `ORCH_OLLAMA_BASE_URL`; `OLLAMA_HOST` is also accepted. Use
`ORCH_OLLAMA_MODEL` to set the default model when the workspace backend config does not specify one.

## Repo learning

Run `npx @zonoid/cli onboard` inside a repo to mine static candidates, run the learner, and write a review bundle before any graph mutation. After review, inject approved notes with the command printed by the onboard run, or use the dashboard onboarding controls.

## Next steps by harness

- **claude** — Restart Claude Code; open the repo-pinned dashboard URL printed by `zonoid init`
- **cursor** — Trust project hooks in Cursor, restart; MCP `ScheduleWakeup` + `.fire` tail monitor; see `adapters/cursor/README.md`
- **codex** — Trust hooks via `/hooks` in Codex CLI, restart; repo skill lives at `.codex/skills/zonoid-orchestrator`; MCP `create_task` writes `codex/<id>.json` file-drop stubs and calls `/sync`; run `ScheduleWakeup` `delivery.command` when supported; see `adapters/codex/README.md`
- **dsh** — Run `dsh --profile headless "task"`; the installed profile bundle mounts the Zonoid Cordis bridge and stdio MCP server without changing user `cordis.patch.yml`
- **opencode** — Restart after `zonoid init` writes `opencode.json`; `task_create` writes file-drop stubs and calls `/sync`; repo skill at `.opencode/skills/zonoid-orchestrator`; see `packages/opencode-plugin/README.md`
