# Codex adapter (Zonoid orchestrator)

Thin relay hooks for [OpenAI Codex](https://developers.openai.com/codex/hooks) that map lifecycle events to the orchestrator daemon at `http://localhost:8787`. See [docs/adapter-contract.md](../../docs/adapter-contract.md).

## Install

1. **Install Zonoid core** (daemon + reference hooks):

   ```sh
   npx @zonoid/cli init
   ```

   Or clone to `~/.claude/orchestrator` manually and run `npm install`.

2. **Copy hook wiring** to Codex user config (replace `__INSTALL_DIR__` with your install path, usually `$HOME/.claude/orchestrator`):

   ```sh
   INSTALL="$HOME/.claude/orchestrator"
   sed "s|__INSTALL_DIR__|$INSTALL|g" "$INSTALL/adapters/codex/hooks.json.sample" > ~/.codex/hooks.json
   chmod +x "$INSTALL/adapters/codex/hooks/"*.sh
   ```

   Alternative: merge `adapters/codex/config.toml.sample` into `~/.codex/config.toml` (use **either** `hooks.json` **or** inline `[hooks]` per layer — not both).

3. **Wire MCP** with harness-scoped tools (`create_task` for file-drop minting):

   ```sh
   sed "s|__INSTALL_DIR__|$INSTALL|g" "$INSTALL/adapters/codex/mcp.sample.json" >> ~/.codex/config.toml
   ```

   Or add the `orchestrator-graph` server from `mcp.sample.json` to your Codex MCP config. **Required env:** `ZONOID_HARNESS=codex`.

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
| `UserPromptSubmit` | `classify-relay.sh` | `/route`, `/context-classify`, `/ready`, … |
| `PreToolUse` `*` | `orch-stop.sh` | `/should-stop` → `permissionDecision: deny` |
| `PreToolUse` `apply_patch\|Write\|Edit` | `orch-gate.sh` | `/active-claim`, `/task/detail` |
| `PreToolUse` `Bash` | `orch-gate-bash.sh` | `/active-claim` |
| `SubagentStart` | `subagent-start.sh` | `/agent/start` |
| `SubagentStop` | `subagent-stop.sh` | `/agent/done` |
| `PostToolUse` `mcp__orchestrator-graph__start_task` | `post-start-task.sh` | `/overlay/claim-session` |
| `PostToolUse` spawn / complete | `post-lifecycle.sh` | `/ready` (nudge) |
| `Stop` | `agent-done.sh` | `/agent/done` |

## Codex-specific notes

- **Fail-closed PreToolUse:** relays emit only supported fields (`permissionDecision`, `permissionDecisionReason`, `hookEventName`). Unsupported fields (`continue`, `stopReason`, `updatedInput` without allow) cause Codex to fail the hook and **continue the tool call**.
- **Partial interception:** not every shell path uses hooked tools (`unified_exec`, some reads). Treat hooks as defense-in-depth; daemon-side refusal still applies on MCP claims/merges.
- **Task minting:** use MCP `create_task` (writes `codex/<id>.json` stub + `POST /sync`) or drop a stub file under the daemon file-drop folder manually.

## Workflow

1. `create_task` or file-drop stub → task appears in graph
2. MCP `start_task(task_key, agent_id)` → claim before edits
3. Edit via `apply_patch` / `Bash` — gates allow while claimed
4. MCP `complete_task` → release claim

Dashboard: http://localhost:8787/graph
