# Zonoid

The agent's subconscious for coding work.

Zonoid gives AI coding agents a project-local layer that activates relevant task history,
decisions, failures, risks, costs, and learned skills exactly when they should affect the
next move. It is not a chat log and not a memory dump. It is the experience graph behind
the agent's reasoning.

Most AI coding agents start every session cold. The ones that add memory inject everything
they've ever seen, burning tokens on context the current task doesn't need. Zonoid does
neither.

It is a local daemon that makes the work graph and the knowledge graph the same structure.
When a task completes, it leaves a knowledge note on the graph. When a new task starts, the
Subconscious activates only the notes its dependency edges point to, under a token budget:
summary-tier first, full knowledge on demand. The agent sees what this task depends on,
what previous attempts cost, and what actually worked, while a shadow gate measures whether
each retrieval paid off.

```
agent prompt
   |
   v
Zonoid Subconscious
   |-- task history and decisions
   |-- failures, risks, costs, verdicts
   |-- learned skills and reusable patterns
   v
next action with relevant context
```

```
without Zonoid                       with Zonoid

agent starts cold every run    ->    subconscious activation from the
                                      task's prior experience graph

memory = inject everything     ->    memory = traverse the dependency edges
                                      that point to this task, within budget

"did memory help?" = unknown   ->    cold 0/8 -> warm 8/8 on held-out bench
                                      (published, with the nulls)
```

- **Agent subconscious:** relevant task history, risks, decisions, and learned skills activate
  at the moment of decision, rather than flooding every session up front
- **DAG = RAG:** the dependency graph routes knowledge — no separate retrieval index, no
  annotation step; completing a task IS writing memory
- **Token-aware:** two-tier handoff (2k-token summaries first, full knowledge on demand),
  with a shadow gate scoring whether each retrieval paid — toward a learned inject policy
- **Receipts:** every knowledge note carries which task produced it, which superseded it,
  and what it cost — bi-temporal provenance, not an append-only log
- **One-command setup:** wires MCP + pre-tool hooks into any Claude Code project in under a minute

## Install

```sh
npx @zonoid/cli init
```

Adds a task-graph daemon at localhost:8787, a pre-tool hook that gates edits behind task claims,
an MCP surface that lets the agent read and write the knowledge graph, and a local pre-push test
guard for Node repos with an npm test script.

The pre-push guard runs `npm run test:all` when present, otherwise `npm test`, and blocks pushes on
failure. Local Git hooks are bypassable with `--no-verify`; CI and branch protection are the
server-side backstop.

## How it works

The work graph and the knowledge graph are the same structure. Each node is both
a task (with status, dependencies, and a claim gate) and a potential knowledge
source (its completion summary and attached notes flow forward along context edges).

```
  task A ──context edge──▶ task B ──context edge──▶ task C
    │                        │                        │
  complete                 start                    start
    │                        │                        │
  leaves note              inherits A's note         inherits B's note
  on the graph             under token budget         (A's note already
                                                       in B's summary)
```

Every Write or Edit tool call passes through orch-gate.sh (PreToolUse hook).
The gate checks /active-claim?session=<id> on the daemon — no claimed task = blocked.
This means every file change in the repo has a named task as its reason.

```
┌─────────────────────────────────────────┐
│            Claude Code Agent            │
│  (TaskCreate → start_task → edit files) │
└────────────┬────────────────────────────┘
             │ every Write/Edit tool call
             ▼
┌─────────────────────────────────────────┐
│         orch-gate.sh (PreToolUse)       │
│  checks /active-claim?session=<id>      │
│  ┌─ no claim  ──► EXIT 2 (blocked)      │
│  └─ claimed   ──► EXIT 0 (allowed)      │
└────────────┬────────────────────────────┘
             │ HTTP :8787
             ▼
┌─────────────────────────────────────────────────────────────┐
│                  Zonoid Daemon (daemon.js)                   │
│                                                             │
│   Unified graph: every node is a task AND a knowledge node  │
│                                                             │
│   task A ──[context]──▶ task B ──[context]──▶ task C        │
│      │                     │                                │
│   summary + notes       inherits A's                        │
│   written on complete   summary + notes                     │
│                         on start_task                       │
│                                                             │
│   shadow gate: scores whether each retrieval paid           │
│   token budget: 2k summary tier → full knowledge on demand  │
└────────────────────────────────────┬────────────────────────┘
                                     │ MCP (stdio)
                                     ▼
┌─────────────────────────────────────────┐
│  start_task · complete_task · set_status│
│  search_knowledge · suggest_links       │
│  record_decision · get_graph       │
└─────────────────────────────────────────┘
```

## Evidence

Memory helps when the fact is empirical, local to your project, and not already in
the model's pretraining — roughly a quarter of knowledge-dependent tasks on our own corpus.

