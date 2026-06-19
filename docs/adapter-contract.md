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
| `/should-stop` | `GET` | Cooperative stop signal: `{ stop, reason? }` for `?session=<id>&agent=<id>&workspace=<path>?`. |
| `/agent/start` | `POST` | Register a worker (`{ agent_id, agent_type?, transcript_path?, session?, subagent_session?, workspace?, task? }`). |
| `/agent/done` | `POST` | Mark worker done; auto-release dangling `in_progress` claims (`{ agent_id, workspace? }` → `{ released }`). |
| `/classify` | `POST` | Absorb prompt-submit heuristics; return finished injection text (`{ prompt, session_id?, workspace? }` → `{ additional_context, … }`). |
| `/ready` | `GET` | Ready frontier: `{ ready: [{ key, label }] }`. Optional `?session=` / `?workspace=` / `?roots=` filters. |
| `/sync` | `POST` | Immediate file-drop pull (`{ workspace? }` → `{ adopted[], suggestions{} }`). |
| `/overlay/status` | `POST` | Authoritative task status / claim / complete (`{ key, status, agent_id?, summary?, … }`). MCP `start_task` / `complete_task` map here. **Dispatcher sessions are refused** on `in_progress` (409). |
| `/overlay/dispatcher-focus` | `POST` | Pin trivial-edit attribution when multiple workers are in flight (`{ session_id, task_key }`). |
| `/dispatcher/children` | `GET` | In-flight workers for a parent session (`?session=`): `{ children[], attribution?, needs_focus?, focus? }`. |
| `/usage/dispatcher-edit` | `POST` | Record a main-thread trivial patch against a worker task (`{ parent_session, chars, file?, task_key? }`). |
| `/git/worktree` | `POST` | Create attempt worktree (`{ key, repo_path? }` → `{ branch, worktree, … }`). |
| `/git/merge` | `POST` | Merge attempt branch back (`{ key, repo_path?, message? }` → `{ merged }` or `{ conflict, files }`). |
| `/usage/reconcile` | `POST` | **Planned (P5-MS3).** Cold-path usage reconcile for one harness (`{ harness, workspace?, session? }`). Daemon checks `overlay.usage_reconcile[harness].at`; if stale (default 24h), calls that adapter's `usage.reconcile()`, updates `at` + snapshot. From `sessionStart` and adapter daily scheduler — never from `GET /costflow`. |

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
| **Pre-tool write gate** | Shared hook policy + `GET /active-claim?session=` (+ `GET /session-info`, `GET /task/detail` for registered worktree confinement) | Deny substantive edits without a claim; enforce writes inside a claimed task's registered attempt worktree. | **Blocking** |
| **Pre-tool cooperative stop** | `GET /should-stop?session=&agent=` | Halt worker when cancel/stop flag raised. | **Blocking** |
| **Agent start** | `POST /agent/start` | Observability, subagent session alias for claim lookup, workspace pin per worker. | Advisory |
| **Agent stop** | `POST /agent/done` | Mark worker done; **primary usage accounting** (`usage.sample` → `usage_records`); release phantom claims when worker exits without `complete_task`. | Advisory |
| **Usage reconcile (cold)** | `sessionStart` + adapter daily scheduler → `/usage/reconcile` | Per-harness sweep when `usage_reconcile[harness].at` is stale; adapter normalizes to `UsageReport`. Not on `/costflow` reads. | Advisory |
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
| **Workspace bind** | `SessionStart` → `start-daemon.sh` → `POST /workspace` | `sessionStart` → relay | `SessionStart` → relay | Plugin init and `session.created` → `POST /workspace` |
| **Prompt submit** | `UserPromptSubmit` → `classify.sh` → `/classify` | `beforeSubmitPrompt` or mapped `UserPromptSubmit` → relay | `UserPromptSubmit` → relay | `chat.message` → `POST /classify`, append returned context as a text part |
| **Write gate** | `PreToolUse` `Write\|Edit` → shared policy in `hooks/lib/gate-policy.js` via `orch-gate.*` (exit 2) | `preToolUse` → normalize payload, then same shared gate (exit 2) | `PreToolUse` → same shared gate, translated to `permissionDecision: deny` | `tool.execute.before` → same shared policy, then **throw** to block (never rely on arg rewrite) |
| **Cooperative stop** | `PreToolUse` `*` → `orch-stop.sh` → `/should-stop` (exit 2) | `preToolUse` → relay (exit 2) | `PreToolUse` / `Stop` → relay | `tool.execute.before` → `/should-stop`, then throw to block |
| **Agent start** | `SubagentStart` → `subagent-start.sh` → `/agent/start` | `subagentStart` → relay | hook lifecycle → relay | `event` subscription → relay |
| **Agent stop** | `SubagentStop` → `subagent-stop.sh` → `/agent/done` | `subagentStop` → relay | `Stop` / lifecycle hook → relay | `event` subscription → relay |
| **Ready nudge after dispatch** | `PostToolUse` `Agent\|Task` → `post-agent.sh` → `/ready` | `postToolUse` → relay | `PostToolUse` → relay | `tool.execute.after` and `todo.updated` with session id → `/ready` best-effort |
| **Task mint** | Native `TaskCreate` → Claude task file → daemon pull (no `/sync` required) | `postToolUse` on todo tool → stub under `cursor/` → `/sync` | Shell/hook stub under `codex/` → `/sync`; fallback harness-scoped MCP `create_task` | Custom `task_create` tool → stub under `opencode/` → `/sync` |
| **Task claim / complete** | MCP `start_task` / `complete_task` → `/overlay/status` | Same MCP surface | Same MCP surface (filtered tool list when MCP spawn sets `ORCH_CLIENT=codex`) | Same MCP + plugin-registered tools |
| **Claim session alias** | `PostToolUse` after `start_task` → `/overlay/claim-session` | Same when MCP used | Same when MCP used | Same when MCP used |
| **Branch / merge** | MCP `branch_task` / `merge_attempt` | Same | Same | Same |
| **Blocking vs advisory** | Exit 2 blocking on gates; MCP + injection advisory | Same pattern; **IDE hook coverage ⊃ CLI** | Partial shell interception; manual trust on hook hash change | Throw-to-block; frozen-args bug makes throw mandatory |

