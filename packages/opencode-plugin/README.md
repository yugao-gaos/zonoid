# @zonoid/opencode-plugin

OpenCode bridge for the [Zonoid](https://github.com/yugao-gaos/zonoid) orchestrator daemon (`http://localhost:8787`).

## Capabilities

| Hook / tool | Behavior |
|---|---|
| `chat.message` | Extracts text prompt parts, best-effort `POST /classify { prompt, session_id, workspace }`, and appends returned context as an additional text part without replacing user parts. |
| `tool.execute.before` | Best-effort checks `GET /should-stop?session=&agent=&workspace=` for every tool call, then applies the shared Zonoid write policy (`hooks/lib/gate-policy.js`) to `write` / `edit` / patch tools. Throws `Error` to block — **never** mutates `output.args` (OpenCode ≥ 1.14 freezes args). |
| `tool.execute.after` | Best-effort `GET /ready?session=&workspace=` nudge after tool execution; daemon errors are ignored. |
| `event` | Plugin init / `session.created` → `POST /workspace`; `session.created` → `POST /agent/start`; `session.idle` / `session.deleted` → `POST /agent/done`; `todo.updated` with a session id → best-effort `GET /ready?session=&workspace=`. |
| `task_create` | Writes a v1 stub JSON under the daemon file-drop folder (`opencode/<id>.json`), then `POST /sync` for immediate adoption. IDs are trimmed and may contain only letters, numbers, dot, underscore, and dash. |
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

   **Pin to your installed opencode's minor — do NOT use `latest`.** opencode rewrites
   `"latest"` to a `@local` tag that fails to resolve (`NpmInstallFailedError`), the
   background install fails, and opencode silently skips the plugin (no write-gate, no
   `task_create`, no classify). Find your version with `opencode --version` (e.g. `1.15.10`)
   and pin the matching minor:

```sh
mkdir -p .opencode
cat > .opencode/package.json <<'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "~1.15.0"
  }
}
EOF
```

   (`npx @zonoid/cli init --harness opencode` detects the installed opencode and writes the
   correct pin automatically.) OpenCode runs `bun install` in `.opencode/` at startup.

4. Optional env:

| Variable | Default | Purpose |
|---|---|---|
| `ORCH_PORT` | `8787` | Daemon HTTP port |
| `ORCH_DATA` | unset | Exact runtime data-dir override; wins over the other data-dir env vars |
| `ZONOID_DATA` | `~/.claude/orchestrator/.zonoid` | Runtime data dir; file-drop stubs live under `tasks/` |
| `CLAUDE_PLUGIN_DATA` | unset | Legacy runtime data-dir override |
| `ZONOID_ROOT` | `~/.claude/orchestrator` fallback | Zonoid install root; required for copied OpenCode plugins that are not symlinked by the CLI |

5. Wire orchestrator MCP in `opencode.json` so agents can `branch_task` / `start_task` / `complete_task` after minting. `npx @zonoid/cli init --harness opencode` writes this automatically; manual installs should add:

```json
{
  "mcp": {
    "orchestrator-graph": {
      "type": "local",
      "command": ["node", "/path/to/zonoid/mcp-graph.js"],
      "enabled": true,
      "environment": {
        "ORCH_CLIENT": "opencode"
      }
    }
  }
}
```

6. Restart OpenCode. The plugin loads from `.opencode/plugins/` automatically.

## Global install

Copy the same files to `~/.config/opencode/plugins/` for all projects. If the plugin is copied
rather than symlinked from the Zonoid install, set `ZONOID_ROOT` to the install root so the plugin
can load the shared gate policy.

## Workflow

Use the canonical repo skill at `.opencode/skills/zonoid-orchestrator`. `npx @zonoid/cli init --harness opencode` installs it automatically.

1. Plugin init and `session.created` register the OpenCode workspace with the daemon.
2. Each user prompt runs through `chat.message`, which appends `/classify` context when the daemon returns one.
3. Every tool call runs through cooperative stop before write gating; canceled workers are blocked by throwing OpenCode's hook error.
4. After tool execution, and after `todo.updated` when OpenCode includes a session id, the plugin nudges `/ready` best-effort so newly-ready work can surface without blocking on daemon availability.
5. `task_create` — mint `opencode/<id>` in the graph (stub + `/sync`).
6. Orchestrator MCP `branch_task(task_key)`, then `start_task(task_key, agent_id)` — create the attempt worktree and claim before edits.
7. Edit files inside the returned worktree — gate allows claimed writes only there.
8. Orchestrator MCP `complete_task` — finish and release claim.
9. `schedule_wakeup(delaySeconds, reason, prompt)` — heartbeat / idle polling (same contract as Claude native `ScheduleWakeup`). Re-arming replaces any prior wake for the session. Response includes `notify_pattern: "ORCH_SCHEDULED_TASK"` when a harness monitors stdout for the fire line.

Dashboard: http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>
