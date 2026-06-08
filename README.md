# Claude Code Orchestrator

**Auto-routing + a cross-session task-dependency graph, built *on top of* native Claude Code tasks.**

Claude Code already ships the orchestration primitives — the **Workflow** tool, **Agent
Teams**, **ultracode**, and a native **task system** (`TaskCreate`/`TaskUpdate`) with
`blocks`/`blockedBy` dependencies and automatic gating. This tool does **not** reimplement
any of that. It fills two specific gaps native doesn't cover:

1. **Auto-routing** — deciding per prompt whether to go solo / workflow / agent-team,
   without the user typing a keyword.
2. **A cross-session, workspace-wide task-dependency graph** — native task dependencies
   live *only within one session*; there is no unified view or cross-session edge.

> Status: **prototype.** Pillar 1 (router) is working. Pillar 2 is being re-built on top of
> the native task substrate (see Plan below).

---

## Ground truth: how native tasks actually work (verified on disk)

Probed from a real `~/.claude/` install:

- **Storage:** every session writes tasks to `~/.claude/tasks/{session-uuid}/{id}.json`
  (plus a `.lock`). Confirmed `{session-uuid}` == the session's `.jsonl` under
  `~/.claude/projects/{encoded-workspace}/`.
- **Schema:** `{ id, subject, description, activeForm, status, blocks[], blockedBy[] }`.
  `status` ∈ `pending | in_progress | completed | deleted`.
- **Persistence:** durable and indefinite (months-old task files still present). We do **not**
  need to copy tasks for durability.
- **Dependencies:** real — `blocks`/`blockedBy`, set via `TaskUpdate addBlocks/addBlockedBy`,
  with automatic gating ("a pending task with unresolved dependencies cannot be claimed").
- **Sharing:** **none across sessions.** Each session has its own isolated task dir. Two
  sessions in the same workspace do *not* see each other's tasks (only Agent Teams share,
  within one team).
- **Critical gotcha:** task IDs are **local** (`"1"`, `"2"`, …), unique only within a session
  dir. Any cross-session reference must be namespaced **`{session-uuid}/{id}`**.

### What native gives us vs. what we build

| Native (source of truth, read-only) | Our layer (we own) |
|---|---|
| task status, subject, **intra-session** `blocks`/`blockedBy` | **cross-session dependency edges** (`sess/id → sess/id`) |
| durable per-session JSON files | **workspace→sessions→tasks union index** |
| `pending`/`in_progress`/`completed` | **richer statuses** (`not_ready`,`ready`,`tested`,`failed`,`canceled`) as enrichment |
| per-session task panel | **unified workspace web DAG + status line + router** |

---

## Architecture

```
 NATIVE (truth)                         OUR LAYER (mirror + overlay)
 ~/.claude/tasks/{sess}/*.json   ──read──►  aggregator: union all sessions in a workspace
 ~/.claude/projects/{ws}/*.jsonl ──map───►  workspace → session list
 TaskCreated/Completed hooks     ──signal─►  daemon (:8787)
 agents via MCP/curl             ──report─►   ├─ overlay store: cross-session edges,
                                              │   richer status, notes  (persisted per workspace)
                                              ├─ web DAG + status line
                                              └─ router decisions + subagent activity
```

### Three sync sources + reconciliation
Per the design decision, the daemon ingests task state from **all three**, and resolves
disagreement by source authority:

- **File read** (`~/.claude/tasks/*.json`) — **truth for native fields** (status,
  intra-session deps). Undocumented internal format → isolated behind one adapter.
- **Hooks** (`TaskCreated`/`TaskCompleted`) — low-latency *signal*; triggers a re-read of
  that session's files (hooks don't carry deps or `in_progress`).
- **Agent MCP report** — truth for **non-native** fields only: cross-session edges, richer
  status, notes. No conflict with native because native can't hold these.

**Conflict rule:** on a *native* field, the file wins (re-read). Non-native fields exist
only in the overlay, so there's nothing to reconcile.

