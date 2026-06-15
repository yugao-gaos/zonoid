# Workspace instructions

## Orchestrator dashboard

This workspace uses the Orchestrator (task-graph daemon on `http://localhost:8787`).

**Always surface the dashboard link in your replies** when doing orchestrator/multi-task work,
so the user can open it whenever the panel isn't already up:

> 📊 Dashboard: http://localhost:8787/graph

The link is cheap to include and harmless if the dashboard is already open — prefer including it
over guessing whether it's open (the agent can't reliably detect the panel state). Drop it only
in purely conversational turns with no task-graph activity.

## Default to background-subagent dispatch

For any **substantive multi-step work** (a feature build, refactor, migration, audit, or
multi-file change), the main agent should **not implement inline**. Instead:

1. Decompose into native tasks (`TaskCreate`) and register them in the orchestrator graph.
2. After creating a task, call `suggest_links` and add `context`/`blocking` edges so it wires
   into existing/completed work instead of becoming an orphan root node.
3. **Dispatch the actual work to a background subagent** (`Agent` tool, `run_in_background: true`)
   that claims the task (`start_task`) and reports back (`complete_task`).
4. Keep the **main thread free** to orchestrate and talk to the user — never block it on a build.

**Wiring is the dispatcher's duty, not the worker's.** Whoever creates a task wires it
(`suggest_links` + `add_dependency`) **before** dispatching — do not delegate wiring to worker
subagents: it is unenforced (unlike the write gate), so smaller worker models reliably drop it,
and workers lack the structural context (e.g. which sibling tasks collide on the same files).

**Hand the worker a typed `handoff_envelope`, not prose duties.** Instead of restating the
worker's duties verbatim in English, the dispatcher builds the slotted `handoff_envelope` defined
in [`schemas/handoff.v1.schema.json`](./schemas/handoff.v1.schema.json) and embeds it in the
Agent-tool prompt (it plugs into the Agent-tool `schema` option). The worker **copies** the slotted
fields — `task_key`, `agent_id`, `branch` (`orch/attempt/<key>`), `target_repo` — into its graph
calls rather than parsing them back out of a paragraph, and reads `context_deps[]` (pre-resolved
Tier-1 `{task_key, summary}` pairs the dispatcher already fetched via `get_dependency_summaries` +
note summaries) as inline base context. `files_in_scope[]` is the advisory file-scope hint;
`return_contract` is a `$ref` to `task_result` so the worker knows the exact shape to return.
Building the envelope (including resolving `context_deps`) is the dispatcher's job — same rationale
as wiring: workers lack the structural context. The worker still owns exactly two graph duties —
`start_task` before any write, `complete_task` with a tight summary at the end — but now reads
them off the envelope's slots, not prose. (Workers still pass `wires_to=[task_key]` on any
`record_decision` they make mid-task — note provenance is the one wiring only the worker knows.)

**Worker registration rides the claim, not the start hook.** The `SubagentStart` hook does NOT
fire for `run_in_background` Agent-tool spawns, so a background worker never carries
`agent_tool_spawn:true`. No extra registration field is needed in the envelope: `start_task`
**self-registers the worker on claim**. The `/overlay/status` in_progress handler treats a claim
that bears an `agent_id` AND is backed by a registered worktree (proof `branch_task` ran — the
dispatcher never calls it) as a legitimate hook-less worker, registers it, and allows the claim.
The registered worktree is the security boundary: a claim with no worktree is still refused. So the
`branch_task` → `start_task` order IS the registration — nothing else to carry.

Do the work inline only for genuinely trivial edits (a one-liner, a doc tweak, a config change).
This is instruction-level in the desktop app (which runs no settings.json hooks); in the CLI a
PreToolUse exit-2 gate (`hooks/orch-gate.sh` + `hooks/orch-gate-bash.sh`) hard-blocks **both**
`Edit`/`Write` tools and `Bash` file-write commands — agents must claim a task before editing.
Users opt out per-conversation with `orch off`.

**Gate contract for subagents:** call `mcp__orchestrator-graph__branch_task(task_key)` **first**
to create an isolated worktree (`orch/attempt/<key>`), then `mcp__orchestrator-graph__start_task(task_key, agent_id)`.
The daemon rejects `start_task` if no worktree is registered — order is enforced. All file writes
must happen inside the worktree; the gate hard-blocks subagent writes on any other branch.
`ORCH_GATE_OFF=1` as an inline env prefix does **not** work from subagents — the hook runs as a
separate process. Never bypass via workarounds (rsync, fabricated claims, etc.); claim properly.

## Capture durable decisions as note nodes

Most conversation is throwaway, but some solo turns produce **durable knowledge** — a decision,
a rationale, a non-obvious finding. That should live in the graph, not evaporate when the session
ends. Use `record_decision(title, summary, knowledge?)` to capture it as a **note node** (a context
provider that shows in the graph but NOT in the native todo list; future related tasks inherit its
summary via context edges + `suggest_links`).

When to record:
- A real decision with a reason ("chose X over Y because …").
- A non-obvious finding or constraint worth keeping ("self-signed certs fail on issuer-trust, not locality").
- Anytime the user says "remember this" / "record this" (explicit — always capture).

Do NOT record chatter, restatements, or transient status. Keep summaries tight. On a borderline
case, lean toward NOT recording — note-node noise is worse than a missed minor point.

## KB note authoring

**Override signal:** When a note contradicts the spec or existing code — e.g. "spec says return null here, but you must also check byWindow" — the note title MUST start with `OVERRIDE:` or the summary must start with `SPEC IS INCOMPLETE:`. This prefix signals to consuming agents that the note takes priority over what the spec or code says, and they must not dismiss the discrepancy as a note error.

**Standalone tokens in title:** Note titles must use isolated vocabulary that matches how agents query — NOT camelCase compounds or hyphenated phrases. Write "task transcript" not "taskTranscript", "time window overlap" not "time-window-overlap". Word boundaries matter for the embedding tokenizer; fused tokens produce poor retrieval recall and the note may never surface for the queries it was written to answer.

**Provenance wiring:** Agents creating notes MUST pass `wires_to=[current_task_key]` in `record_decision` so the DAG edge is created at note-creation time. Do not rely on cosine autowire — semantic similarity is best-effort and misses structurally important edges. Example: if working task #17, pass `wires_to=["17"]`.