**Held-out causal wins (what survived our benchmark protocol):**

| Arm | Result | Notes |
|---|---|---|
| Cold (no KB) | 0/8 correct | de-DE decimal locale format — agent could not reconstruct from scratch |
| Warm (KB seeded) | 8/8 correct | agent cited the retrieved note verbatim in its solution |
| Cold (no KB) | 0/10 correct | window-correlation task — zero variance across trials |
| Warm (KB seeded) | 8.75/10 correct | same task, warm arm reproduced the solution |

**Retrieval scorecard:** recall@5 0.91 / MRR 0.82 (`bench/retrieval/scorecard.md`)

**Bi-temporal retrieval:** 1.0 vs 0.6 recall@5 on as-of queries (`bench/temporal/report.json`)

**What we invalidated:** our first seven ON-vs-OFF benchmark versions shipped their acceptance
tests inside the agent's worktree. The rigging guard on the eighth attempt caught the cold arm
reverse-engineering answers from the committed test. Those seven versions are excluded from this
release and we make no claims on them. The protocol that caught it — held-out grading where the
agent solves from a prose spec and an external suite it never sees grades the frozen artifact,
with a cold-arm-must-fail guard before any win is claimed — is the benchmark that ships with
this repo (`bench/heldout/`).

We are the only agent memory project we are aware of that publishes its null results and
retracts contaminated numbers publicly.

## Self-improvement loop

After each session, Zonoid mines the completed task graph and agent transcripts for reusable patterns —
architectural decisions, gotchas, constraints — and queues them for LLM evaluation. Accepted
candidates are injected as knowledge notes into the graph. Future sessions inherit those notes
as Tier-1 context via `search_knowledge` and `suggest_links`, so the agent starts each run with
the accumulated findings of every prior session rather than a blank slate.

## Orch auto (full autonomy)

`orch auto` is a one-switch, per-workspace toggle that lets the daemon advance the task graph
with zero interactive sessions. It atomically sets three workspace config flags (and `orch auto
off` clears all three):

- `self_plan` — the daemon planner may propose next steps on a drained DAG.
- `automode` — escalations (`request_guidance`) are auto-answered by an LLM subprocess, judge
  APPROVE verdicts auto-merge, and the review-verdict drain becomes eligible.
- `headless_driver` — the daemon executes spawn/plan/optimize decisions and review verdicts
  headlessly instead of waiting for an interactive driver.

Three surfaces, one code path (`POST /config { auto: true|false }` expands to the three flags
server-side):

```
say "orch auto" / "orch auto off" in a conversation      # classify hook
Dashboard → Settings → "Orch Auto (full autonomy)"       # next to Full Automode
curl -XPOST localhost:8787/config -d '{"workspace":"<path>","auto":true}'
```

The flags live in each workspace's overlay config, so every registered workspace toggles
independently — nothing is daemon-global. Each flag also remains individually settable. Budget
caps still govern autonomous work: managed loops run under the loop-autostart config and
headless drains under the drain governor's per-boot token/concurrency budget.

## Tuning (persisted, hot-reloadable)

The drain/worker tuning knobs resolve **env > file > default**. The file is
`<runtime dir>/tuning.json` (override with `ORCH_TUNING_FILE`), so a retune survives a reboot
instead of dying with the shell that exported it.

| knob | env var | default |
| --- | --- | --- |
| `drain_max_concurrency` | `HEADLESS_DRAIN_MAX_CONCURRENCY` | 2 |
| `drain_token_budget` | `HEADLESS_DRAIN_TOKEN_BUDGET` | 200000 |
| `drain_max_iterations` | `HEADLESS_DRAIN_MAX_ITERATIONS` | unbounded |
| `drain_timeout_ms` | `HEADLESS_DRAIN_TIMEOUT_MS` | 300000 |
| `spawn_timeout_ms` | `HEADLESS_SPAWN_TIMEOUT_MS` | 1800000 |
| `continuous_delay_ms` | `HEADLESS_DRAIN_CONTINUOUS_DELAY_MS` | 15000 |
| `idle_poll_ms` | `HEADLESS_DRAIN_IDLE_POLL_MS` | 120000 (+ per-runner jitter) |
| `retry_delay_ms` | `HEADLESS_DRAIN_RETRY_DELAY_MS` | 5000 |
| `judge_budget` | `HEADLESS_DRAIN_JUDGE_BUDGET` | 20 |
| `judge_max_per_tick` | `HEADLESS_DRAIN_MAX_PER_TICK` | unbounded |
| `learner_max_per_tick` | `HEADLESS_DRAIN_LEARNER_MAX_PER_TICK` | min(1, `drain_max_concurrency`) |

