# Zonoid

Every AI edit, tracked. Every lesson, kept.

Zonoid is a task-graph daemon that gates AI agent file edits behind named tasks and builds a
persistent knowledge base from each session — observability and traceability for AI coding agents.

- **Traceable edits:** agents must claim a task before touching a file; every change has a named reason
- **Persistent context:** session discoveries are mined, LLM-evaluated, and injected into future runs
- **One-command setup:** wires MCP + pre-tool hooks into any Claude Code project in under a minute

## Install

```sh
npx @zonoid/cli init
```

Adds a task-graph daemon at localhost:8787, a pre-tool hook that gates edits behind task claims,
and an MCP surface that lets the agent read and write the knowledge graph.

## How it works

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
│  ┌─ no claim ──► EXIT 2 (blocked)    │  │
│  └─ claimed  ──► EXIT 0 (allowed)    │  │
└────────────┬────────────────────────────┘
             │ HTTP :8787
             ▼
┌─────────────────────────────────────────┐
│      Zonoid Daemon (daemon.js)          │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │  Task Graph  │  │  Knowledge Base │  │
│  │  (DAG +      │  │  (mine → eval   │  │
│  │   overlay)   │  │   → inject)     │  │
│  └──────────────┘  └─────────────────┘  │
└─────────────────────────────────────────┘
             │ MCP (stdio)
             ▼
┌─────────────────────────────────────────┐
│  start_task · complete_task · set_status│
│  search_knowledge · suggest_links       │
│  record_decision · get_full_graph       │
└─────────────────────────────────────────┘
```

## Dashboard

```
http://localhost:8787/graph
```

## Self-learning loop

After each session, Zonoid mines the task graph and agent transcripts for reusable patterns —
architectural decisions, gotchas, constraints — and queues them for LLM evaluation. Accepted
candidates are injected as knowledge notes into the graph. Future sessions inherit those notes
as Tier-1 context via `search_knowledge` and `suggest_links`, so the agent starts each run with
the accumulated findings of every prior session rather than a blank slate.

## MCP tools

34 tools, served identically over both transports (stdio and the daemon's `/mcp` endpoint). The
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
| `get_full_graph` | Get the workspace task graph or a focused slice of it (frontier digest by default) |
| `get_dependency_summaries` | Tier 1 (cheap, do first): concise summaries of a task's dependencies |
| `get_task_detail` | Tier 2 (on demand): full detail for one task — knowledge, summary, agent, token usage |
| `suggest_links` | Suggest existing tasks (including completed ones) a task should link to, ranked by overlap |
| `graph_delta` | What changed in the graph since a timestamp — the read-only change sensor for QA sweeps |
| `peek_workspace` | Load another workspace's full task graph on demand (does not change current) |

### Knowledge & notes

| Tool | Purpose |
|---|---|
| `search_knowledge` | Retrieve the most relevant knowledge notes (decisions / gotchas / constraints) for a free-text query |
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
| `drain_kb_queue` | Fire-and-forget background drain of the full KB queue; auto-injects on completion |
| `drain_kb_queue_status` | Get the current status of a background drain job |

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

MIT
