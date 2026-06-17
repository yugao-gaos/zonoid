# @zonoid/opencode-plugin

OpenCode bridge for the [Zonoid](https://github.com/yugao-gaos/zonoid) orchestrator daemon (`http://localhost:8787`).

## Capabilities

| Hook / tool | Behavior |
|---|---|
| `tool.execute.before` | Blocks `write` / `edit` / patch tools when the session has no active claim (`GET /active-claim`). Throws `Error` — **never** mutates `output.args` (OpenCode ≥ 1.14 freezes args). |
| `event` | `session.created` → `POST /agent/start`; `session.idle` / `session.deleted` → `POST /agent/done`. |
| `task_create` | Writes a v1 stub JSON under the daemon file-drop folder (`opencode/<id>.json`), then `POST /sync` for immediate adoption. |
| `schedule_wakeup` | Claude-compatible `ScheduleWakeup`: cancels any prior wake for the session, arms `delaySeconds` via `lib/schedule-wakeup.js`, returns `{ command, notify_pattern }` for monitored wake (`ORCH_SCHEDULED_TASK …`). |

## Install (project)

1. Start the Zonoid daemon (`node daemon.js` or `npx @zonoid/cli init` in the repo).

2. Copy or symlink this package into your project:

```sh
mkdir -p .opencode/plugins
cp -r path/to/zonoid/packages/opencode-plugin/zonoid.ts .opencode/plugins/
cp -r path/to/zonoid/packages/opencode-plugin/lib .opencode/plugins/lib
```

Or symlink the whole plugin entry:

```sh
mkdir -p .opencode/plugins
ln -sf "$(pwd)/packages/opencode-plugin/zonoid.ts" .opencode/plugins/zonoid.ts
ln -sf "$(pwd)/packages/opencode-plugin/lib" .opencode/plugins/lib
```

3. Add OpenCode plugin dependencies (TypeScript + `@opencode-ai/plugin`):

```sh
mkdir -p .opencode
cat > .opencode/package.json <<'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "latest"
  }
}
EOF
```

OpenCode runs `bun install` in `.opencode/` at startup.

4. Optional env:

| Variable | Default | Purpose |
|---|---|---|
| `ORCH_PORT` | `8787` | Daemon HTTP port |
| `CLAUDE_PLUGIN_DATA` | `~/.claude/orchestrator` | File-drop root (same as daemon) |

5. Wire orchestrator MCP in `opencode.json` (stdio transport) so agents can `start_task` / `complete_task` after minting.

6. Restart OpenCode. The plugin loads from `.opencode/plugins/` automatically.

## Global install

Copy the same files to `~/.config/opencode/plugins/` for all projects.

## Workflow

1. `task_create` — mint `opencode/<id>` in the graph (stub + `/sync`).
2. Orchestrator MCP `start_task(task_key, agent_id)` — claim before edits.
3. Edit files — gate allows writes while claimed.
4. Orchestrator MCP `complete_task` — finish and release claim.
5. `schedule_wakeup(delaySeconds, reason, prompt)` — heartbeat / idle polling (same contract as Claude native `ScheduleWakeup`). Re-arming replaces any prior wake for the session. Response includes `notify_pattern: "ORCH_SCHEDULED_TASK"` when a harness monitors stdout for the fire line.

Dashboard: http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>
