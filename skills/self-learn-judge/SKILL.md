---
name: self-learn-judge
description: Judge rival attempt branches for one problem, merge the winner back into the task's target repo, cancel the losers, and record a durable verdict as Tier-2 knowledge. Use when a problem task has multiple `branch_task` attempts that have all run to `tested`/`failed` and a judge task is ready to resolve them. When the problem carries a metric spec + measurements, judge METRIC-FIRST (improvement vs baseline, guardrail regressions, gap to a researched competitor benchmark) and weigh the tradeoffs with judgment; otherwise fall back to test pass/fail + rationale. The judge is the intelligence; the daemon stays dumb and only exposes merge_attempt/set_status/attach_knowledge/remove_worktree.
effort: high
---

> **DEFAULT — HOLD-MERGE MODE (autonomous heartbeat loop).** When this judge runs under the loop,
> it NEVER merges and NEVER halts the loop. This OVERRIDES steps 4–7 below:
> - Pick the winner exactly as described (step 3) — metric-aware when `P` carries a metric spec
>   (improvement vs baseline + guardrail regressions + benchmark gap), else test-outcome-then-rationale.
> - **Do NOT call merge_attempt or `git merge`.** Merging into `main` is a HUMAN decision made on review.
> - **Preserve every attempt branch + worktree** — no `remove_worktree`, no cancel — so the human can diff and merge later.
> - Record the verdict on the problem P: `{ winner, winner_branch:"orch/attempt/<slug>", why, losers:[{key,reason}], merged:false, awaiting_merge:true, date }` — plus the metric-aware fields from step 6 (`metric_value`, `improvement`, `guardrails_ok`, `vs_benchmark`, …) when P carried a metric spec.
> - Set P to `done` with a summary that STARTS with `"⏸ MERGE PENDING — <winner_branch>: <one-line why>"` (in metric mode, fold the metric value + improvement + benchmark gap into that one-liner).
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

