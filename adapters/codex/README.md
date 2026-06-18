# Codex adapter (Zonoid orchestrator)

Thin relay hooks for [OpenAI Codex](https://developers.openai.com/codex/hooks) that map lifecycle events to the orchestrator daemon at `http://localhost:8787`. See [docs/adapter-contract.md](../../docs/adapter-contract.md).

## Install

1. **Install Zonoid for this client repo** (daemon + hooks + MCP + repo-local skill):

   ```sh
   npx @zonoid/cli init --harness codex
   ```

   This writes global Codex hook/MCP config and installs the client-repo skill at
   `.codex/skills/zonoid-orchestrator`, so future Codex sessions in this repo can load the
   task-minting workflow. Or clone to `~/.claude/orchestrator` manually and run `npm install`.

2. **Copy hook wiring** to Codex user config (replace `__INSTALL_DIR__` with your install path, usually `$HOME/.claude/orchestrator`):

   ```sh
   INSTALL="$HOME/.claude/orchestrator"
   sed "s|__INSTALL_DIR__|$INSTALL|g" "$INSTALL/adapters/codex/hooks.json.sample" > ~/.codex/hooks.json
   chmod +x "$INSTALL/adapters/codex/hooks/"*.sh
   ```

   Alternative: merge `adapters/codex/config.toml.sample` into `~/.codex/config.toml` (use **either** `hooks.json` **or** inline `[hooks]` per layer — not both).

3. **Wire MCP** with harness-scoped tools (`create_task` for file-drop minting).

   Codex reads MCP servers from `~/.codex/config.toml` under `[mcp_servers.*]` (TOML) —
   **not** from a repo `.mcp.json` (that file is for Claude/Cursor; OpenCode uses
   `opencode.json` under `mcp`). `npx @zonoid/cli init --harness codex`
   merges the block below into `~/.codex/config.toml` for you, idempotently and preserving
   your other `[mcp_servers.*]`. To add it by hand, append this TOML (replace `__INSTALL_DIR__`):

   ```toml
   [mcp_servers.orchestrator-graph]
   command = "node"
   args = ["__INSTALL_DIR__/mcp-graph.js"]

   [mcp_servers.orchestrator-graph.env]
   ORCH_PORT = "8787"
   ORCH_CLIENT = "codex"
   ```

   **Required env:** `ORCH_CLIENT=codex` (makes the stdio MCP expose `create_task`). The JSON
   in `mcp.sample.json` is a reference shape only — do **not** `>>`-append JSON into `config.toml`.

4. **Trust hooks** — Codex requires manual review when hook definitions change:

   - Open `/hooks` in the Codex CLI
   - Review and trust each new/changed hook hash
   - Or one-off: `codex --dangerously-bypass-hook-trust` (automation only)

5. **Enable hooks** in `~/.codex/config.toml` if disabled:

   ```toml
   [features]
   hooks = true
   ```

## Hook map

| Event | Script | Daemon endpoints |
|---|---|---|
| `SessionStart` | `session-start.sh` | `/ping`, `/workspace` |
| `UserPromptSubmit` | `classify-relay.sh` | `/classify` |
| `PreToolUse` `*` | `orch-stop.sh` | `/should-stop` → `permissionDecision: deny` |
| `PreToolUse` `apply_patch\|Write\|Edit` | `orch-gate.sh` | shared gate policy, `/active-claim`, `/task/detail`, `/session-info`, `/dispatcher/children` |
| `PreToolUse` `Bash` | `orch-gate-bash.sh` | shared gate policy, `/active-claim`, `/task/detail` |
| `SubagentStart` | `subagent-start.sh` | `/agent/start` |
| `SubagentStop` | `subagent-stop.sh` | `/agent/done` |
| `PostToolUse` `mcp__orchestrator-graph__start_task` | `post-start-task.sh` | `/overlay/claim-session` |
| `PostToolUse` spawn / complete | `post-lifecycle.sh` | `/ready` (nudge) |
| `Stop` | `agent-done.sh` | `/agent/done` |

## Codex-specific notes

- **Fail-closed PreToolUse:** relays emit only supported fields (`permissionDecision`, `permissionDecisionReason`, `hookEventName`). Unsupported fields (`continue`, `stopReason`, `updatedInput` without allow) cause Codex to fail the hook and **continue the tool call**.
- **Partial interception:** not every shell path uses hooked tools (`unified_exec`, some reads). Treat hooks as defense-in-depth; daemon-side refusal still applies on MCP claims/merges.
- **Session IDs:** the Codex MCP server infers the current session from `ORCH_SESSION`, `ZONOID_SESSION`, or `CODEX_THREAD_ID`; if it cannot infer one, pass `session_id` explicitly to session-bound MCP tools such as `start_task` and `ScheduleWakeup`.
- **Task minting:** use MCP `create_task` (writes `codex/<id>.json` stub + `POST /sync`) or drop a stub file under the daemon file-drop folder manually.
- **Repo-local skill:** `npx @zonoid/cli init --harness codex` installs `.codex/skills/zonoid-orchestrator/SKILL.md` into the client repo. Use that skill as the reusable instruction surface for task minting and dispatcher-vs-worker behavior.

## Workflow

1. `create_task` or file-drop stub → task appears in graph
2. MCP `branch_task(task_key)` → create an isolated attempt worktree
3. MCP `start_task(task_key, agent_id[, session_id])` → claim before edits
4. Edit via `apply_patch` / `Bash` inside the returned worktree — gates allow while claimed
5. MCP `complete_task` → release claim

Dashboard: http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>
