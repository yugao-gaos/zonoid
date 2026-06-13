# Adapter contract

Status: Phase 4 (P4-C2) · complements [multi-harness-plan.md](./multi-harness-plan.md)

The orchestrator daemon at `http://localhost:8787` is the **single contract surface** for
per-harness adapters. Adapters are thin relays: they map harness hook/plugin events to HTTP
calls and relay daemon verdicts back in the harness dialect (context injection, exit-2 deny,
throw-to-block, permissionDecision deny). They do **not** embed orchestrator business logic.

MCP tools are cooperative and agent-facing; **enforcement** lives in harness-guaranteed hooks
plus daemon-side refusal on operations the daemon mediates (claims, merges, metric-branch
invariant). See the plan doc for the full architecture.

---

## Contract endpoints

These routes are the adapter API. Method and shape are stable; harness bridges may only call
them (plus such relay-only helpers as `GET /session-info` and `POST /route` used today by
`classify.sh`).

| Endpoint | Method | Purpose |
|---|---|---|
| `/workspace` | `POST` | Pin the active workspace (`{ path, transcript?, force? }`). Idempotent unless `force:true`. |
| `/active-claim` | `GET` | `{ claimed, claims[] }` for `?session=<id>`. Resolves subagent aliases and cross-session claim registration. |
| `/should-stop` | `GET` | Cooperative stop signal: `{ stop, reason? }` for `?session=<id>&agent=<id>?`. |
| `/agent/start` | `POST` | Register a worker (`{ agent_id, agent_type?, transcript_path?, session?, subagent_session?, workspace?, task? }`). |
| `/agent/done` | `POST` | Mark worker done; auto-release dangling `in_progress` claims (`{ agent_id, workspace? }` → `{ released }`). |
| `/classify` | `POST` | **Planned (P4-C1).** Absorb prompt-submit heuristics; return finished injection text (`{ prompt }` → `{ additionalContext, … }`). Today Claude uses `hooks/classify.sh` locally plus `POST /context-classify`. |
| `/ready` | `GET` | Ready frontier: `{ ready: [{ key, label }] }`. Optional `?session=` / `?roots=` filters. |
| `/sync` | `POST` | Immediate file-drop pull (`{ workspace? }` → `{ adopted[], suggestions{} }`). |
| `/overlay/status` | `POST` | Authoritative task status / claim / complete (`{ key, status, agent_id?, summary?, … }`). MCP `start_task` / `complete_task` map here. |
| `/git/worktree` | `POST` | Create attempt worktree (`{ key, repo_path? }` → `{ branch, worktree, … }`). |
| `/git/merge` | `POST` | Merge attempt branch back (`{ key, repo_path?, message? }` → `{ merged }` or `{ conflict, files }`). |

Port defaults to `8787` (`ORCH_PORT`). All adapters treat daemon unreachable on gate paths as
**fail-open** (allow) except where the harness itself requires a deny — document per harness.

---

## Canonical event table

Each row is one **harness lifecycle moment** and the daemon endpoint the adapter must call.
"Blocking" = the harness can prevent the agent from continuing (exit 2, throw, deny decision).
"Advisory" = inject context only; agent may ignore.

| Event | Daemon endpoint | Role | Blocking vs advisory |
|---|---|---|---|
| **Session / workspace bind** | `POST /workspace` | Register cwd + main transcript so graph, overlay, and file-drop folders resolve. | Advisory (non-blocking relay) |
| **Prompt submit** | `POST /classify` *(target)*; today also `POST /context-classify`, `GET /ready`, `POST /route` via `classify.sh` | Route steer, model hint, KB inject/scaffold, ready-task nudge, gate reminders. | Advisory |
| **Pre-tool write gate** | `GET /active-claim?session=` (+ `GET /session-info`, `GET /task/detail` for metric-branch) | Deny substantive edits without a claim; enforce self-learning worktree branch. | **Blocking** |
| **Pre-tool cooperative stop** | `GET /should-stop?session=&agent=` | Halt worker when cancel/stop flag raised. | **Blocking** |
| **Agent start** | `POST /agent/start` | Observability, subagent session alias for claim lookup, workspace pin per worker. | Advisory |
| **Agent stop** | `POST /agent/done` | Release phantom claims when worker exits without `complete_task`. | Advisory |
| **Task claim / progress** | `POST /overlay/status` (`in_progress`) | Claim task (CAS); daemon enforces metric-branch worktree invariant. | Daemon-side refusal (MCP path) + hook defense-in-depth |
| **Task complete** | `POST /overlay/status` (`done` / `tested` / `failed` / `canceled`) | Terminal status, summary, follow-ups, verdicts; returns `newly_ready` when applicable. | Daemon-side (MCP); hooks may nudge via `GET /ready` |
| **Task mint (file-drop)** | write stub JSON → `POST /sync` | Adopt new task keys; return link suggestions. | Advisory (runs outside agent tool gate) |
| **Branch attempt** | `POST /git/worktree` | Self-learning / isolated attempt branch. | Daemon-side refusal without worktree |
| **Merge attempt** | `POST /git/merge` | Judge merge-back loop. | Daemon-side |
| **Stop advisory (MCP)** | `GET /should-stop` *(via MCP wrapper)* | Attach `should_stop` + reason to tool responses when stop requested. | Advisory only — does not block |