Research note: graph note `note-mqbk7fr1oih` — harness hook capability matrix (Jun 2026):
Cursor reads Claude hook config; Codex hooks are Claude-shaped but not all paths hooked;
OpenCode blocks only via throw in `tool.execute.before`.

---

## Install-time file ownership

`npx @zonoid/cli init --harness <h>` is **additive per harness**, so the SAME repo can be opened
in multiple harnesses at once (e.g. `--harness claude,codex`). The map below is the contract for
which file each harness's wiring writes — picked so two harnesses never fight over one file.

| File | Owner harness(es) | Written by | Carries |
|---|---|---|---|
| `~/.codex/config.toml` → `[mcp_servers.orchestrator-graph]` | **codex** | `writeCodexMcp()` (TOML merge) | Codex's MCP server identity + `ORCH_CLIENT=codex` |
| `~/.codex/hooks.json` | **codex** | `checkCodexHooks()` | Codex relay hooks |
| `<cwd>/opencode.json` → `mcp["orchestrator-graph"]` | **opencode** | `writeOpencodeMcp()` (JSON merge) | OpenCode's native MCP server identity + `ORCH_CLIENT=opencode` |
| `<cwd>/.mcp.json` → `mcpServers["orchestrator-graph"]` | **claude**, **cursor** | `bin/install.js installMcp` (claude) / `writeMcp()` (cursor) — both **MERGE** | The MCP server for `.mcp.json` harnesses; cursor's entry adds `ORCH_CLIENT=cursor` |
| `<cwd>/.claude/settings.json` | **claude** | `bin/install.js installSettings` | Claude hooks + statusLine + MCP allow-list |
| `<cwd>/CLAUDE.md` | **claude** | `checkClaude()` | Orchestrator workspace instructions |
| `<cwd>/.cursor/hooks.json` | **cursor** | `checkCursorHooks()` | Cursor relay hooks |
| `<cwd>/.opencode/plugins/*`, `<cwd>/.opencode/package.json` | **opencode** | `checkOpencodePlugin()` | OpenCode plugin + deps |

