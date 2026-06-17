# @zonoid/cli

One-command installer for the [Zonoid](https://github.com/yugao-gaos/zonoid) orchestrator. Run it in any repo to wire up the task-graph daemon, hooks or plugins, and MCP server for your harness.

## Usage

```sh
npx @zonoid/cli init
npx @zonoid/cli init --harness cursor
npx @zonoid/cli init --harness codex
npx @zonoid/cli init --harness opencode
npx @zonoid/cli init --service   # optional: always-on daemon via launchd/systemd
npx @zonoid/cli onboard          # mine + validate repo KB, then stop for review
```

## Init flags

| Flag | Values | Effect |
|---|---|---|
| `--harness` | `claude` (default) | Core install + merge `.claude/settings.json`, `.mcp.json`, `CLAUDE.md` (unchanged from pre-harness behavior) |
| `--harness` | `cursor` | Core install + write `.cursor/hooks.json` from `adapters/cursor/hooks.json.sample` (project hooks) + `.mcp.json`; chmod cursor adapter scripts; chmod `adapters/common/schedule-wakeup.sh`; MCP `ScheduleWakeup` + monitored `.fire` tail workflow in next steps |
| `--harness` | `codex` | Core install + merge `~/.codex/hooks.json` from `adapters/codex/hooks.json.sample` + Codex MCP in `~/.codex/config.toml` (`ORCH_CLIENT=codex`) + client-repo `.codex/skills/zonoid-orchestrator`; skips Claude settings; `ScheduleWakeup` MCP + `.fire` monitor documented in next steps |
| `--harness` | `opencode` | Core install + symlink `packages/opencode-plugin` into `.opencode/plugins/` (includes `schedule_wakeup` tool) + write `.opencode/package.json` deps + `.mcp.json`; chmod `schedule-wakeup.sh` |
| `--service` | (flag) | Install user-level launchd (macOS) or systemd (Linux) daemon service with `ORCH_PORT` and `CLAUDE_PLUGIN_DATA` |

All harnesses: clone Zonoid to `~/.claude/orchestrator` (if missing), `npm install`, install skills, start/register the daemon, and register the workspace. Combine `--harness` with `--service` when the IDE uses HTTP MCP and cannot rely on session-start hooks to boot the daemon.

## Repo learning

Run `npx @zonoid/cli onboard` inside a repo to mine static candidates, run the learner, and write a review bundle before any graph mutation. After review, inject approved notes with the command printed by the onboard run, or use the dashboard onboarding controls.

## Next steps by harness

- **claude** — Restart Claude Code; dashboard at `http://localhost:8787/graph`
- **cursor** — Trust project hooks in Cursor, restart; MCP `ScheduleWakeup` + `.fire` tail monitor; see `adapters/cursor/README.md`
- **codex** — Trust hooks via `/hooks` in Codex CLI, restart; repo skill lives at `.codex/skills/zonoid-orchestrator`; MCP `create_task` writes `codex/<id>.json` file-drop stubs and calls `/sync`; see `adapters/codex/README.md`
- **opencode** — Wire orchestrator MCP in `opencode.json`, restart; `task_create` writes file-drop stubs and calls `/sync`; see `packages/opencode-plugin/README.md`