---

## Per-harness mapping

Mechanism names follow each harness's native vocabulary. All rows implement the **same**
endpoint column above; differences are only in how the relay is installed and whether the
harness guarantees interception.

| Contract event | Claude Code (reference) | Cursor | Codex | OpenCode |
|---|---|---|---|---|
| **Hook / plugin install** | `.claude/settings.json` → `hooks/*.sh` | Try `.claude/settings.json` compat first; else `.cursor/hooks.json` | `~/.codex/hooks.json` or `[hooks]` in `config.toml` | `.opencode/plugins/zonoid.ts` (or package) |
| **Workspace bind** | `SessionStart` → `start-daemon.sh` → `POST /workspace` | `sessionStart` → relay | `SessionStart` → relay | Plugin init / session hook → relay |
| **Prompt submit** | `UserPromptSubmit` → `classify.sh` → `/classify` *(target)*; today `/context-classify`, `/ready`, `/route` | `beforeSubmitPrompt` or mapped `UserPromptSubmit` → relay | `UserPromptSubmit` → relay | `chat.message` / `event` → relay |
| **Write gate** | `PreToolUse` `Write\|Edit` → `orch-gate.sh` → `/active-claim` (exit 2) | `preToolUse` → same scripts/relay (exit 2) | `PreToolUse` → `permissionDecision: deny` (fail-closed on unsupported fields) | `tool.execute.before` → **throw** to block (never rely on arg rewrite) |
| **Cooperative stop** | `PreToolUse` `*` → `orch-stop.sh` → `/should-stop` (exit 2) | `preToolUse` → relay (exit 2) | `PreToolUse` / `Stop` → relay | `tool.execute.before` throw or `event` handler |
| **Agent start** | `SubagentStart` → `subagent-start.sh` → `/agent/start` | `subagentStart` → relay | hook lifecycle → relay | `event` subscription → relay |
| **Agent stop** | `SubagentStop` → `subagent-stop.sh` → `/agent/done` | `subagentStop` → relay | `Stop` / lifecycle hook → relay | `event` subscription → relay |
| **Ready nudge after dispatch** | `PostToolUse` `Agent\|Task` → `post-agent.sh` → `/ready` | `postToolUse` → relay | `PostToolUse` → relay | optional plugin `event` → `/ready` |
| **Task mint** | Native `TaskCreate` → Claude task file → daemon pull (no `/sync` required) | `postToolUse` on todo tool → stub under `cursor/` → `/sync` | Shell/hook stub under `codex/` → `/sync`; fallback harness-scoped MCP `create_task` | Custom `task_create` tool → stub under `opencode/` → `/sync` |
| **Task claim / complete** | MCP `start_task` / `complete_task` → `/overlay/status` | Same MCP surface | Same MCP surface (filtered tool list when `ZONOID_HARNESS=codex`) | Same MCP + plugin-registered tools |
| **Claim session alias** | `PostToolUse` after `start_task` → `/overlay/claim-session` | Same when MCP used | Same when MCP used | Same when MCP used |
| **Branch / merge** | MCP `branch_task` / `merge_attempt` | Same | Same | Same |
| **Blocking vs advisory** | Exit 2 blocking on gates; MCP + injection advisory | Same pattern; **IDE hook coverage ⊃ CLI** | Partial shell interception; manual trust on hook hash change | Throw-to-block; frozen-args bug makes throw mandatory |

