---
name: parallel-orchestrate
description: Decompose a parallelizable task into a dependency graph, run it through the Workflow tool (or an Agent Team), and track it in the orchestrator graph with a two-tier context handoff. Use for audits, multi-file refactors/migrations, sweeps, or any "do X across all Y". The orchestrator router steers substantive parallelizable prompts here automatically.
effort: xhigh
---

# Parallel orchestrate

Authorizes and structures use of the **Workflow tool** (or **Agent Teams** if enabled) for
parallelizable work, with a token-efficient context handoff between dependent tasks.

1. **Decide if it's genuinely parallel.** If linear/trivial, say so and proceed normally.

2. **Decompose into a dependency graph.** Create native tasks with `TaskCreate` and declare
   dependencies with `TaskUpdate addBlockedBy`. The orchestrator MCP server then exposes this
   graph (tool prefix `mcp__orchestrator-graph__`).

3. **Run it — always via subagents, never on the main thread.** Dispatch each task to a
   **background subagent** (`Agent` tool with `run_in_background: true`) so the main thread
   stays free and the user can keep talking; you're notified when each finishes. Pass each
   subagent its `TASK_ID` (the `{session}/{id}` key).
   - **Genuinely independent tasks (disjoint files/areas)** → fan out in parallel (multiple
     background agents at once, or the Workflow tool's `parallel()`/`pipeline()`).
   - **File-coupled tasks** (they edit the same files) → **serialize**: one background agent at
     a time, dispatching the next when the previous completes. Still non-blocking — the main
     thread coordinates and chats while each runs.
   - The orchestrator graph tracks logical deps, NOT file-write contention — so before
     parallelizing, check the tasks don't share files; if they do, serialize.

4. **Each subagent follows this contract** (this is what saves tokens):
   - **On start — FIRST call `mcp__orchestrator-graph__start_task(task_key, agent_id)`** before
     any file writes. Both `Edit`/`Write` tools **and** `Bash` file-write commands are gated;
     a valid claim unlocks them for the session. `ORCH_GATE_OFF=1` as an inline env prefix
     does **not** work — the hook is a separate process and only inherits the Claude Code process
     env, not a shell command's inline env assignment. Then call
     `mcp__orchestrator-graph__get_dependency_summaries(task_key)`
     — **Tier 1**: the concise summaries of your dependencies. This is usually enough base
     context. Only if you need depth, call `get_task_detail(dep_key)` (**Tier 2**) for a
     specific dependency's knowledge/output. Then consult the knowledge base **gate-first**:
     `search_knowledge(query: <your task in one sentence>, gated: true)` — `decision:"inject"`
     ⇒ read and apply the returned note; `"abstain"` ⇒ proceed WITHOUT retrieval (do NOT
     re-query ungated; abstain is the common, correct outcome).
   - **While working:** attach reusable context with `attach_knowledge(task_key, item)` so
     dependents can fetch it precisely instead of you re-deriving it.
   - **On finish:** `mcp__orchestrator-graph__complete_task(task_key, summary, agent_id)` with
     a SHORT, precise summary — the interface your task exposes (what you produced, key
     decisions, where outputs live). Dependents read this as their Tier-1 base context, so
     keep it tight. Use `set_status(..., "failed"|"tested")` for those cases.

5. **Cross-workspace:** if a task depends on work in another repo, add a ghost edge with
   `add_dependency(from, to, from_workspace)`.

6. **Synthesize** the results into one coherent answer.

Watch it live (with the per-task detail panel) at `http://localhost:8787/graph`.

**Always include the dashboard link** — `📊 http://localhost:8787/graph` — in your replies while
orchestrating, so the user can open it whenever the panel isn't already up. It needs no HTTPS or
browser setup (plain HTTP + SSE for live updates).