**Key split — each non-Claude-native MCP store stays native.** Codex reads MCP servers from
`~/.codex/config.toml` under `[mcp_servers.*]`; OpenCode reads project MCP servers from
`opencode.json` under `mcp`; the repo `.mcp.json` is the store for **claude / cursor** only.
Earlier builds wrote Codex's server into `<cwd>/.mcp.json`, which Codex never reads and which
clobbered the Claude/Cursor entry on a second `init`; that was fixed by routing Codex to its
native TOML store. OpenCode is likewise routed to `opencode.json`. All writers are
read-modify-write merges that set only their `orchestrator-graph` entry and preserve sibling
servers/config.

**Coexistence invariants:**
- One repo, multiple client identities: Claude's server lives in `.mcp.json` (no `ORCH_CLIENT`),
  Cursor's lives in `.mcp.json` with `ORCH_CLIENT=cursor`, Codex's lives in `config.toml` with
  `ORCH_CLIENT=codex`, and OpenCode's lives in `opencode.json` with `ORCH_CLIENT=opencode`.
  They never collide because each native store owns only its own entry.
- All writers are **idempotent merges**: re-running any harness's init replaces only its own
  `orchestrator-graph` entry and backs the file up once (`*.bak`); user-added MCP servers and
  unrelated config survive.

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

### Stub lifecycle / GC

Stubs are **mint artifacts**, not durable state. The overlay snapshot (adopted on first sight or at
terminal status) is the retention fallback — same model as Claude native `cleanupPeriodDays`.

- **Adapters mint only** — write stub JSON, then `POST /sync`. Adapters **MUST NOT** delete stubs
  before adoption (snapshot must exist first).
- **Daemon removes stub after terminal complete** — when overlay status becomes
  `done`/`tested`/`failed`/`canceled`, the daemon write-through stamps the stub
  `completed`, then removes the stub file once a snapshot exists.
- **Periodic sweep** — every 5 minutes the daemon runs `sweepFiledropStubs` to catch missed removals.
- **Manual backfill** — `node scripts/gc-filedrop-stubs.js --workspace $PWD --confirm`

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

`POST /classify` is the contract target for prompt-submit relays. Claude's `classify.sh`
remains the reference hook relay, while OpenCode uses `chat.message` to append returned
context into the outgoing user message.

---

## Dispatcher vs worker roles

The orchestrator distinguishes two agent roles in a conversation:

| Role | Session | May `start_task`? | May edit substantively? |
|---|---|---|---|
| **Dispatcher** (main thread) | Parent `session` from `/agent/start` | **No** — daemon returns 409 | Only via trivial patch gate (below) or by dispatching workers |
| **Worker** (subagent) | Distinct worker/session identity, usually registered by lifecycle hooks or by `start_task` on a registered worktree | **Yes** — after wiring/`mark_root` and `branch_task` | Yes, once claimed and writing inside the registered worktree |

**Dispatcher duties:** decompose work into graph tasks, wire dependencies (`suggest_links` +
`add_dependency`), dispatch background subagents, orchestrate — keep the main thread free.
Workers carry three graph duties: `branch_task` before `start_task`, `start_task` before any
write, and `complete_task` with a summary at the end.

### Claim gate contract

`branch_task` creates the attempt branch/worktree and records it on the task. `POST
/overlay/status` with `status: in_progress` (MCP `start_task`) then claims the task. The daemon
refuses claims that do not have a registered worktree, so the enforced order is:

1. `branch_task(task_key)` -> records `git.branch` and `git.worktree`.
2. `start_task(task_key, agent_id, session_id?)` -> claims the task and self-registers hookless
   workers when the claim carries `agent_id` and the task has a registered worktree.
3. Write gates call `GET /active-claim?session=` and `GET /task/detail?key=`; if the task has a
   registered worktree, non-exempt Write/Edit/apply_patch/Bash file writes must land inside it.

Parent/dispatcher sessions and unregistered sessions are still refused by the daemon. `force: true`
does not bypass the gate. Lifecycle hooks (`/agent/start`) remain useful for observability and
session aliasing, but they are no longer the sole source of worker registration for background
workers whose harness does not fire start hooks.

### Trivial patch gate (Option A)

Main/dispatcher sessions without a claim may apply **one trivial patch per classify turn** when
at least one worker is in flight:

