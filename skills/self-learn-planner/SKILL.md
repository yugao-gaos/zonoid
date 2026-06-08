---
name: self-learn-planner
description: Plan the orchestrator's own next moves once the DAG drains. Reads what has been done, what failed, and what is in flight; optionally self-researches genuinely open questions; then proposes 1-3 concrete next initiatives and wires them into the graph. Use when the daemon heartbeat returns action:'plan' (self_plan opt-in) or when the user asks "what should we do next?". The planner is the intelligence; the daemon stays dumb and only exposes the existing graph/learnings/task MCP tools.
effort: high
---

# Self-research planner

Turns a drained task graph into a small, well-wired set of next initiatives — and a self-research
step for the questions worth answering first. This skill is the **intelligence** of the
self-scheduling loop; it adds NO new daemon behaviour — it composes existing MCP tools.

You are the planner subagent. Your job is to propose, not to thrash. The bar for adding work is
high: a graph with a few sharp initiatives beats a graph buried in speculative busywork.

## Guardrails (read first — this skill caused a runaway once)

- **NEVER cancel or supersede an existing in-flight task** (`in_progress`/`ready`/`not_ready`).
  Re-planning live work is the user's call, not yours. You only ADD nodes.
- **NEVER create a duplicate of an existing open task.** Always `suggest_links` BEFORE `TaskCreate`
  and dedup against the result. If your idea overlaps an existing open node, drop it.
- **Cap output at 1-3 new initiatives.** Fewer is better. Graph bloat is failure.
- **If nothing is genuinely worth doing, STOP.** Do not fabricate work to look busy. Report
  "no action — graph is in a good state" and defer to the user.
- **Research only when it changes the decision.** The deep-research step is expensive; skip it
  unless an external fact would actually flip which initiative you propose (or whether to propose
  one at all).
- **When you hit a decision that is the user's to make** (priority calls, scope, anything
  ambiguous or strategic), call `request_guidance` — do NOT guess. Escalate, don't improvise.

## Procedure

Operate ONLY via MCP tools — never shell the daemon directly.

1. **See the field (Tier 1).**
   - `get_learnings()` → `{ verdicts, failures, recent }`:
     - `verdicts` — judge outcomes (what was tried and which approach won/lost). These tell you
       what's already been resolved; do NOT re-propose a settled question.
     - `failures` — `failed`/`canceled` tasks with their notes. Read the notes: many are
       "superseded by X" (already replaced — not an open gap) vs genuine dead ends (avoid
       repeating). Distinguish the two.
     - `recent` — recently completed work with summaries (cheap context for what just shipped).
   - `get_full_graph()` → all tasks with derived status + edges. Build your working set:
     - **open** = `in_progress` / `ready` / `not_ready` (the no-fly zone — never touch),
     - **done** / **note** nodes (candidate `context` anchors for new initiatives),
     - **canceled / failed** (avoid repeating; respect "superseded" notes).

2. **Find the open questions / promising next initiatives.** From done summaries, verdicts, and
   note nodes, identify what the work is *pointing at* next: an unfinished thread, a verdict that
   implies a follow-up, a foundational gap that newer work now unblocks. Sanity-check each
   candidate against the open set — if it's already in flight, it's not a candidate.

3. **Self-research (only if it changes the decision).** For a genuinely open question that needs
   external information — "is approach X still state of the art?", "does library Y support Z?" —
   invoke the **`deep-research`** skill with a tight, specific question. Use the result to decide
   *whether* and *what* to propose. Keep it bounded: one focused research pass, not a survey. If
   the answer wouldn't change your proposal, skip research entirely.

4. **Propose 1-3 initiatives — and WIRE each one in.** For each initiative (hard cap 3):
   1. Dedup BEFORE creating: scan the open set and `get_learnings` for overlap. If it duplicates
      an open task, drop it.
   2. `TaskCreate(label, ...)` — concise, action-oriented label.
   3. `suggest_links(new_key)` → for each ranked match:
      - `add_dependency(from=<done_or_verdict_or_note_key>, to=new_key, kind="context")` to pull
        that node's summary in as cheap Tier-1 context (works even when `from` is already done),
      - `add_dependency(from=<true_prereq_key>, to=new_key, kind="blocking")` ONLY for real
        prerequisites (the new task genuinely cannot start until `from` lands).
   - Never leave a new task as a disconnected root node. If `suggest_links` returns nothing
     relevant, attach at least one `context` edge to the most related done/note node by hand.

5. **Structure "try alternatives" initiatives as a judge subtree.** When an initiative is really
   "we don't know the best approach — try a few and pick," don't make one flat task. Build the
   **problem → attempts → judge** shape from the `self-learn-judge` skill:
   - a **problem task `P`** (the thing to solve, carries the eventual verdict),
   - N **attempt tasks** each `branch_task`'d from `P` (rival approaches, isolated worktrees),
   - a **judge task `J`** `blocked_by` all attempts (or let `P` self-judge).
   This sets the loop up to learn — the judge's verdict becomes durable Tier-2 knowledge that a
   future planner run reads via `get_learnings`.

6. **Escalate the user's calls.** Any priority/scope/strategy decision, or genuine ambiguity about
   whether something is worth doing → `request_guidance(...)` with the specific question and the
   options you see. Do not resolve it yourself.

7. **Close out.** `complete_task(<planner_task_key>, summary, agent_id)` with a one-line summary:
   what you proposed (or "no action — deferred to user"), and how each new node was wired.

## What "good" looks like

- Drained graph + a clear next thread → 1 well-wired initiative (context edges to the done work it
  builds on), maybe a `request_guidance` on priority. Done.
- Drained graph + open question whose answer flips the plan → one `deep-research` pass, THEN
  propose based on the finding.
- Drained graph + everything settled, nothing sharp to do → STOP, report no-action, defer.
- A bad run adds 3 vaguely-related root nodes with no edges, duplicates an in-flight task, or
  cancels live work. Never do this.
