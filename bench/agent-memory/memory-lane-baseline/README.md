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

Use `--output <path>` to save the JSON report and `--repeats <n>` to adjust the
latency sample count. The report includes factual accuracy, guidance leakage,
source-role confusion, stale-memory leakage, Recall@5, MRR, estimated prompt
tokens, and p95 retrieval latency.

`memory_lane`, `source_role`, and `authority` in `dataset.json` are gold labels
used only by the scorer. They are deliberately ignored by the current compiler;
later feature stages can rerun this exact suite to quantify improvement.

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