- Patch limits: **≤ 20 lines** and **≤ 800 characters** (`hooks/orch-gate-trivial.sh`).
- Requires `GET /dispatcher/children?session=` to report `children.length > 0`.
- Counter resets each turn in `hooks/classify.sh` (`reset_trivial_counter`).
- Subagents remain zero-tolerance — no trivial allowance.

Block messages distinguish: no in-flight workers, trivial budget exhausted, multiple workers
without focus, and dispatch-required (oversized patch).

### `dispatcher_focus` + usage attribution

When exactly one in-flight worker has a `task_key`, trivial edits auto-attribute to that task.
With **multiple workers**, `GET /dispatcher/children` returns `needs_focus: true` and
`attribution: null` until the dispatcher sets focus via `POST /overlay/dispatcher-focus`.

Each allowed trivial patch POSTs `POST /usage/dispatcher-edit`, which resolves attribution
(`lib/dispatcher-attribution.js`) and appends to `overlay.usage_records[agent_id]` with
`attributed_from: "dispatcher"`. Task totals on the dashboard include these dispatcher-edit
slices alongside worker `/agent/done` samples.

Classify injection includes an `[In-flight workers]` block (`lib/classify-compose.js`) so the
dispatcher sees running workers without claiming.

---

## Usage accounting contract (P5-MS3)

Adapters **translate** IDE-specific transcript layouts into the daemon's uniform shape. The
daemon **stores and sums** — it never walks harness transcript dirs on `GET /costflow` and never
parses IDE JSONL field names.

### Uniform `UsageSlice`

```json
{
  "harness": "claude",
  "agent_id": "…",
  "session_id": "…",
  "transcript_path": "/abs/path.jsonl",
  "task_key": "local/ms3",
  "startedAt": "…",
  "endedAt": "…",
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "by_model": {} },
  "human": { "tokens": 0, "chars": 0, "messages": 0, "dropped": 0 },
  "overhead": { "tokens": 0, "by_category": {} },
  "cost": { "usd": 0, "source": "real", "by_model": { "<model>": { "tokens": 0, "usd": 0 } } }
}
```

**Tokens are the source of truth; `cost` is an ADDITIVE dollar overlay derived FROM them.** The
`cost` block is filled by the adapter's `price()` method (below), never by the daemon. `cost.source`
is `"real"` when `usage` came from a transcript / usage event, `"estimated"` when it came from a
chars/4 fallback. `cost.by_model` mirrors `usage.by_model` keys with `{ tokens, usd }`. An unknown
model prices to `0` (recorded in `cost.unpriced_models`) — pricing never throws.

### Pricing is ADAPTER-OWNED; the daemon only sums dollar subtotals

Per-model USD rates live in a shipped **`pricing.json`** at the repo root (`models.<key>` →
`{ input, output, cache_read, cache_write }` in USD per 1M tokens, plus a `_provenance` block with
source URLs + an as-of date). Rates live in config so a price change is an **edit, not a release**.
Each adapter's `price(slice)` reads `pricing.json`, longest-prefix-matches each `usage.by_model`
model id to a rate row, multiplies token counts by the rates, and fills `slice.cost`. The shared
multiply primitive is `usageAccounting.priceSlice(slice, models)` — harness-agnostic math — but the
**rate lookup and the decision to price stay in the adapter**. The daemon's only role is to SUM the
already-computed `cost.usd` across slices (`sumUsageRecords`, `recordTaskCost`) and propagate the
**weakest** source (any `estimated` slice ⇒ the rolled-up total is `estimated`). The daemon never
embeds rates and never prices inline; on `/agent/done` it may *invoke* `adapter.price(slice)` (an
adapter call), but the logic is the adapter's.

### Adapter `usage` API (each harness implements)

| Method | When | Behavior |
|---|---|---|
| `sample(transcript_path, { baseline?, window })` | `/agent/done` (hot path) | Read **one** file; return one priced `UsageSlice`. |
| `normalizeReported(raw)` | `/agent/done` body | Codex/hookless counts → priced `UsageSlice`. |
| `price(slice)` | after sample/normalize (or daemon-invoked on store) | Read `pricing.json`; fill `slice.cost.usd` + `slice.cost.by_model` from `usage.by_model` token counts. Pricing LOGIC is adapter-owned. |
| `reconcile(workspace, { since })` | Cold path only | Adapter sweeps **its own** dirs; return `UsageReport` (now also carries a summed `cost`). |
| `onSessionStart({ session, workspace })` | `sessionStart` | Stale-at check + arm adapter daily scheduler. |

