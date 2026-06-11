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
│  create_task · start_task · complete_task│
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

| Tool | Purpose |
|---|---|
| `create_task` | Register a new task node in the graph before starting work |
| `start_task` | Claim a task and mark it in_progress — required before any file edit |
| `complete_task` | Mark a task done with a concise summary; optionally queue follow-ups |
| `search_knowledge` | Retrieve relevant knowledge notes (decisions, constraints, gotchas) for a query |
| `suggest_links` | Rank existing tasks by relevance to wire a new task into the graph |
| `record_decision` | Capture a durable decision or finding as a note node for future sessions |
| `get_full_graph` | Read the current task graph (frontier slice by default, full graph on request) |

## License

MIT
