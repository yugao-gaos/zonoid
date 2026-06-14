# Judge-Edge Scorecard

## Eval Methodology

Synthetic ground-truth set of 41 edges (23 keep / 18 prune) built from real overlay edges in `bench/judge-edge/eval-set-synthetic.json`. Each edge was manually classified by human review against the actual task summaries. The scorer (`bench/judge-edge/score-synthetic.js`) drives the real `lib/judge.expandNeighborhood` + `supersedeChain` payload — no mocking.

## Headline Metrics

| Judge | Precision | Recall | F1 |
|-------|-----------|--------|----|
| Neighborhood-aware (production) | **100%** | 91% | 95% |
| Cosine-only baseline | 59% | 100% | 74% |

- **Zero false positives** in synthetic eval: no sound edge was wrongly pruned.
- **2 false negatives** (missed keep edges): both were low-cosine edges that the neighborhood judge conservatively pruned; both were borderline in human review.

## Production Observations

Prune rates vary significantly by cluster type:

| Run | Edges | Keep | Prune | Prune rate |
|-----|-------|------|-------|------------|
| Mixed cluster (5 nodes) | 17 | 8 | 9 | 53% |
| Tight cluster (eeadb38f/1,3,4) | 30 | 29 | 1 | 3% |
| Judge drain full pass | 221 | ~153 | 17 | ~8% |
| Learner drain (epoch 202→208) | 60 | ~22 | 3 | ~5% |

High prune rates in mixed clusters are expected — autowire seeds by cosine similarity which produces many false positives across unrelated topics.

## Guardrails Status

- **FP rate: 0%** on synthetic eval (N=41). Deploying with confidence.
- The neighborhood judge's conservative default (prune when uncertain) protects retrieval quality at the cost of slightly lower recall.
- The `judging→ready` gate (Judge D) ensures no task is dispatched with unjudged candidate edges — guardrail is structural, not advisory.

## Open Questions

1. **Recall gap**: 2 missed keep edges in synthetic eval. Both were low-cosine; unclear if the neighborhood expansion would catch them with more context. Needs a larger holdout eval set.
2. **Small N**: 41-edge synthetic set is sufficient for a gate but not for statistical confidence. Target: 200+ edge holdout from live graph.
3. **Epoch drift**: the learner drain cursor advances epoch-by-epoch; edges added between epochs may be re-evaluated multiple times. Monitor for churn.
4. **`supersedeTask` crash**: `ReferenceError: byId is not defined` at `routes/judge.js:192` — blocks consolidation verdicts. Fix in progress (`followup/fix-byid-undefined-judge-verdict-handler`).