**Codex capture (CDX-3):** the Codex adapter `reconcile()`/`sample()` sweep the interactive session
rollout JSONL under `~/.codex/sessions` (`CODEX_HOME` override) for the latest
`token_count.total_token_usage` (cumulative per session), and also accept the `codex exec --json`
`turn.completed` / `response.done` `usage` shape. The `adapters/codex/hooks/agent-done.sh` Stop hook
extracts that usage (from hook stdin or the latest rollout file) and forwards it as `reported_usage`
in the `POST /agent/done` body. When no usage event is found, a chars/4 **estimate** is stamped
`cost.source: "estimated"`.

### Hot path (every subagent run)

1. `subagentStart` → `/agent/start` (register `transcript_path`; optional baseline `sample`).
2. `subagentStop` → `/agent/done` → `usage.sample` for `[startedAt, endedAt]` →
   `overlay.usage_records[agent_id]`; set `task_key` when agent held the claim.
3. `complete_task` → status/summary only; **no new sample**. Task total = sum of agent slices.

### Cold path reconcile (two adapter-owned triggers)

Per-harness watermark: `overlay.usage_reconcile[harness].at` (ISO). **No daemon global cron.**

| Trigger | Initiator | Behavior |
|---|---|---|
| **IDE opens** | `sessionStart` → `/workspace` or `/usage/reconcile` | If `at` missing or older than 24h (configurable), run **that harness's** `reconcile()` once; update `at`. Harness not opened ⇒ no sweep. |
| **Long session** | Adapter scheduler on `sessionStart` | Cancel prior wake; arm 24h `ScheduleWakeup` (Claude native; Cursor/Codex MCP/substrate; OpenCode plugin). On fire: curl `/usage/reconcile { harness }` with same stale-at gate. |

`/costflow` and dashboard ticks read `usage_records` + `usage_reconcile_snapshot` only. `/costflow`
additionally emits a summed `cost: { usd, source, by_model }` and `/task/cost` emits `cost_usd` +
`cost_source` alongside the token rollups — both are pure SUMS of per-slice `cost.usd`, never priced
in the route. The dashboard renders `$X.XX` (real) or `$X.XX ≈` (estimated) next to the token
figures; all token rendering and autonomy math is unchanged.

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
This timer delivery does not itself re-prompt Codex Desktop; a host monitor must observe the fire
line and deliver the prompt. Codex's fallback key is never persisted or used as a cross-thread
identity.

### Per-harness exposure

| Harness | Tool surface | Session source | Substrate |
|---|---|---|---|
| **Claude Code** | Native `ScheduleWakeup` (built-in) | Harness session | Native — `lib/adapters/claude.js` returns `{ method: 'native' }`; **not** on default orchestrator MCP |
| **Cursor** | MCP `ScheduleWakeup` (harness-scoped extra tool) | `ORCH_SESSION` from hook context | `lib/schedule-wakeup.js` via `lib/mcp-harness-tools.js` |
| **Codex** | MCP `ScheduleWakeup` (+ harness-scoped `create_task`) | Explicit `session_id`, then hook/context or `ORCH_SESSION`/`ZONOID_SESSION`/`CODEX_THREAD_ID`; otherwise a random MCP-process-local fallback | Same substrate as Cursor |
| **OpenCode** | Plugin tool `schedule_wakeup` | Plugin session id | Same substrate via `packages/opencode-plugin/lib/schedule-wakeup.js` |
| **Default MCP** (`mcp-graph.js`, default `ORCH_CLIENT=claude` or unset) | **Not exposed** | — | Agents use harness-specific MCP config or Claude native |

Classify injection (`POST /classify` → `additional_context`) always includes the heartbeat nudge
referencing `ScheduleWakeup(delaySeconds=7200, …)` regardless of harness; only the **invocation
path** differs per row above.

### Adapter scheduler API (hookless)

`lib/adapters/scheduler-substrate.js` (wired into cursor, codex, opencode, stub):

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
