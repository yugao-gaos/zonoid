
> **DEFAULT — HOLD-MERGE MODE (autonomous heartbeat loop).** "Hold-merge" means **hold for MAIN**:
> the judge NEVER auto-merges into `main` and NEVER halts the loop. But it is now **two-tier** — when
> the attempt's task is **under a FEATURE**, an APPROVE verdict **auto-merges into the FEATURE branch**
> (cheap + reversible); only the flat attempt→main flow stays a pure hold. This OVERRIDES steps 4–7 below:
> - Pick the winner exactly as described (step 3) — metric-aware when `P` carries a metric spec
>   (improvement vs baseline + guardrail regressions + benchmark gap), else test-outcome-then-rationale —
>   in BOTH cases folding in the code-review read (step 2b) per the [Code-review rubric](#code-review-rubric).
> - **Single-attempt problems** (exactly one attempt) do NOT pick a rival winner: the code review IS the
>   verdict (APPROVE or KICK BACK) — see [Single-attempt gate](#single-attempt-tournament-of-one-gate).
>   On APPROVE the merge behavior splits **by tier** (see [Two-tier APPROVE](#two-tier-approve-feature-auto-merge-vs-main-hold)):
>   under a FEATURE → auto-merge to the feature branch; flat (attempt→main) → HOLD, record `⏸ MERGE PENDING`, never merge.
> - **Never auto-merge into `main`.** Merging into `main` is a HUMAN decision made on review; and
>   feature→main is the dispatcher's gated `merge_feature`, NEVER the judge's call.
> - **Preserve every flat attempt branch + worktree** — no `remove_worktree`, no cancel — so the human can diff and merge later.
>   (Under a feature, an APPROVED attempt IS merged into the feature branch, so its worktree may be retired per the normal merge path.)
> - Record the verdict on the problem P with the tier-specific merge state: under a FEATURE after a
>   successful attempt→feature merge, `{ winner, winner_branch:"orch/attempt/<slug>", why,
>   losers:[{key,reason}], merged:true, target:"feature", awaiting_merge:false, date }`; flat
>   attempt→main APPROVE records `{ ..., merged:false, target:"main", awaiting_merge:true }`.
>   Include the metric-aware fields from step 6 (`metric_value`, `improvement`, `guardrails_ok`,
>   `vs_benchmark`, …) when P carried a metric spec.
> - Set P to `done` with a tier-specific summary: under a FEATURE, start with
>   `"MERGED TO FEATURE — <feature_branch>: <one-line why>"`; flat attempt→main starts with
>   `"⏸ MERGE PENDING — <winner_branch>: <one-line why>"` (in metric mode, fold the metric value +
>   improvement + benchmark gap into that one-liner).
> - `subconscious_assignment action:"complete"` for `J` and stop. **Do NOT `request_guidance`** for a clean APPROVE (it would halt
>   the loop). No-winner (all attempts failed): record `{winner:null, awaiting_merge:false,
>   needs_attention:true, ...}`, set P `done` with summary `"⚠ NEEDS ATTENTION — all attempts failed:
>   <reasons>"`, complete J, continue. Flat main merges, feature→main promotion, conflicts, and
>   failures remain queued for human/dispatcher review via the verdict + summary — never force them.
> - Only if `overlay.config.auto_merge === true` do the legacy merge steps 4–5 below apply.


# Self-learn judge

Turns rival attempts at one problem into a single merged outcome plus a recorded learning.
This skill is the **intelligence** of the branch → test → judge → merge → record loop; it
adds NO new daemon behaviour — it composes existing MCP tools.

## Graph convention (no new edge kinds)

- **Problem task `P`** — the thing to solve. The durable verdict is attached here.
- **Attempt tasks `A1..An`** — each prepared with its own isolated worktree via
  `subconscious_assignment action:"prepare"` (branch `orch/attempt/<key>`). Each attempt runs to `tested` (its tests
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

1. **Accept it.** Use `subconscious_assignment action:"prepare"` if no assignment envelope exists, then `subconscious_assignment action:"accept"` for `J`.

2. **Gather the field (Tier 1).** `get_dependency_summaries(J)` — its **blocking** deps are
   the attempts. For each attempt key, `get_task_detail(attempt_key)` to read its status and
   test results / knowledge (Tier 2). Note each attempt's outcome: `tested` (passed) vs
   `failed`, plus any captured test output.

2b. **Read the code, not just the outcome.** For EACH attempt, fetch its diff with the
   `get_attempt_diff` MCP tool (`get_attempt_diff({ task_key: attempt_key })` → GET
   `/attempt/diff`, response `{ ok, key, branch, base, stat, diff }`; `stat` is the
   `git diff base...branch --stat`, `diff` is the full three-dot merge-base diff = only the
   attempt's own changes). Assess each diff against the [Code-review rubric](#code-review-rubric)
   below. Carry forward, per attempt: a one-line correctness read and a list of concerns
   (scope creep, dead/redundant code, weak/missing tests, style drift). These findings feed the
   winner pick (step 3) and land in the verdict (step 6) as `code_review`. If exactly ONE attempt
   exists, this read IS the verdict — see [Single-attempt gate](#single-attempt-tournament-of-one-gate).

3. **Pick the winner.** Two modes — choose by whether the problem carries a metric spec:
   - **Metric-aware mode** — `get_task_detail(P).metric` is present (an inline metric spec) AND
     the attempts carry `node.measurement` data. Judge METRIC-FIRST per
     [Metric-aware judging](#metric-aware-judging) below: weigh each attempt's improvement vs
     baseline, its guardrail regressions, and (when present) its gap to the competitor benchmark.
     **The code review (step 2b) is a tiebreaker AND a near-veto here:** a correctness bug or a
     guardrail-relevant regression visible in the diff loses, even to an attempt with a smaller
     metric gain — a measured number you cannot trust is no improvement.
   - **Fallback mode (back-compat)** — `P` has NO metric spec, or the attempts have no
     `measurement` data (older problems). Judge on test outcome then the code review:
     - Eliminate every `failed` attempt outright.
     - Among the `tested` (passed) attempts, pick the best on the [Code-review rubric](#code-review-rubric)
       read from step 2b — an actual read of each diff (correctness, scope discipline, dead code,
       test quality, style match), NOT a vibe estimate. Record WHY in one line, grounded in what the
       diff shows.
   - **If NO attempt is viable** (all `failed`, or — in metric mode — every attempt regresses a
     guardrail / fails to improve), do NOT force a merge. Record a "no-winner" verdict (step 6) and
     **`request_guidance({ question: "All N attempts at <P> failed — drop, retry with new approach, or take over?", context: "<one line per attempt's failure>", trigger: "repeated_failure" })`** to halt the loop and ask the user. Then stop.

4. **Submit the winner verdict.** Use `subconscious_assignment action:"submit_verdict"` with `verdict:"APPROVE"`, `task_key: winner_key`, and `judge_task_key: J`.
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
     // --- code review (always include; from step 2b — the read of the actual diff) ---
     code_review: {
       winner_notes: "<one line on the winning/sole diff: does it do the task, is it clean>",
       concerns: [ "<key>: <scope creep | dead code | weak test | bug | style drift>", ... ]  // [] if none
     },
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

7. **Close out.** Use `subconscious_assignment action:"complete"` for `J` with a one-line verdict summary
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

The merge behind step 4 and loser retirement (step 5) are unchanged internally — note that the
merge path targets the task's own repo (`overlay.repos[key]` via `resolveRepo`), so the winner
lands in the problem's target repo, not a hardcoded workspace.

## Code-review rubric

Used in step 2b for EVERY attempt, in BOTH modes. You judge the OUTCOME elsewhere (tests, metrics);
here you judge the CODE ARTIFACT itself by reading its diff. Fetch it with
`get_attempt_diff({ task_key: attempt_key })` (GET `/attempt/diff` → `{ ok, key, branch, base, stat, diff }`;
`diff` is the three-dot merge-base diff, so it shows ONLY this attempt's own changes). The daemon just
serves the diff — the reading is yours. Read each diff against five concrete checks:

1. **Correctness** — does the diff actually do what the task asked? Look for obvious bugs, mishandled
   edge cases, off-by-ones, inverted conditions, a "fix" that doesn't touch the real code path. A
   passing test on a vacuous assertion does NOT clear this check — read the change, don't trust the green.

2. **Scope discipline** — only the task's `files_in_scope` (or plainly-related files) touched. Flag
   unrelated churn: drive-by reformatting, renames, refactors of code the task never mentioned.

3. **Dead / redundant code left behind** — leftover legacy code the change should have removed,
   duplicated logic, orphaned imports / variables / functions, commented-out blocks, a new path added
   beside the old one without deleting the old one.

4. **Test presence & quality** — are there REAL tests exercising the change, consistent with the
   attempt's `tests_run`? A test that asserts nothing, mocks the thing under test, or never calls the
   new path is vacuous — count it as missing, not present.

5. **Style match** — matches surrounding conventions (naming, error handling, structure). Minor; a
   tiebreaker, never a veto on its own.

Output per attempt: a one-line correctness verdict + a `concerns[]` list (each tagged with the check it
failed). A correctness bug (#1) or a guardrail-relevant regression seen in the diff is a **near-veto**
in metric mode and disqualifying in fallback mode; #2–#4 weigh against an attempt; #5 only breaks ties.
These feed the winner pick (step 3) and the verdict's `code_review` field (step 6).

## Single-attempt ("tournament of one") gate

The procedure above assumes ≥2 rival attempts. When a problem `P` has **exactly ONE** attempt, there
is no rival to pick among — so the code review IS the verdict. This is the per-task pre-merge review gate.

1. Run the [Code-review rubric](#code-review-rubric) on that single attempt's diff (step 2b), plus its
   metric/test outcome as usual.
2. Decide:
   - **APPROVE** — the diff does the task, is in scope, leaves no dead code, has real tests, matches
     style (and in metric mode, improves the metric with guardrails intact). Treat the lone attempt as
     the winner; the merge behavior then splits **by tier** — see
     [Two-tier APPROVE](#two-tier-approve-feature-auto-merge-vs-main-hold) directly below.
   - **KICK BACK** — a correctness bug, out-of-scope churn, dead code, missing/vacuous tests, or a
     guardrail regression. Do NOT merge (in EITHER tier). Use `subconscious_assignment action:"submit_verdict"`
     with `verdict:"KICK_BACK"` and the concrete reason (or reopen it for rework), and
     `record_decision(title, summary, wires_to=[P_key])` capturing the
     concrete fixes required so the next attempt inherits them. Record the verdict (step 6) with
     `winner: null`, `code_review.concerns` populated, and `needs_attention: true`.
3. Record the verdict on `P` (step 6) exactly as for the multi-attempt case — `code_review` carries the
   review; `winner` is the attempt key (APPROVE) or `null` (KICK BACK). Then use `subconscious_assignment action:"complete"` for `J`.

### Two-tier APPROVE: feature auto-merge vs main hold

An APPROVE is NOT one fixed action. It depends on whether the attempt's task lives **under a feature**.

**Detect the tier.** The attempt's task is **under a feature** when its `repo_path` points at a feature
worktree, OR there is an `overlay.features[<feature_key>]` entry whose tasks include this attempt. Read it
from `get_task_detail(P)` / the attempt node: a task configured with `repo_path = <feature worktree>` and
branched with `base = orch/feature/<slug>` is under that feature; `overlay.features[feature_key] =
{ feature_branch: "orch/feature/<slug>", feature_worktree, base }` is the registry. No feature worktree /
no covering `overlay.features` entry ⇒ it is a **flat** attempt→main task.

- **Under a FEATURE → AUTO-MERGE to the feature branch.** APPROVE means merge the attempt into the
  FEATURE branch through `subconscious_assignment action:"submit_verdict"` with the feature worktree repo path — running `mergeBranch`
  INSIDE the feature worktree lands the attempt on the FEATURE branch, not `main`. This is cheap and
  reversible (worst case the dispatcher resets the feature branch), so the judge MAY merge here — this
  resolves the old "hold-merge can't merge" awkwardness. Record the verdict (step 6) with `merged: true`
  and `target: "feature"`.
  - **On merge conflict** (`{merged:false, conflict:true, files}`) do NOT force. Record
    `{ conflict: true, files }` in the verdict, leave the worktree intact, and KICK BACK / escalate via
    `request_guidance(...)` — mirror the conflict guidance in [step 4](#procedure) exactly.
- **Flat (attempt→main) → HOLD for MAIN (unchanged).** APPROVE records the verdict and does NOT merge:
  summary starts `⏸ MERGE PENDING — <branch>: <why>`, `merged: false`, `awaiting_merge: true`. The human
  decides the merge to `main` on review. (Only with `auto_merge === true` do steps 4–5 merge to main.)

**feature→main is NEVER the judge's call.** Landing a whole feature branch onto `main` is the
dispatcher-gated `merge_feature` op — a separate, human-/dispatcher-owned decision. The judge only ever
merges an *attempt* into its *feature* branch; it never promotes a feature to `main`.

## Guardrails

- **Never force a merge.** No passing attempt, or a conflicting winner → record the verdict
  and stop. Forcing merges defeats the point of judging.
- **Two-tier APPROVE: feature auto-merge, main hold.** On APPROVE under a FEATURE, the judge MAY
  auto-merge the attempt into the feature branch through `subconscious_assignment action:"submit_verdict"` — cheap +
  reversible. **NEVER auto-merge into `main`** — a flat attempt→main APPROVE only HOLDS (records the
  verdict, human decides). And **feature→main is the dispatcher's gated `merge_feature`, NEVER the
  judge's call** — the judge only lands an attempt onto its feature branch. A merge conflict under a
  feature is a near-veto: record `{conflict,files}`, do not force, KICK BACK / escalate.
- **Daemon stays dumb.** All judgement lives here. If you find yourself wanting a new endpoint,
  you're probably overreaching this skill's scope. `get_attempt_diff` only SERVES the diff — the
  read against the [Code-review rubric](#code-review-rubric) is yours.
- **Read the code, never just the green.** A passing test or an improved metric on an unread diff is
  not a winner — a vacuous test or a correctness bug visible in the diff is a near-veto (metric mode)
  or disqualifying (fallback / single-attempt). Trust the diff, not the badge.
- **Idempotent lower-level tools.** Backcompat/internal `remove_worktree` and `merge_attempt` are safe to re-run; a re-judged
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