3. **Pick the winner.** Two modes — choose by whether the problem carries a metric spec:
   - **Metric-aware mode** — `get_task_detail(P).metric` is present (an inline metric spec) AND
     the attempts carry `node.measurement` data. Judge METRIC-FIRST per
     [Metric-aware judging](#metric-aware-judging) below: weigh each attempt's improvement vs
     baseline, its guardrail regressions, and (when present) its gap to the competitor benchmark.
   - **Fallback mode (back-compat)** — `P` has NO metric spec, or the attempts have no
     `measurement` data (older problems). Judge on test outcome then rationale:
     - Eliminate every `failed` attempt outright.
     - Among the `tested` (passed) attempts, pick the best on rationale: simplest diff, fewest
       side effects, matches existing style, strongest test coverage. Record WHY in one line.
   - **If NO attempt is viable** (all `failed`, or — in metric mode — every attempt regresses a
     guardrail / fails to improve), do NOT force a merge. Record a "no-winner" verdict (step 6) and
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
     // --- metric-aware fields (include when P carried a metric spec; omit in fallback mode) ---
     metric: "<metric label>",            // the objective judged
     direction: "<min|max>",
     metric_value: <winner's measured value>,
     baseline_value: <baseline value compared against>,
     improvement: "<e.g. -18ms (12% better) vs baseline>",   // signed, direction-aware
     guardrails_ok: <true|false>,         // false if the winner regressed any guardrail
     guardrail_notes: [ "<metric: base→meas regressed>", ... ],  // omit/[] when none
     vs_benchmark: "<measured vs benchmark.value (conf=<low|med|high>, source)>" | "no benchmark — baseline-only",
     // -------------------------------------------------------------------------------------
     date: "<YYYY-MM-DD>"
   }) })
   ```
   This is the learning the loop produces: next time a similar problem appears, the verdict on
   `P` is cheap Tier-1/Tier-2 context. The metric fields (`metric_value`, `improvement`,
   `vs_benchmark`) are exactly what the optimize-loop control (⑥) reads to decide converged-vs-iterate.

7. **Close out.** `complete_task(J, summary, agent_id)` with a one-line verdict summary
   (winner, merged?, losers canceled; in metric mode lead with the metric value + improvement
   + benchmark gap so ⑥ can read it straight off the summary).

## Metric-aware judging

Used in **metric-aware mode** (step 3) when `P` carries an inline metric spec and the attempts
carry measurements. You are NOT a fixed weighted-score formula — you WEIGH THE TRADEOFFS with
judgment across three signals. You only EVALUATE; rival generation already happened upstream — never
invent or edit a solution here.

All the data is already on each attempt's node (no extra measuring): `get_task_detail(attempt)` →
`node.measurement = { value, guardrails:{<m>:v}, baseline:{ value, guardrails:{<m>:v} } }`, plus the
spec on `P`: `metric.direction` (`min` = lower-is-better, `max` = higher-is-better) and
`metric.guardrails:[{ metric, direction }]`. The competitor figure (when researched) is on `P`:
`node.benchmark = { metric, value, unit?, source, confidence }`.

For each attempt, read three signals:

1. **Metric improvement vs baseline.** Compare `measurement.value` to `measurement.baseline.value`
   under `direction`. For `min`, lower is better (`improved = measured < baseline`); for `max`,
   higher is better. Quantify the delta (absolute + %); a larger improvement in the right direction
   is better. An attempt that does NOT improve (or worsens) the metric is a weak/non-winner.

2. **Guardrail regressions — weigh HEAVILY against.** For each spec guardrail, compare the attempt's
   `measurement.guardrails[m]` to `measurement.baseline.guardrails[m]` under that guardrail's
   `direction` (same rule as above: `min`→regressed if measured > baseline; `max`→regressed if
   measured < baseline). A regression is a near-veto: an attempt that improves the headline metric
   but regresses a guardrail should almost never beat a clean attempt with a smaller gain. Capture
   each regression (`metric: base→meas`) in the verdict; never let one pass silently. (This is the
   same rule `lib/measure.js evalGuardrails` encodes — apply it as judgment, by hand, here.)

3. **Gap to competitor benchmark — only when `node.benchmark` is present.** Compare the attempt's
   `measurement.value` to `benchmark.value` under `direction` (beating the benchmark = better than
   the outside world; trailing it = there's headroom). Weight this signal by `benchmark.confidence`:
   `high` → treat the gap as real and let it sway close calls; `med` → a soft tiebreaker; `low` →
   barely lean on it. When `node.benchmark` is **absent**, judge on baseline-only — do NOT fabricate
   a benchmark or assume one.

**Weighing the tradeoff (judgment, not arithmetic):** prefer the attempt with the best metric
improvement that holds all guardrails. A guardrail regression should lose to a clean attempt even if
its raw metric gain is larger. Use the benchmark gap (confidence-weighted) to break ties and to
sanity-check whether the "winner" is actually good or merely least-bad. If every attempt regresses a
guardrail or none improves the metric, there is no viable winner → no-winner path (step 3 / step 6).

The merge (step 4 `merge_attempt(winner_key)`) and loser retirement (step 5) are unchanged — note
that `merge_attempt` now targets the task's own repo (`overlay.repos[key]` via `resolveRepo`), so the
winner lands in the problem's target repo, not a hardcoded workspace.

## Guardrails

- **Never force a merge.** No passing attempt, or a conflicting winner → record the verdict
  and stop. Forcing merges defeats the point of judging.
- **Daemon stays dumb.** All judgement lives here. If you find yourself wanting a new endpoint,
  you're probably overreaching this skill's scope.
- **Idempotent tools.** `remove_worktree` and `merge_attempt` are safe to re-run; a re-judged
  task won't corrupt state.
- **Metric mode: evaluate, never generate.** The judge reads measurements + benchmark and weighs
  tradeoffs; it does NOT write code or invent attempts (that's upstream). Never fabricate a benchmark
  — absent `node.benchmark` ⇒ baseline-only. A guardrail regression is a near-veto, not a footnote.
- **Back-compat.** No metric spec / no measurements ⇒ the test-pass + rationale path (step 3
  fallback) is unchanged. Metric mode is purely additive and never blocks an older problem.
- **Escalate, don't guess.** When the decision is the user's — no attempt passed, the winner
  conflicts, or the choice is genuinely ambiguous (low confidence, high impact) — call
  `request_guidance(...)` to halt the loop instead of forcing an outcome. Honor the
  `escalation` config toggles (a disabled trigger means proceed with your best judgment).
