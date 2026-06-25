# Phase 1 — proxy-validation A/B (held-out cold-vs-warm on real-task reconstructions)

Generated 2026-06-10 from `bench/heldout/p1/results.jsonl` (34 runs; stage logs confirm
`ALL STAGE A DONE` / `ALL STAGE B DONE` — the matrix completed; only the babysitter died).

## Setup

4 of the 6 Phase 0a "transfer-robust winnable" tasks were reconstructed as held-out traps
(`native-store`, `claim-task`, `wt-gc`, `tls-local`) plus 3 self-contained controls
(`ctl-loop-next`, `ctl-stale-claims`, `ctl-agg-report`). Protocol identical to the n=1/n=2
wins: prose-spec-only solve, external held-out grader, cold (off) vs warm (`--consult=search`).

## Results

| task | proxy label | cold solved | cold edge | warm solved | warm edge | actual |
| --- | --- | --- | --- | --- | --- | --- |
| native-store | winnable | 3/3 | 5/5 ×3 | 2/2 | 5/5 ×2 | **NULL** |
| claim-task | winnable | 3/3 | 4/4 ×3 | 2/2 | 4/4 ×2 | **NULL** |
| wt-gc | winnable | 3/3 | 5/5 ×3 | 2/2 | 5/5 ×2 | **NULL** |
| tls-local | winnable | 2/2 | 6/6 ×2 | 2/2 | 6/6 ×2 | **NULL** |
| ctl-loop-next | not-winnable | 3/3 | 7/7 ×3 | 2/2 | 7/7 ×2 | NULL (as predicted) |
| ctl-stale-claims | not-winnable | 3/3 | 7/7 ×3 | 2/2 | 7/7 ×2 | NULL (as predicted) |
| ctl-agg-report | not-winnable | 3/3 | 6/6 ×3 | 2/2 | 6/6 ×2 | NULL (as predicted) |

**Cold passed every held-out edge case on every task — zero variance.** No trap survived the
rigging criterion (cold must fail), so no warm-vs-cold differential exists anywhere.

**Proxy precision on reconstructed winnable tasks: 0/4.** Controls: 3/3 correct.

## Mechanism (why the proxy missed)

The four "transfer-robust" facts are **general engineering knowledge inside the model's
pretraining prior**: self-signed-vs-issuer-trust (the `tls-local` spec's own step vocabulary
names `mkcert-install-ca`), don't-clobber-native-files, worktree GC retention, stale-claim
hygiene. The model does not need a note for facts it already knows. By contrast, the n=1/n=2
WINS used **project-local** facts (this registry's ~40% missing-session rate; this feed's
de-DE locale mix) that no pretraining covers.

## The sharpened boundary (3 conditions, was 2)

Memory is load-bearing iff the knowledge is:
1. **empirical** (discovered by running, not derivable from the spec), AND
2. **external to the artifact** (nothing in-worktree reveals it), AND
3. **project-local** (absent from the model's pretraining prior).

## Re-reading Phase 0a in this light

Phase 0a discounted the 12/18 "benchmark-meta" winnable tasks (their facts are prior measured
verdicts) and promoted the 6 "transfer-robust general-infra" ones. **Phase 1 inverts that:**
the general-infra facts are exactly the ones pretraining already covers (memory adds nothing),
while project-local measured facts — the meta slice — are exactly where memory wins.
What transfers to a customer project is the **category** (every project accumulates its own
local empirical facts: their flaky test, their API quirk, their data feed), not the specific
notes. The honest frequency claim is therefore about the **rate at which a project generates
project-local empirical external facts**, which Phase 0a measured at ~23% (12/52) for this
corpus — with the same self-similarity caveat as before.

## Verdict

Phase 1 = NULL across the board, and the null is informative: it adds the third boundary
condition (project-local) and corrects which Phase 0a slice the product claim should rest on.
The n=2 existence proof stands unchanged (those traps satisfied all three conditions).