### Scope model (mirrors native: **workspace / session / task**)
- A **persistent graph = one workspace.** Nodes = tasks of *all* its sessions; its overlay
  (edges, status, notes) is stored per workspace and persists.
- **Local edge** — both endpoints in this workspace (cross-session allowed). Normal dependency.
- **Ghost edge** — the *provider* endpoint is in **another workspace**. A task here can depend
  on / reference a task in another workspace's graph; that foreign endpoint renders as a
  **ghost stub**, not a first-class node of this graph.
- **On-demand, two levels:**
  - ghost *target status* (one task) is resolved lazily during derivation, so a cross-workspace
    dependency can still gate `ready`/`not_ready` — cached per request, cycle-guarded.
  - the foreign *full graph* is loaded only when you explicitly `GET /peek?workspace=…`.
- **Storage rule:** a ghost dependency lives in the **consumer's** overlay (the workspace whose
  task is blocked) — that's the graph whose derivation needs it.

### Data model
```
local key   = "{session}/{id}"                    // within a workspace graph
ghost ref   = { workspace, session, id }          // fully qualified, another workspace
native dep  = blockedBy → same-session local keys
overlay edge = { from, to, fromWorkspace? }       // fromWorkspace set ⇒ ghost (foreign provider)
              "A depends on B(other ws)" = { from:"sessB/idB", fromWorkspace:B, to:"sessA/idA" }
status      = overlay.status[key]  ??  derive(native.status, deps)
              derive: completed→done · in_progress→in_progress
                      pending→ (all deps done ? ready : not_ready)   // deps may be ghost
```

---

## Components (target)

| File | Role | Status |
|------|------|--------|
| `lib/native-tasks.js` | Workspace→sessions→tasks aggregator + ID namespacing. | ✅ done |
| `daemon.js` | Serves the unioned graph; holds the overlay store; router/agent observability. | ✅ done |
| `lib/overlay.js` | Persisted per-workspace overlay (edges, status, notes). | ✅ done |
| `public/graph.html` | Live workspace DAG (native + cross-session edges + statuses). | Phase 5 |
| `hooks/start-daemon.sh` | `SessionStart` — boots daemon, registers workspace. | done (extend) |
| `hooks/classify.sh` | `UserPromptSubmit` — router classifier. | done |
| `hooks/task-changed.sh` | `TaskCreated`/`TaskCompleted` — signal daemon to re-read. | Phase 3 |
| `hooks/subagent-*.sh` | subagent activity. | done |
| `hooks/orch-gate.sh` | `PreToolUse(Write\|Edit)` — denies inline edits unless this conversation has a task claimed `in_progress` (exit 2). **Default-on** (opt out per-conversation with `orch off`), not in live settings. | done |
| `hooks/statusline.sh` | status line. | done (extend) |
| `mcp-graph.js` | MCP (stdio): `get_full_graph` / `get_adjacent` / `set_status` / `add_dependency` / `peek_workspace`. Zero-dep proxy over the daemon. | ✅ done |
| `~/.claude/skills/parallel-orchestrate/SKILL.md` | router target; instructs native `TaskCreate`+deps. | done (extend) |

---

## Implementation plan

**Phase 1 — Native aggregator** (`lib/native-tasks.js`) ✅ DONE
- Encode workspace path → projects dir; list session UUIDs; read each session's task JSON;
  union into namespaced `{key, session, label, native_status, deps[]}`.
- *Verified:* 38 real tasks unioned across 5 task-bearing sessions of a real workspace.

**Phase 2 — Overlay store + daemon integration** ✅ DONE
- Persisted per-workspace overlay (`~/.claude/orchestrator/overlay/{encoded}.json`):
  `{ edges[], status{}, notes{} }`.
- Daemon: `POST /workspace`, `GET /state` (native union + overlay merge), `POST /overlay/edge`,
  `POST /overlay/status`, `GET /task/adjacent`. Derives the 7-status lifecycle.