**No knob requires a restart.** Every consumer re-resolves per use and the file parse is cached on
mtime, so a write lands on the next pump. `GET /config/tuning` reports `restart_required: []`.

```sh
# read: effective values + which tier won each one
node scripts/tuning.js get
curl localhost:8787/config/tuning

# write (daemon running or not) — takes effect on the next pump
node scripts/tuning.js set drain_max_concurrency=6 drain_token_budget=5000000 \
  spawn_timeout_ms=3600000 continuous_delay_ms=5000 idle_poll_ms=45000 retry_delay_ms=3000

# or over HTTP
curl -XPOST localhost:8787/config/tuning -d '{"set":{"drain_max_concurrency":6}}'

# revert a knob to env/default
node scripts/tuning.js unset judge_budget
```

`GET /status` carries the same view (`tuning.values` + `tuning.sources`), and the daemon prints the
effective knobs plus the file path in its two `[boot] tuning:` lines.

## Run the daemon at logon (Windows)

The daemon is registered as a **scheduled task**, not a Windows service: a service runs in session 0
with no user profile, and the daemon spawns agentic CLI backends that authenticate as the
interactive user.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Install
powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Start
powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Uninstall
```

`-Install` is idempotent (it re-registers) and takes `-RepoPath`, `-NodePath`, `-Port` and
`-TaskName` overrides. Output is not re-plumbed here: the daemon already tees stdout/stderr to
`<runtime dir>/daemon.log` (size-rotated, always on).

The installer can do this for you:

```sh
node bin/install.js --windows-service
```

## Dashboard

```
http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>
```

Call `show_dashboard` from any MCP client. It returns a versioned `launch` descriptor with the
inline MCP resource, the workspace-scoped HTTP URL, and capability-based presentation choices.
Clients can select an MCP App, an embedded web surface, or the universal external-browser fallback
without relying on client names or private APIs. The legacy `browser_url` and `deep_link` fields
remain aliases of `launch.url`.

The same contract is available from the command line:

```sh
zonoid-dashboard --workspace /path/to/repo --json
zonoid-dashboard --workspace /path/to/repo --open
```

The default origin is `http://localhost:8787`. Set `ZONOID_DASHBOARD_ORIGIN` or pass `--origin`
when the daemon is exposed through another HTTP(S) origin. Origins containing credentials, paths,
query parameters, or fragments are rejected, and launch URLs never carry the daemon auth token.
The daemon remains the dashboard data/API backend; the presentation path does not require CDP,
private DOM injection, or a custom URL scheme.

### Operational dashboard views

Kanban Board is the first-visit operational view. Its observational v1 contract maps tasks into
Queue, Ready, WIP, Review, and Done; it does not support drag-and-drop status changes. The board
scope is the current Frontier plus explicit `kanban_pin` tasks and tasks with unresolved user
gates. Internal drains, judge wrappers, and note/knowledge nodes are excluded. Done shows the 12
most recently changed terminal tasks and keeps the complete, paginated terminal-task set under
**History**.

Dashboard state refreshes from the workspace SSE stream with a safety poll. Task selection and the
inspector are shared across Kanban, Frontier Tasks, Force Cloud, and Focus View; Focus returns to
the originating tab, and each view preserves its own filters and navigation state. Kanban cards are
native keyboard-operable buttons, lanes have accessible labels, and narrow screens retain all five
lanes through horizontal scrolling while the inspector overlays the board.

VS Code and Cursor can also use the bundled editor panel. `zonoid init --harness cursor`
installs it additively with the Cursor CLI; the equivalent VS Code command is:

```sh
code --install-extension /path/to/zonoid/packages/vscode-dashboard/zonoid-dashboard-0.1.0.vsix
```

Run **Zonoid: Open Dashboard** from the Command Palette for the embedded panel, or
**Zonoid: Open Dashboard in Browser** for the external fallback. In remote workspaces the
extension resolves the daemon URL with the editor's public `asExternalUri` API before either
presentation, so the editor owns localhost forwarding and URL rewriting.

Claude Desktop can install the bundled
`packages/claude-dashboard-mcpb/zonoid-dashboard.mcpb` extension and render the existing MCP App.
The extension is a small launcher, not a second dashboard: installation asks for the existing
Zonoid checkout that contains `mcp-graph.js`. Rebuild the checked artifact deterministically with
`npm run build:claude-dashboard`. Claude Code keeps its existing `.mcp.json` wiring and uses
`show_dashboard` or `zonoid-dashboard --open`; it does not render Claude Desktop extensions.

OpenCode gets a `dashboard_open` plugin tool and an additive project command at
`.opencode/commands/dashboard.md`. Run `/dashboard` in the TUI to invoke it. OpenCode does not
embed arbitrary dashboard HTML in the TUI, so the tool opens the validated, workspace-scoped URL
in the system browser and still returns the complete launch descriptor if the opener fails.