Research note: graph note `note-mqbk7fr1oih` — harness hook capability matrix (Jun 2026):
Cursor reads Claude hook config; Codex hooks are Claude-shaped but not all paths hooked;
OpenCode blocks only via throw in `tool.execute.before`.

---

## File-drop task minting

Non-Claude harnesses mint tasks by **dropping a stub file**, then calling `POST /sync`. This
mirrors Claude's native `TaskCreate` → filesystem handshake but uses our **documented** format
and harness-prefixed keys.

### Stub format (v1)

```json
{
  "id": "c2",
  "subject": "P4-C2: adapter contract documentation",
  "description": "…",
  "status": "pending",
  "blockedBy": ["local/c1"],
  "created_by": { "harness": "local", "agent_id": "plan-bootstrap" }
}
```

Required: `id`, `subject`. Optional: `description`, `status` (`pending` | `in_progress` |
`completed`), `blockedBy` (keys in any namespace), `created_by`.

### Designated folder layout

```
<dataDir>/tasks/<workspace-key>/<harness>/<id>.json
```

- `dataDir` = `CLAUDE_PLUGIN_DATA` or `~/.claude/orchestrator`
- `workspace-key` = sanitized basename + sha1 prefix of absolute workspace path (same scheme as overlay files)
- `harness` = namespace folder: `cursor`, `codex`, `opencode`, `local`, … (not hardcoded; avoid `followup` and uuid-like names)
- Task key in graph = `<harness>/<id>` (never collides with Claude's `<session-uuid>/<id>`)

### Atomic write

Write `<id>.json.tmp`, then rename to `<id>.json`. Reader skips non-`.json` and unparsable files.

### Pull paths

1. **Passive:** daemon aggregation + `fs.watch` on designated folders (cache invalidation on drop).
2. **Immediate:** adapter calls `POST /sync { "workspace": "<abs path>" }` after rename.

Response:

```json
{
  "ok": true,
  "workspace": "/path/to/repo",
  "adopted": ["local/c2"],
  "suggestions": { "local/c2": [ /* top link suggestions, same as GET /task/suggest */ ] }
}
```

Second `/sync` with no new files returns `"adopted": []` (idempotent).

### Per-harness minting entry points

| Harness | Who writes the stub | Then |
|---|---|---|
| Claude | Agent `TaskCreate` (native file under `~/.claude/tasks`) | Daemon pull; `/sync` optional |
| Cursor | `postToolUse` hook on todo writes | `POST /sync` |
| Codex | Hook or instructed shell write | `POST /sync` (or harness-scoped MCP `create_task`) |
| OpenCode | Plugin `task_create` tool | `POST /sync` |

Minting runs **outside** the agent write gate — hooks/plugins perform file I/O without needing
an active claim.

---

## Claude reference wiring (today)

Installed hooks in `hooks/hooks.json`:

| Hook event | Script | Endpoints |
|---|---|---|
| `SessionStart` | `start-daemon.sh` | `/ping`, `/workspace` |
| `UserPromptSubmit` | `classify.sh` | `/ready`, `/route`, `/context-classify`, `/active-claim`, `/task/detail`, `/judge/pressure`, `/label/pressure` → target `/classify` |
| `SubagentStart` | `subagent-start.sh` | `/agent/start` |
| `SubagentStop` | `subagent-stop.sh` | `/agent/done` |
| `PreToolUse` `*` | `orch-stop.sh` | `/should-stop` |
| `PreToolUse` `Write\|Edit` | `orch-gate.sh` | `/active-claim`, `/session-info`, `/task/detail` |
| `PostToolUse` `Agent\|Task` | `post-agent.sh` | `/ready` |
| `PostToolUse` `TaskCreate` | `suggest-links.sh` | MCP / graph tools (wiring nudge) |
| *(after MCP `start_task`)* | `orch-posttool-starttask.sh` | `/overlay/claim-session` |

Phase 4 follow-ups: **P4-C1** adds `POST /classify`; **P4-C3** slims `classify.sh` to a dumb
relay. Until then, adapters should treat `/classify` as the contract target and
`/context-classify` + script heuristics as the Claude reference implementation.

---

## Scheduler contract (`ScheduleWakeup`)

Heartbeat and idle polling use a **single session-scoped wake** with cancel-then-arm semantics.
All hookless harnesses share `lib/schedule-wakeup.js` and `adapters/common/schedule-wakeup.sh`;
Claude Code uses the harness-native tool instead (no pidfile substrate, no duplicate MCP entry).

See also [schedule-wakeup.md](./schedule-wakeup.md) for monitor workflow and fire-line format.

### Parameters

| Param | Type | Required | Meaning |
|---|---|---|---|
| `delaySeconds` | number | yes | Non-negative seconds until the wake fires. Floored to integer ≥ 0. |
| `reason` | string | yes | Short audit label (e.g. `"idle heartbeat"`, `"watching active loop"`). |
| `prompt` | string | yes | Text injected on wake — typically `"<<autonomous-loop-dynamic>>"` for heartbeat ticks. |

### Cancel + arm semantics

1. **Cancel first:** any call cancels the prior wake for the same session (SIGTERM on pid in
   `$ORCH_DATA/wake/<session-slug>.pid`; pidfile removed).
2. **Arm next:** a detached sleeper waits `delaySeconds`, then appends one line to
   `$ORCH_DATA/wake/<session-slug>.fire`:
   ```
   ORCH_SCHEDULED_TASK {"delaySeconds":N,"reason":"...","prompt":"..."}
   ```
3. **Re-arm replaces:** a second call with the same session never stacks timers — the old pid
   is killed before the new one is written.
4. **No session, no arm:** adapter `writeScheduledTask` without a live session writes a deferred
   `NOTE.md` under `$ORCH_DATA/scheduled-tasks/<id>/`; arm later via `ScheduleWakeup` when the
   session is bound.

Hookless MCP and plugin tools return `{ command, notify_pattern }` so the harness can monitor the
`.fire` file (`notify_pattern`: `^ORCH_SCHEDULED_TASK`; `command`: `tail -n0 -F <fire path>`).

### Per-harness exposure

| Harness | Tool surface | Session source | Substrate |
|---|---|---|---|
| **Claude Code** | Native `ScheduleWakeup` (built-in) | Harness session | Native — `lib/adapters/claude.js` returns `{ method: 'native' }`; **not** on default orchestrator MCP |
| **Cursor** | MCP `ScheduleWakeup` (harness-scoped extra tool) | `ORCH_SESSION` from hook context | `lib/schedule-wakeup.js` via `lib/mcp-harness-tools.js` |
| **Codex** | MCP `ScheduleWakeup` (+ harness-scoped `create_task`) | `ORCH_SESSION` from hook context | Same substrate as Cursor |
| **OpenCode** | Plugin tool `schedule_wakeup` | Plugin session id | Same substrate via `packages/opencode-plugin/lib/schedule-wakeup.js` |
| **Default MCP** (`mcp-graph.js`, no `ZONOID_HARNESS`) | **Not exposed** | — | Agents use harness-specific MCP config or Claude native |

Classify injection (`POST /classify` → `additional_context`) always includes the heartbeat nudge
referencing `ScheduleWakeup(delaySeconds=7200, …)` regardless of harness; only the **invocation
path** differs per row above.

### Adapter scheduler API (hookless)

`lib/adapters/scheduler-substrate.js` (wired into cursor, codex, stub):

| Method | Behavior |
|---|---|
| `armWakeup({ session, delaySeconds, reason, prompt })` | Cancel prior wake → arm sleeper → return `{ ok, pid, delaySeconds }`. |
| `cancelWakeup({ session })` | Kill pid, remove pidfile → `{ ok, canceled }`. |
| `writeScheduledTask({ id, title, prompt, taskKey, when, fireAt, cwd, session?, orchDir? })` | Write deferred note; if `session` + `fireAt` present, also `armWakeup` with computed delay. |

---

## Related docs

- [multi-harness-plan.md](./multi-harness-plan.md) — phases, namespaces, enforcement model
- [schedule-wakeup.md](./schedule-wakeup.md) — wake monitor workflow, fire line, init shims
- Graph note `note-mqbk7fr1oih` — harness hook capability matrix (Cursor / Codex / OpenCode)
- `lib/filedrop-tasks.js` — stub reader, folder layout, watch behavior
- `lib/schedule-wakeup.js` — shared cancel/arm substrate
- `hooks/` — Claude reference adapter scripts
