# Memory-lane baseline

This deterministic benchmark measures the current search compiler before any
evidence-versus-guidance runtime changes. It uses fixture-only notes and calls
`lib/search/context-compiler.js` directly, so it needs neither a daemon nor an
LLM.

The fixture covers:

- a user fact competing with assistant speculation;
- standing guidance retrieved near factual evidence;
- a superseded preference;
- tool and artifact evidence;
- entity-expanded recall; and
- a no-evidence query that should abstain.

Run it from the repository root:

```sh
node bench/agent-memory/memory-lane-baseline/run.js
```

The command above remains the frozen `current` arm. The opt-in comparison arms
are available without changing runtime defaults:

```sh
node bench/agent-memory/memory-lane-baseline/run.js --arm lane-aware
node bench/agent-memory/memory-lane-baseline/run.js --arm lane-aware-outcome
node bench/agent-memory/memory-lane-baseline/evaluate.js --repeats 50
```

Use `--output <path>` to save the JSON report and `--repeats <n>` to adjust the
latency sample count. The report includes factual accuracy, guidance leakage,
source-role confusion, stale-memory leakage, Recall@5, MRR, estimated prompt
tokens, and p95 retrieval latency.

`memory_lane`, `source_role`, and `authority` in `dataset.json` are gold labels.
The frozen `current` arm leaves lane partitioning off; the comparison arms pass
the production compiler's explicit `memory_lanes=1` opt-in. The outcome arm also
derives one scoped policy through the production outcome-policy module after
three unique resolved outcomes. Neither feature is enabled by default.

Recall and reciprocal rank are scored within the lane containing the gold item.
Factual accuracy and no-evidence abstention use evidence only, while source role
is checked against the top item in the gold lane. Reports retain evidence-token,
guidance-token, and combined injected-token estimates separately.

An initial pre-correction evaluation treated a correctly separated guidance
result as absent evidence and reported lane-aware Recall@5 `0.8` and source-role
confusion `0.2`. That output is retained as an audit note in the evaluation
report and is not used for gates. The fixture and gold labels were not changed.

## Current-compiler baseline

The quality metrics below are deterministic for this fixture at the baseline
commit. Latency is intentionally omitted because the report measures it on the
machine executing the run.

| Metric | Baseline |
|---|---:|
| Factual accuracy | 0.600 |
| Guidance leakage rate | 1.000 |
| Source-role confusion rate | 0.400 |
| Stale-memory leakage rate | 0.000 |
| Recall@5 | 1.000 |
| MRR | 0.667 |
| Mean estimated prompt tokens | 39.333 |

This makes the intended target explicit: preserve recall and temporal behavior
while eliminating guidance-as-fact and source-role mistakes.