## MCP tools

47 tools, served identically over both transports (stdio and the daemon's `/mcp` endpoint). The
live registry is the `TOOLS` array in `lib/mcp-core.js`. (Tasks themselves are created with
Claude Code's native `TaskCreate`; these tools manage them once they exist.)

### Task lifecycle

| Tool | Purpose |
|---|---|
| `start_task` | Claim a task and mark it in_progress, recording which agent is working it |
| `complete_task` | Mark a task done and record a concise summary other tasks pull as cheap base context |
| `set_status` | Set the overlay status for a task (prefer start_task/complete_task) |
| `configure_task` | Configure a task's execution settings in one call: repo path, test command, metric spec, benchmark |
| `add_dependency` | Add a dependency edge — blocking prerequisite or non-blocking context link |
| `remove_dependency` | Remove a dependency edge from → to (idempotent) |
| `mark_root` | Declare a task a genuine root (no prerequisites, no context providers) |
| `supersede_task` | Retire an old task in favor of a replacement, linking them |

### Graph reads

| Tool | Purpose |
|---|---|
| `get_graph` | Get the workspace task graph or a focused slice of it (frontier digest by default) |
| `get_dependency_summaries` | Tier 1 (cheap, do first): concise summaries of a task's dependencies |
| `get_task_detail` | Tier 2 (on demand): full detail for one task — knowledge, summary, agent, token usage |
| `suggest_links` | Suggest existing tasks (including completed ones) a task should link to, ranked by overlap |
| `graph_delta` | What changed in the graph since a timestamp — the read-only change sensor for QA sweeps |
| `peek_workspace` | Load another workspace's full task graph on demand (does not change current) |

### Knowledge & notes

| Tool | Purpose |
|---|---|
| `search_knowledge` | Retrieve the most relevant knowledge notes (decisions / gotchas / constraints) for a free-text query |
| `ask_subconscious` | Ask a per-agent Subconscious for a verdict or prediction using internal context search and recent agent state |
| `subconscious_loop` | Record or read daemon-owned Subconscious loop state and bounded tick/observation history |
| `subconscious_anchor_allocator` | Record or read process-local Subconscious task anchors and proposed DAG wiring metadata |
| `record_decision` | Capture a durable decision, rationale, or finding as a note node in the graph |
| `supersede_note` | Mark an existing note as superseded by a newer one without deleting history |
| `attach_knowledge` | Attach a Tier-2 knowledge item (file / snippet / link / note) to a task |

### Judge & KB

| Tool | Purpose |
|---|---|
| `branch_task` | Create an isolated git worktree + branch (`orch/attempt/<key>`) for a task attempt |
| `merge_attempt` | Merge a winning attempt's branch back into the base |
| `remove_worktree` | Remove a task attempt's git worktree and delete its branch (idempotent cleanup) |
| `measure_task` | Run the task's inline metric spec and store the measured value(s) on the node |
| `get_learnings` | Aggregate the graph's accumulated learning: attempt verdicts, recent failures and completions |
| `enqueue_kb` | Mine a repo and enqueue all KB candidates into the learner queue (no cap, no LLM) |
| `drain_kb_batch` | Process one batch of queued KB candidates via LLM |
| `drain_kb_queue` | Fire-and-forget background drain of the full KB queue; review output, then inject explicitly |
| `drain_kb_queue_status` | Get the current status of a background drain job |
| `inject_kb` | Explicitly inject reviewed onboarding KB notes into the graph |

### Loop & agent control

| Tool | Purpose |
|---|---|
| `next_action` | Heartbeat: per-loop spawn/idle/plan/stop actions for the whole loop registry in one call |
| `loop_control` | Manage heartbeat loops — one tool, action: start / stop / status |
| `list_agents` | List every known agent across sessions with its task, workspace, and stop flag |
| `request_agent_stop` | Cooperatively stop a worker by agent_id or task_key (advisory flag, no kill) |
| `request_guidance` | Halt the autonomous loop and ask the user instead of guessing |
| `list_guidance` | List unresolved guidance questions the loop is waiting on |

### Misc

| Tool | Purpose |
|---|---|
| `show_dashboard` | Render the live inline summary and return a client-neutral launch contract for the scoped full dashboard |

## Development

```sh
npm test           # fast regression (single gate test)
npm run test:all   # full suite via scripts/run-tests.js
```

CI (`.github/workflows/test.yml`) runs `npm run test:all` on every push and PR.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the testing conventions.

## License

Apache-2.0. Contributions require a signed CLA — see [CONTRIBUTING.md](CONTRIBUTING.md).
