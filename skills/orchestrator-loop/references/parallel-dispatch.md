
# Parallel orchestrate

Authorizes and structures use of the **Workflow tool** (or **Agent Teams** if enabled) for
parallelizable work, with a token-efficient context handoff between dependent tasks.

1. **Decide if it's genuinely parallel.** If linear/trivial, say so and proceed normally.

2. **Decompose into a dependency graph.** Create native tasks with `TaskCreate` and declare
   dependencies with `TaskUpdate addBlockedBy`. The orchestrator MCP server then exposes this
   graph (tool prefix `mcp__orchestrator-graph__`).

3. **Run it — always via subagents, never on the main thread.** Dispatch each task to a
   **background subagent** (`Agent` tool with `run_in_background: true`) so the main thread
   stays free and the user can keep talking; you're notified when each finishes. Hand each
   subagent a typed **`handoff_envelope`** ([`schemas/handoff.v1.schema.json`](../../../schemas/handoff.v1.schema.json),
   plugs into the Agent-tool `schema` option) instead of prose duties: the dispatcher fills the
   slots — `task_key` (the `{session}/{id}` key), `agent_id`, `branch` (`orch/attempt/<key>`),
   `target_repo`, `files_in_scope[]`, and `context_deps[]` (pre-resolved Tier-1 `{task_key, summary}`
   pairs the dispatcher fetches via `get_dependency_summaries` + note summaries) — and the worker
   **copies** them into its graph calls rather than re-deriving them. `return_contract` (`$ref`
   to `task_result`) tells the worker the exact shape to return. Resolving `context_deps` is the
   dispatcher's job, not the worker's.
   - **Genuinely independent tasks (disjoint files/areas)** → fan out in parallel (multiple
     background agents at once, or the Workflow tool's `parallel()`/`pipeline()`).
   - **File-coupled tasks** (they edit the same files) → **serialize**: one background agent at
     a time, dispatching the next when the previous completes. Still non-blocking — the main
     thread coordinates and chats while each runs.
   - The orchestrator graph tracks logical deps, NOT file-write contention — so before
     parallelizing, check the tasks don't share files; if they do, serialize.
   - **Pair a judge task with each substantive impl task** (dispatcher's duty, like wiring):
     create a judge task wired `blocking` (blocked_by) the impl task **before** dispatching, so it
     goes `ready` automatically when the impl completes (reusing the DAG-gate trigger — no new
     machinery). Skill-tag it in the prompt: the judge worker invokes **`self-learn` judge mode in
     single-attempt review mode** against the impl's attempt branch — it reviews the attempt diff
     against the code-review rubric and either APPROVES (feature-tier attempt→feature merge, or
     flat attempt→main hold verdict) or KICKS BACK, and **never force-merges** (merge auto-aborts
     on conflict). Genuinely trivial edits (one-liner, doc/config tweak) skip the judge;
     substantive multi-file work gets it.
   - **Substantial multi-task work gets a two-tier feature branch** (dispatcher-decides, same
     complexity axis as the judge). The dispatcher `create_feature(key)` → `orch/feature/<slug>` +
     worktree, groups tasks under it (`configure_task repo_path=<feature worktree>`, dispatch with
     `branch_task base=orch/feature/<slug>` so attempts fork off the **stable feature branch, not
     the drifting main**). **Tier-1:** the single-attempt judge auto-merges each approved attempt
     into the feature branch (cheap/reversible). **Tier-2:** the dispatcher makes the GATED
     `merge_feature(key)` call (feature→main) once complete — never automatic. The **dispatcher
     stays on main** coordinating N features concurrently (one cwd can't live in N worktrees);
     feature worktrees are integration surfaces targeted via `base`+`repo_path`, not the working
     dir (`EnterWorktree` relocation is an optional single-feature-interactive convenience). Trivial
     single-task work skips the feature tier and uses the flat attempt→main flow.

4. **Each subagent follows this contract** (this is what saves tokens):
   - **On start — call `mcp__orchestrator-graph__branch_task(task_key)` FIRST** to create an
     isolated worktree (branch `orch/attempt/<key>`). Then call
     **`mcp__orchestrator-graph__start_task(task_key, agent_id)`** — the daemon rejects the
     claim if no worktree is registered, so the order is mandatory. `start_task` also **registers
     the worker on claim**: the `SubagentStart` hook does NOT fire for `run_in_background` spawns,
     so registration rides the claim instead — a claim bearing an `agent_id` and backed by the
     worktree `branch_task` just created is accepted and registered (a claim with no worktree is
     refused; the worktree is the security boundary). Copy `task_key`, `agent_id`, and `branch`
     straight from the `handoff_envelope`. All file writes must happen
     inside the worktree; NEVER edit the live checkout. Both `Edit`/`Write` tools **and** `Bash`
     file-write commands are gated to `orch/attempt/*` branches for subagents. `ORCH_GATE_OFF=1`
     as an inline env prefix does **not** work — the hook is a separate process. Your dependency
     summaries usually arrive pre-resolved in the envelope's `context_deps[]` (**Tier 1**); if not,
     call `mcp__orchestrator-graph__get_dependency_summaries(task_key)` to fetch them. Only if you
     need depth, call `get_task_detail(dep_key)` (**Tier 2**) for a specific dependency's
     knowledge/output. Then consult the knowledge base **gate-first**:
     `search_knowledge(query: <your task in one sentence>, gated: true)` — `decision:"inject"`
     ⇒ read and apply the returned note; `"abstain"` ⇒ proceed WITHOUT retrieval (do NOT
     re-query ungated; abstain is the common, correct outcome).
   - **While working:** attach reusable context with `attach_knowledge(task_key, item)` so
     dependents can fetch it precisely instead of you re-deriving it.
   - **On finish — commit FIRST, then complete:** `git add -A && git commit` all your changes
     onto the `orch/attempt/<key>` branch BEFORE calling `complete_task`. `complete_task` does
     NOT auto-commit your worktree — if you leave changes uncommitted the attempt branch tip
     stays equal to base, and a later `merge_attempt` is a silent no-op (returns `merged:true`
     with the head unchanged but lands nothing on the target branch/base). Only after committing call
     `mcp__orchestrator-graph__complete_task(task_key, summary, agent_id)` with
     a SHORT, precise summary — the interface your task exposes (what you produced, key
     decisions, where outputs live). Dependents read this as their Tier-1 base context, so
     keep it tight. Use `set_status(..., "failed"|"tested")` for those cases.
     (Complementary hardening, not in scope here: `merge_attempt` could warn or refuse when the
     branch tip equals base.)

5. **Cross-workspace:** if a task depends on work in another repo, add a ghost edge with
   `add_dependency(from, to, from_workspace)`.

6. **Synthesize** the results into one coherent answer.

Watch it live (with the per-task detail panel) at `http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>`.

**Always include the repo-pinned dashboard link** — `📊 http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>` — in your replies while
orchestrating, so the user can open it whenever the panel isn't already up. It needs no HTTPS or
browser setup (plain HTTP + SSE for live updates).
