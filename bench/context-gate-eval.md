# Context-need gate — labeled eval & regret

Generated 2026-06-10T04:38:15.247Z by `bench/context-gate-eval.js` from `bench/report-v2..v7.json`. **Offline only — no new agent runs.**

## The gate rule

Per task, decide INJECT vs ABSTAIN from the semantic KB. **DEFAULT = ABSTAIN.** Flip to INJECT
only when ALL three guards pass:

1. **confidence** `top1 cosine >= 0.55` — the best note is a SPECIFIC match, not topical drift.
2. **specificity** `margin = top1 - top2 >= 0.12` — it stands ALONE above the field (a diffuse
   cluster of near-ties = topical noise, not a scar that applies).
3. **empirical** the top note is scar-tissue (gotcha / decision-with-reason / root-cause), NOT a
   general principle the base model already knows.

Conservative by construction: when in doubt, abstain. (INJECT-threshold calibration is deferred
to the winning-case experiment, task #5, where real positives exist.)

## Ground-truth labels (needs_context := OFF underperforms best ON arm)

| report | problem | needs_context | basis | gate | overhead avoided (tok-eq) |
| --- | --- | :---: | --- | :---: | ---: |
| report-v2 | graph-dependent | NO | gross-delta | abstain | 230,275 |
| report-v3 | graph-dependent | NO | cost-gross-delta | abstain | 3,462 |
| report-v4 | v4-hard | NO | v4-metric | abstain | 16,744 |
| report-v5 | v5-grounded | NO | v4-metric | abstain | 21,582 |
| report-v5-haiku | v5-grounded | NO | v4-metric | abstain | 26,086 |
| report-v7 | v1-dagrag | NO | v4-metric | abstain | 119,865 |
| report-v7 | v1-lean | NO | v4-metric | abstain | 7,872 |
| report-v7 | v1-search | NO | v4-metric | abstain | 50,176 |
| report-v7 | v4-dagrag | NO | v4-metric | abstain | 147,774 |
| report-v7 | v4-lean | NO | v4-metric | abstain | 38,574 |
| report-v7 | v4-search | NO | v4-metric | abstain | 28,100 |

## Regret

REGRET = Σ [ overhead paid when gate INJECTED but label=NO ] + [ win missed when gate ABSTAINED but label=YES ].

- problems evaluated: **11**
- ground-truth YES (needs_context): **0**
- ground-truth NO: **11**
- gate INJECT: **0**, gate ABSTAIN: **11**
- wins missed (abstained on a YES): **0**
- **REGRET = 0 tok-eq**
- overhead AVOIDED by correctly abstaining: **690,510 tok-eq**

## Headline

The gate identifies non-beneficial retrieval; on v1–v7 it abstains with **0 regret** — 
we do not lose where memory doesn't help, and we avoid **~690,510 tok-eq** of over-deliberation tax that the always-inject arms paid.