- *Verified:* native `blockedBy` → derived ready/not_ready propagation; **cross-session edge
  blocks/unblocks across sessions**; `failed` override; overlay persists to disk; adjacency view.

**Phase 2.5 — Cross-workspace ghost edges** ✅ DONE
- Workspace = the graph unit. Ghost edge = dependency whose provider is in another workspace;
  stored in the consumer's overlay; foreign status resolved on demand (cached, cycle-guarded);
  `GET /peek?workspace=…` loads a foreign graph on demand.
- *Verified (two-workspace fixture):* X's task blocked by Y's task → `not_ready`; Y's provider
  completing flips X to `ready` via on-demand re-read; ghost stub + `/peek` + consumer-only
  storage all correct.

**Phase 3 — Sync sources** ⏳ partial (functional without it)
- `SessionStart` hook now registers the workspace (`POST /workspace` with `cwd`). The daemon
  re-reads native task files **live on every `/state`**, so new tasks already appear without a
  restart — the event-driven `TaskCreated`/`TaskCompleted` refresh is now just an optimization
  (caching) we can add later, not a correctness need.

**Phase 4 — MCP graph server** (`mcp-graph.js`, project-scoped `.mcp.json`) ✅ DONE
- Stdio JSON-RPC, zero-dep proxy over the daemon. Tools: `get_full_graph`, `get_adjacent`,
  `set_status`, `add_dependency` (with `from_workspace` for ghost edges), `peek_workspace`.
- *Verified:* full MCP session (initialize → tools/list → tools/call) drives daemon state;
  `set_status` via MCP flips a dependent from `not_ready`→`ready`. Async responses drain
  before exit on stdin close.

**Phase 5 — Web DAG v2** ✅ DONE
- Topological DAG with the 7 status colors; **in-progress tasks pulse** and show a `▶ agent`
  badge (live "who's working on what"); ghost stubs render dashed in a trailing column.
- **Dependency edges drawn as SVG lines**: local edges are **solid grey**, cross-workspace
  **ghost edges dashed purple**. The header has an **"Add ghost edge"** control (two task
  selects + an optional workspace input + **Add** → `POST /overlay/edge`) for wiring a
  cross-workspace dependency straight from the dashboard.
