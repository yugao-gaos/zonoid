---
name: self-learn-judge
description: Judge rival attempt branches for one problem, merge the winner back, cancel the losers, and record a durable verdict as Tier-2 knowledge. Use when a problem task has multiple `branch_task` attempts that have all run to `tested`/`failed` and a judge task is ready to resolve them. The judge is the intelligence; the daemon stays dumb and only exposes merge_attempt/set_status/attach_knowledge/remove_worktree.
effort: high
---

# Self-learn judge

Turns rival attempts at one problem into a single merged outcome plus a recorded learning.
This skill is the **intelligence** of the branch → test → judge → merge → record loop; it
adds NO new daemon behaviour — it composes existing MCP tools.

## Graph convention (no new edge kinds)

- **Problem task `P`** — the thing to solve. The durable verdict is attached here.
- **Attempt tasks `A1..An`** — each created with its own isolated worktree via
  `branch_task` (branch `orch/attempt/<key>`). Each attempt runs to `tested` (its tests
  passed) or `failed`.
- **Judge task `J`** — `blocked_by` ALL attempts, so it only becomes `ready` once every
  attempt has finished. `J` may be a distinct "resolve P" node, OR `P` itself can play the
  judge role. Both are valid:
  - **Separate `J`** — clean separation: `P` carries the verdict, `J` is the action. Use when
    you want the resolution step visible/owned on the graph.
  - **`J` == `P`** — the problem node resolves itself once attempts complete. Fewer nodes;
    use for lightweight problems. Either way the verdict knowledge lands on `P`.

## Procedure

You are the judge subagent for `J`. Operate ONLY via MCP tools — never shell git directly.

1. **Claim it.** `start_task(J, agent_id)`.

2. **Gather the field (Tier 1).** `get_dependency_summaries(J)` — its **blocking** deps are
   the attempts. For each attempt key, `get_task_detail(attempt_key)` to read its status and
   test results / knowledge (Tier 2). Note each attempt's outcome: `tested` (passed) vs
   `failed`, plus any captured test output.

3. **Pick the winner — test outcome first, then rationale.**
   - Eliminate every `failed` attempt outright.
   - Among the `tested` (passed) attempts, pick the best on rationale: simplest diff, fewest
     side effects, matches existing style, strongest test coverage. Record WHY in one line.
   - **If NO attempt passed**, do NOT force a merge. Skip to step 6 and record a "no-winner"
     verdict (this is the foundation the later guidance/escalation work builds on).

4. **Merge the winner.** `merge_attempt(winner_key)`.
   - `{merged:true}` → proceed.
   - `{merged:false, conflict:true, files}` → the winner conflicts with the current base. Do
     NOT retry blindly. Treat as no-clean-winner: record the conflict in the verdict and flag
     for guidance (later increment); leave the winner's worktree intact for inspection.

5. **Retire the losers.** For each non-winning attempt:
   - `set_status(loser_key, 'canceled', note="<one line: why it lost>")`.
   - `remove_worktree(loser_key)` to delete its branch + worktree.
   (Do not cancel/remove the winner; its worktree can be cleaned once the merge is confirmed.)

6. **Record the verdict (durable Tier-2 learning).** Attach to `P` (the problem node):
   ```
   attach_knowledge(P, { type: 'note', value: JSON.stringify({
     winner: <winner_key | null>,
     why: "<one line>",
     losers: [ { key, reason }, ... ],
     merged: <true|false>,
     conflict: <true if merge conflicted, else omit>,
     date: "<YYYY-MM-DD>"
   }) })
   ```
   This is the learning the loop produces: next time a similar problem appears, the verdict on
   `P` is cheap Tier-1/Tier-2 context.

7. **Close out.** `complete_task(J, summary, agent_id)` with a one-line verdict summary
   (winner, merged?, losers canceled).

## Guardrails

- **Never force a merge.** No passing attempt, or a conflicting winner → record the verdict
  and stop. Forcing merges defeats the point of judging.
- **Daemon stays dumb.** All judgement lives here. If you find yourself wanting a new endpoint,
  you're probably overreaching this skill's scope.
- **Idempotent tools.** `remove_worktree` and `merge_attempt` are safe to re-run; a re-judged
  task won't corrupt state.
