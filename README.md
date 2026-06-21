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

## Dashboard

```
http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>
```

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
| `show_dashboard` | Render the task-graph dashboard inline in the conversation (interactive, live-updating) |

## Development

```sh
npm test           # fast regression (single gate test)
npm run test:all   # full suite via scripts/run-tests.js
```

CI (`.github/workflows/test.yml`) runs `npm run test:all` on every push and PR.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the testing conventions.

## License

Apache-2.0. Contributions require a signed CLA — see [CONTRIBUTING.md](CONTRIBUTING.md).
