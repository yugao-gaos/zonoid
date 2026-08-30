# VoiceMem memory-lane promotion report

## Decision: HOLD

The lane-aware compiler clears the correctness gates, but the feature set must
remain disabled by default. The outcome-guided arm exceeds the injected-token
budget, and the in-process latency measurement does not clear the 10% p95 gate
with enough confidence.

## Three-arm result

Each arm ran the unchanged six-case fixture 50 times per case (300 latency
samples per arm) through `lib/search/context-compiler.js`.

| Metric | Current | Lane-aware | Lane-aware + outcome policy |
| --- | ---: | ---: | ---: |
| Factual accuracy | 0.600 | 1.000 | 1.000 |
| Guidance-as-fact leakage | 1.000 | 0.000 | 0.000 |
| Source-role confusion | 0.400 | 0.000 | 0.000 |
| Stale-current leakage | 0.000 | 0.000 | 0.000 |
| Recall@5 | 1.000 | 1.000 | 1.000 |
| MRR | 0.667 | 0.900 | 0.900 |
| Evidence tokens, estimated mean | 39.333 | 26.500 | 26.500 |
| Guidance tokens, estimated mean | 0.000 | 13.167 | 32.667 |
| Total injected tokens, estimated mean | 39.333 | 39.333 | 58.833 |
| p95 latency | 0.418 ms | 0.427 ms | 0.436 ms |
| Approx. p95 interval | 0.390–0.508 ms | 0.393–0.588 ms | 0.395–0.589 ms |

The outcome arm used the production derivation module, three unique resolved
outcomes, and one repository-scoped source guidance note. It created exactly one
policy and the compiler returned that policy only in `guidance_results`.

## Promotion gates

| Gate | Result | Evidence |
| --- | --- | --- |
| No guidance-as-fact leakage | PASS | Both enabled arms: 0.000 |
| No source-role confusion | PASS | Both enabled arms: 0.000 |
| No stale-current leakage | PASS | Both enabled arms: 0.000 |
| Recall@5 loses at most 0.01 | PASS | Baseline and both enabled arms: 1.000 |
| No held-out task-context regression | PASS | Evidence stayed factual; guidance stayed available in its internal lane |
| p95 latency overhead at most 10% | **FAIL** | Limit 0.460 ms; enabled-arm interval highs were 0.588 and 0.589 ms |
| Injected-token overhead at most 10% | **FAIL** | Lane-aware: +0%; outcome arm: +49.6% |
| Outcome policy remains guidance | PASS | One derived and recalled policy; no factual injection |
| Features remain default-off | PASS | Request/config opt-in required |

Latency is a sub-millisecond, in-process microbenchmark and is sensitive to
local scheduling. The gate uses an approximate 95% order-statistic interval
around p95; the point estimates alone are not enough to justify promotion.

## Additional evidence

- Temporal suite: 5/5 queries, Recall@5 1.000 and MRR 1.000; latest-only control
  was 0.600 for both metrics.
- Current synthetic LoCoMo fixture: 2 probes, token F1 `search=1.000`,
  `our-way=0.000`, `cold=0.000`.
- Current synthetic LongMemEval-Oracle fixture: 2 probes, token F1
  `search=0.833`, `our-way=0.000`, `cold=0.000`.
- Historical real LoCoMo reference: 50 probes and combined accuracy 0.540. It
  used a different setup and is not a promotion gate.

The current fixture runs disabled the LLM judge, so they are pipeline and token-F1
evidence only. The zero `our-way` fixture result is a known bounded-path weakness,
not evidence of a new lane regression; it is another reason not to broaden the
promotion claim.

## Scoring definition and audit note

Recall and reciprocal rank are measured within the lane containing the gold
item. Factual accuracy and factual abstention use evidence only. Source role is
checked against the top result in the gold lane. This avoids calling correctly
partitioned guidance "missing" while still preventing it from supporting a fact.

An initial pre-correction scorer reported lane-aware Recall@5 `0.8` and
source-role confusion `0.2` because it treated separated guidance as absent
evidence and checked its role against the evidence channel. That output is
retained here for audit. No fixture, gold label, or lane-specific result was
changed or suppressed.

## Commands

```sh
node test/memory-lane-baseline.test.js
node test/memory-lane-context.test.js
node test/outcome-policy-memory.test.js
node test/outcome-policy-memory-route.test.js
node test/temporal-knowledge.test.js
node bench/temporal/run.js
node bench/agent-memory/memory-lane-baseline/evaluate.js --repeats 50 --output reports/voicemem-memory-lanes/evaluation.json
python3 bench/agent-memory/run.py --benchmark locomo --data-dir bench/agent-memory/fixtures --arms our-way,search,cold --max-probes 2 --no-llm-judge --no-resume
python3 bench/agent-memory/run.py --benchmark longmemeval-oracle --data-dir bench/agent-memory/fixtures --arms our-way,search,cold --max-probes 2 --no-llm-judge --no-resume
```

## Evidence limits

Only committed synthetic LoCoMo and LongMemEval fixtures were available. The
six-case lane fixture and five-case temporal fixture are regression gates, not a
broad accuracy estimate. Rerun the latency gate on target hardware and run a
licensed full benchmark before reconsidering defaults.
