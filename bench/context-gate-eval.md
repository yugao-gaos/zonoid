# Context-need gate — labeled eval & regret

Generated 2026-06-10T11:02:57.847Z by `bench/context-gate-eval.js` from `bench/report-v2..v7.json`. **Offline only — no new agent runs.**

## The gate rule

Per task, decide INJECT vs ABSTAIN from the semantic KB. **DEFAULT = ABSTAIN.** Flip to INJECT
only when ALL of these hold (recalibrated off the first positive — see the held-out section):

1. **confidence** `top1 cosine >= 0.50` — best note clears a floor (lowered from 0.55: the real
   positive sat at 0.548). The gap signal, not cosine, now does the discrimination.
2. **empirical** the top note is scar-tissue (gotcha / decision-with-reason / root-cause / a
   measured silent failure), NOT a general principle the base model already knows.
3. **specificity** — `margin = top1 - top2 >= 0.12` (a sharp standalone hit) **OR** `external-gap
   >= 0.25` (the note shares the task's concrete vocabulary — it is ABOUT this task, not just
   topically nearby). The gap path is what fires inside a tight cosine cluster where margin can't.

Conservative by construction: when in doubt, abstain. **PROVISIONAL: calibrated on n=1 positive;**
**thresholds to be firmed up by task #9's second positive label.**

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

## Held-out POSITIVE recalibration (the first real win)

The conservative v1–v7 gate was tuned to ABSTAIN; this section is the INJECT-side calibration
against the **first positive label** — the held-out `task→transcript` win. The load-bearing note
(`note-mq7kyiir6sx`) scored **top1 cosine 0.548, margin 0.017**, so the OLD rule (cos≥0.55 AND
margin≥0.12) ABSTAINED and would have MISSED the win. MiniLM packs topically-adjacent orchestrator
notes into a tight 0.50–0.55 band, so neither a lower cosine cut nor margin separates the true
positive from topical noise. The **external-gap** signal does: fraction of the top note's content
tokens that recur in the task — 0.34 for the on-task scar vs ≤0.17 for every topical negative.

**New rule:** INJECT iff `top1 ≥ 0.50` AND top note is **empirical** AND (`margin ≥ 0.12` OR
`external-gap ≥ 0.25`). Otherwise ABSTAIN.

| task | label | gate | top1 | margin | gap | type | reason |
| --- | --- | :---: | ---: | ---: | ---: | --- | --- |
| task→transcript (held-out) | positive | inject | 0.548 | 0.017 | 0.337 | empirical | gap-specific-empirical |
| v1/context-rich | negative | abstain | 0.623 | 0.076 | 0.615 | neutral | non-empirical |
| v1/greenfield | negative | abstain | 0.522 | 0.059 | 0.09 | empirical | diffuse-match |
| v4-hard | negative | abstain | 0.639 | 0.019 | 0.178 | empirical | diffuse-match |
| v5-grounded | negative | abstain | 0.552 | 0.001 | 0.077 | empirical | diffuse-match |
| heldout/silent-cap | negative | abstain | 0.507 | 0.017 | 0.088 | empirical | diffuse-match |
| graph-dependent (v2/v3/v7) | negative-samedomain | inject | 0.71 | 0.049 | 0.717 | empirical | gap-specific-empirical |
| wincase-c | negative-samedomain | inject | 0.561 | 0.016 | 0.413 | empirical | gap-specific-empirical |

**Confusion matrix (scoped: 1 positive + plain negatives; same-domain controls excluded):**

| | gate INJECT | gate ABSTAIN |
| --- | :---: | :---: |
| label POSITIVE | TP = 1 | FN = 0 |
| label NEGATIVE | FP = 0 | TN = 5 |

- **scoped regret (FN + FP) = 0** — the recalibrated gate now catches the win it used to miss.

### HONEST CAVEAT — n=1, PROVISIONAL

- This is calibrated on **one** positive label. The gap threshold (0.25) and cosine floor (0.50)
  are a starting point, NOT a confidently-fit boundary. **Task #9's second positive is required**
  to firm them up.
- The same-micro-domain controls (`graph-dependent`, `wincase-c`) retrieve the SAME note and are
  textually NEARER to it than the positive itself, so the recalibrated gate also fires on them
  (2/2). They are NOT counted in scoped regret because the note post-dates them
  (temporal: it could not have been retrieved at their run time). But they prove a real limit:
  the note↔task gate cannot see WHY the win was a win — the held-out-ness (strategy absent from the
  task's own artifacts) is structural and external to the gate's inputs. Within one micro-domain,
  no monotone threshold on {cos, margin, gap} separates a held-out win from its self-solvable twins.