- **Click any task → detail drawer**: brief, status, summary (interface), dependencies,
  Tier-2 knowledge items, **token usage** (summed from the agent's transcript), and a link to
  the subagent transcript. Router-decision + subagent feeds below.
- *Verified:* served + animation/detail markers present.

**Phase 6 — Two-tier context router** ✅ DONE
- `complete_task(summary)` stores a task's interface; dependents pull all dep summaries via
  `get_dependency_summaries` (**Tier 1**, cheap) and deep-fetch a specific task via
  `get_task_detail` (**Tier 2**) only when needed. `attach_knowledge` adds Tier-2 items.
- *Verified:* summary handoff, knowledge attach, real token usage on a fixture.

**Phase 7 — Productization** ✅ DONE
- **Plugin package:** `.claude-plugin/plugin.json` + `hooks/hooks.json` + `.mcp.json` + bundled
  `skills/` — installs via `/plugin` with no edit to the user's `settings.json`. Paths use
  `${CLAUDE_PLUGIN_ROOT}`; state uses `${CLAUDE_PLUGIN_DATA}`.
- **Per-conversation toggle:** ON by default; `orch off` opts a conversation out (creates a
  per-`session_id` `.off` marker), `orch on` re-enables (removes it). Every hook gates on the
  *absence* of that `.off` marker. *Verified.*
- **Setup doctor** (`skills/setup`): checks daemon, version, Agent-Teams/workflow flags, the
  toggle, and offers consented enable of Agent Teams.

**Phase 8 — Heartbeat loop** ✅ DONE
- Daemon is the decider: `next_action` returns `spawn`/`idle`/`stop` + adaptive
  `next_poll_seconds`; hard caps (token budget + iteration cap) and auto-stop on drain;
  ghost-blocked tasks back off to `maxPoll` instead of stopping. Skill: `orch-loop` (uses
  `ScheduleWakeup`). *Verified across all states incl. caps and ghost-wait.*

### MCP tools (`mcp__orchestrator-graph__*`)
`get_full_graph` · `get_adjacent` · `get_dependency_tree` (vertical) · `start_task` ·
`complete_task` · `set_status` · `get_dependency_summaries` (Tier 1) · `get_task_detail`
(Tier 2) · `attach_knowledge` · `add_dependency` (ghost via `from_workspace`) ·
`peek_workspace` · `next_action` · `loop_start` · `loop_stop` · `loop_status`

Self-learning git tools: `git_init` · `branch_task` · `git_status` · `merge_attempt` ·
`remove_worktree`.

---

## Self-learning loop (branch → test → judge → merge → record)

The orchestrator can run **rival attempts** at one problem in isolation, then learn from which
one won. The daemon stays **dumb** — it only exposes isolated git worktrees and a merge
primitive; the judgement is a **subagent skill** (`skills/self-learn-judge`).

**The loop:**

1. **Branch.** For a problem task `P`, spawn N **attempt** tasks `A1..An`. Each calls
   `branch_task` to get its own worktree on branch `orch/attempt/<key>` (foundation: isolated,
   side-by-side experiments that can't clobber each other).
2. **Test.** Each attempt works in its worktree and runs to `tested` (its tests passed) or
   `failed`.
3. **Judge.** A **judge** task `J` is `blocked_by` all attempts, so it only goes `ready` once
   every attempt finishes. `J` may be a separate "resolve P" node or `P` itself. The
   `self-learn-judge` skill drives the judge subagent: read each attempt's outcome
   (`get_dependency_summaries` + `get_task_detail`), pick the winner (test outcome first, then
   rationale).
4. **Merge.** `merge_attempt(winner_key)` folds the winning branch back into the base with
   `git merge --no-ff`. On conflict it **auto-aborts** (clean tree) and returns
   `{conflict, files}` — the judge then records the conflict instead of forcing a merge.
5. **Record.** Losers are `set_status(..., 'canceled')` + `remove_worktree`; the verdict
   (`{winner, why, losers, merged, date}`) is `attach_knowledge`-d to `P` as a durable Tier-2
   note — the learning the loop produces. If **no** attempt passed, the judge records a
   no-winner verdict and flags for guidance (foundation for the later escalation work) rather
   than merging anything.

**Daemon/git surface:** `POST /git/init`, `GET /git/status`, `POST /git/worktree`,
`POST /git/worktree/remove`, `POST /git/merge` (body `{key, message?}` → `{merged,head,branch}`
or `{merged:false, conflict, files}`). All backed by `lib/git.js`
(`createWorktree`/`removeWorktree`/`mergeBranch`/`currentBranch`), exercised by
`test/git.test.js` and `test/git-merge.test.js`.

---

## Daemon surface additions ✅

These are cross-phase capabilities of the daemon (`:8787`), all implemented + verified.

### Optional bearer-token auth
Auth is **opt-in** and **off by default** (back-compat: no token ⇒ every endpoint open, as
before). A token is read from the env var `ORCH_TOKEN` or, if unset, a `<BASE>/token` file
(`null`/absent ⇒ disabled). When a token *is* set:

- **Write endpoints require it:** `/mcp`, `/reset`, `/overlay/*`, `/loop/start`, `/loop/stop`.
- **Reads stay open:** `/state`, `/task/*`, `/events`, `/graph`, etc. need no token.
- **Three ways to present it:** `Authorization: Bearer <token>` header, `x-orch-token: <token>`
  header, or a `?token=<token>` query param (so a single connector URL can carry it).

Set `ORCH_TOKEN` whenever you **expose the daemon beyond localhost** (e.g. through a tunnel)
so the write surface and `/mcp` aren't open to the network. The MCP proxy and inline UI pass
the token through automatically when it's configured.

### Active-claim read (`GET /active-claim`)
Read-only endpoint for the `orch-gate.sh` PreToolUse hook: returns the tasks currently
`in_progress` (`{ claimed, claims: [{key,label,session,agent_id}] }`). An optional
`?session=<id>` filters to claims whose task belongs to that conversation, so the gate can ask
*"does THIS session hold a claim?"* without scanning all of `/state`. Stays open (no token).

### SSE live push (`GET /events`)
The daemon exposes `GET /events` as a `text/event-stream`. On any mutation it broadcasts a
`data: changed` event; the browser web view and the inline UI subscribe via `EventSource` and
**refresh instantly** instead of waiting on a timer. A **slow poll fallback** still runs, so
the UI stays correct if the SSE stream drops or the client can't hold it open.

### Multi-workspace reads (`?workspace=`)
The GET read endpoints — `/state`, `/task/context`, `/task/detail`, `/task/tree`,
`/task/adjacent` — accept an optional `?workspace=<abs path>` to serve **any** workspace's
graph, defaulting to the current one when omitted. This lets a single daemon read across
workspaces without a restart. **Limitation (by design):** *writes* (`/overlay/*`, `/reset`,
loop control) still target the **current** workspace only.

---

## Install as a plugin
`/plugin marketplace add <owner>/<repo>` → `/plugin install orchestrator@<marketplace>`
(or `claude --plugin-dir ~/.claude/orchestrator` for local dev). The status line is the one
piece that may still need a manual `settings.json` line (`subagentStatusLine` vs `statusLine`
in plugins is unconfirmed). Conversations are enabled by default; opt out with `orch off`. Watch `http://localhost:8787/graph`.

---

## Install

Copy `orchestrator/` to `~/.claude/orchestrator/`, the skill to
`~/.claude/skills/parallel-orchestrate/`, and merge `settings.sample.json` into
`~/.claude/settings.json`. For the MCP graph tools, add `.mcp.json` to the workspace root.

## UI surfaces
**The default UI needs no HTTPS, no certs, and no browser** — everything below runs over plain
`http://localhost` with **SSE** (`/events`) for live updates. SSE pushes changes; it does *not*
require TLS. The two confirmed surfaces, best-integrated first:

1. **Desktop preview panel:** `orchestrator-dashboard.html` in the workspace opens in the
   app's preview pane and live-updates over HTTP+SSE (CORS-open). **Confirmed working.**
2. **Browser:** `http://localhost:8787/graph` — the full web view, same HTTP+SSE feed.

The main agent surfaces the dashboard link (`http://localhost:8787/graph`) in its replies, so
it's always one click away when the panel isn't already open.

### Optional / advanced: inline-in-chat via a connector (HTTPS)
The `show_dashboard` tool renders the `ui://orchestrator/graph` resource as an MCP-App panel
**inside the conversation** (spec-correct per SEP-1865). This surface only renders when the
daemon is added as a **remote connector**, which wants an **HTTPS** endpoint — the *only* reason
HTTPS enters the picture. Set it up with `scripts/setup-https.sh` (mkcert) **only if** you want
inline-chat rendering or plan to expose the daemon off-localhost (a tunnel, where HTTPS pairs
with the bearer token). For normal local use, **skip it** — surfaces 1–2 are the product.

> Why a self-signed cert won't shortcut this: TLS validates the cert's *issuer* against the
> system trust store, regardless of `localhost`. A self-signed cert is its own (untrusted)
> issuer → clients reject it. `mkcert -install` adds a *trusted* local CA (the password step),
> which is the whole reason it works where a bare self-signed cert doesn't.

## Desktop-app (hookless) mode
The desktop app runs MCP servers (`.mcp.json`) but not `settings.json` hooks. So the MCP
server **self-boots the daemon** and registers the workspace on startup — the graph + all 16
tools work with zero hooks. Hook-only features (auto-router, terminal status line) need the
CLI; substitutes: invoke the `parallel-orchestrate` skill explicitly; use the inline/preview UI.

## PreToolUse edit gate (default-on)
`hooks/orch-gate.sh` enforces *"no inline `Write`/`Edit` without a claimed `in_progress` task"*.
On a `Write`/`Edit` it reads the daemon's `GET /active-claim?session=<id>`; if no task is claimed
`in_progress` for this conversation it prints a message to stderr and exits **2** (deny — the
proven blocking exit code in this harness). It is **on by default**; a conversation opts out with
`orch off` (which drops a `sessions/<id>.off` marker, same gate as the other hooks). It **fails open** if
the daemon is unreachable, so a daemon outage never bricks editing.

- **Escape hatch:** `export ORCH_GATE_OFF=1` to always allow.
- **Wiring is still your call.** Once wired it is active by default for every conversation
  (opt out per-conversation with `orch off`, per-edit with `ORCH_GATE_OFF=1`). To wire it, add this
  one entry to `~/.claude/settings.json` under `hooks` (it's already in `settings.sample.json` /
  `hooks/hooks.json`):

  ```json
  "PreToolUse": [
    { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "~/.claude/orchestrator/hooks/orch-gate.sh" }] }
  ]
  ```

- **Honest limit:** the gate enforces task *existence* (a claimed `in_progress` task for this
  session), **not status truth** — a rubber-stamp task created and `start_task`'d purely to pass
  the gate will satisfy it. It raises friction against undisciplined edits; it does not verify the
  edit matches the task.

## Hardening (addressed)
- **Perf/reactivity:** TTL cache + `fs.watch` invalidation on the task dir — no re-read per call;
  plus **SSE push** (`/events`) so the UI updates on mutation instead of polling.
- **Volatility:** loop state persisted to disk (`loop.json`), resumes on daemon restart.
- **Workspace persistence:** the current workspace is persisted to `<BASE>/workspace` and
  **restored on respawn**, so the daemon comes back pointing at the right graph.
- **Auth:** optional bearer token (`ORCH_TOKEN` / `<BASE>/token`) gates `/mcp` + writes when set;
  off by default for back-compat (see *Daemon surface additions*).
- **Loop budget:** real token accounting from the main transcript (estimate fallback); hard
  iteration + token caps; auto-stop on drain.
- **Undocumented native format:** `formatHealth` + `/health` fail *loud*; doctor surfaces drift.
- **Hook reliability (#27755):** correctness is hook-independent (MCP `start_task`/`complete_task`
  are authoritative); the `PostToolUse` nudge + `SubagentStop` are best-effort acceleration.
- **HTTP framing:** responses send `Connection: close` to avoid keep-alive request-splitting.
- **Review pass (applied):** auth is **default-deny allowlist** (cross-workspace `?workspace=`
  reads + `/peek`, `/config`, `/route`, `/agent/*` gated when a token is set); overlay writes are
  **atomic** (temp+rename) and use a **collision-free filename** (hash, with legacy-file migration);
  the MCP client surfaces non-2xx daemon responses as errors (no more silent success); cycle-guard
  no longer poisons the status memo; UI escaping covers quotes; SSE evicts dead clients.
- **Regression safety:** `test/smoke.sh` (13 checks) covers core + every mitigation above, and is
  now **safe to run alongside a live daemon** — PID-based start/stop, an isolated
  `CLAUDE_PLUGIN_DATA`, and port-specific kills mean it won't disturb your running instance.

## Known constraints / honesty notes

- **Native task file format is undocumented/internal** — may change across Claude Code
  versions. All file access is isolated in `lib/native-tasks.js` so only one adapter breaks.
- Writing native task files directly is unsafe (`.lock`, may be overwritten) — we **read**
  native and keep our additions in the overlay; agents mutate native only via `TaskUpdate`.
- Cross-session sharing is **our** overlay; native has none outside Agent Teams.
- Auto-routing is advisory (hooks can't force ultracode/workflow).
- No per-subagent token counts (not exposed by hooks).

## Requirements
Node (stdlib), `curl`, `jq`, `python3`. Tested on macOS.
