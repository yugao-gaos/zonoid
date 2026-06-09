---
name: self-learn-judge
description: Judge rival attempt branches for one problem, merge the winner back, cancel the losers, and record a durable verdict as Tier-2 knowledge. Use when a problem task has multiple `branch_task` attempts that have all run to `tested`/`failed` and a judge task is ready to resolve them. The judge is the intelligence; the daemon stays dumb and only exposes merge_attempt/set_status/attach_knowledge/remove_worktree.
effort: high
---

> **DEFAULT — HOLD-MERGE MODE (autonomous heartbeat loop).** When this judge runs under the loop,
> it NEVER merges and NEVER halts the loop. This OVERRIDES steps 4–7 below:
> - Pick the winner exactly as described (inspect each attempt's branch diff + test result; test-outcome-then-rationale).
> - **Do NOT call merge_attempt or `git merge`.** Merging into `main` is a HUMAN decision made on review.
> - **Preserve every attempt branch + worktree** — no `remove_worktree`, no cancel — so the human can diff and merge later.
> - Record the verdict on the problem P: `{ winner, winner_branch:"orch/attempt/<slug>", why, losers:[{key,reason}], merged:false, awaiting_merge:true, date }`.
> - Set P to `done` with a summary that STARTS with `"⏸ MERGE PENDING — <winner_branch>: <one-line why>"`.
> - `complete_task(J, ...)` and stop. **Do NOT `request_guidance`** (it would halt the loop). No-winner (all attempts failed): record `{winner:null, awaiting_merge:false, needs_attention:true, ...}`, set P `done` with summary `"⚠ NEEDS ATTENTION — all attempts failed: <reasons>"`, complete J, continue. Everything (merges, conflicts, failures) is queued for the morning human review via the verdict + the ⏸/⚠ summary — never escalated mid-run.
> - Only if `overlay.config.auto_merge === true` do the legacy merge steps 4–5 below apply.


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
   - **If NO attempt passed**, do NOT force a merge. Record a "no-winner" verdict (step 6) and
     **`request_guidance({ question: "All N attempts at <P> failed — drop, retry with new approach, or take over?", context: "<one line per attempt's failure>", trigger: "repeated_failure" })`** to halt the loop and ask the user. Then stop.

4. **Merge the winner.** `merge_attempt(winner_key)`.
   - `{merged:true}` → proceed.
   - `{merged:false, conflict:true, files}` → the winner conflicts with the current base. Do
     NOT retry blindly. Record the conflict in the verdict, leave the winner's worktree intact
     for inspection, and **`request_guidance({ question: "Winning attempt <key> conflicts with base on <files> — resolve manually, pick another attempt, or abandon?", trigger: "irreversible_action" })`** rather than guessing the resolution.

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
- **Escalate, don't guess.** When the decision is the user's — no attempt passed, the winner
  conflicts, or the choice is genuinely ambiguous (low confidence, high impact) — call
  `request_guidance(...)` to halt the loop instead of forcing an outcome. Honor the
  `escalation` config toggles (a disabled trigger means proceed with your best judgment).
