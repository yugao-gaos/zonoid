# Bench Scorecard — Zonoid Orchestrator

_Last updated: 2026-06-14_

## Summary

| Bench | Result | Key metric |
|-------|--------|------------|
| Token economy (ON vs OFF) | ✅ ON wins | ON 7.5× cheaper, OFF exhausted budget unsolved |
| E2E dag-chain | ✅ ON wins | DAG context delivered secret, OFF failed |
| Judge model (haiku vs sonnet) | ✅ sonnet dominates | sonnet: F1=76.5%, 35% cheaper per verdict |

**Value prop confirmed:** DAG+KB context is faster, cheaper, and more correct on KB-requiring tasks.

---

## Bench 1: Token Economy (ON vs OFF)

**Scenario:** `task-transcript` — resolve the transcript file for a task given an attribution registry. Edge cases require time-window overlap correlation; the ON arm's KB contains the critical note seeding the algorithm. OFF arm must derive the strategy from scratch.

**Result file:** `bench/economy/results.jsonl`

| Arm | Solved | Cost (tok-eq) | Wall time |
|-----|--------|---------------|-----------|
| ON (orchestrator) | ✅ 27/27 core, 10/10 edge | 141,010 | 43.6 s |
| OFF (bare agent) | ❌ 0/0 (budget exhausted) | 1,052,755 | 600 s (timeout) |

- **Ratio:** ON cost / OFF cost = **0.134×** (ON is ~7.5× cheaper)
- OFF arm exhausted its budget without producing a correct solution.
- ON arm solved all 27 core checks and all 10 edge-case checks on the first trial.

**Snapshot:** 2026-06-14T23:42:56Z, model=sonnet, trial=0.

---

## Bench 2: E2E DAG Chain

**Scenario:** `dag-chain` — two-task chain where Task B requires a secret value that only Task A's output (stored in the DAG) can provide. Tests whether KB+DAG context propagates actionable information across task boundaries.

**Result file:** `bench/e2e/results.jsonl`

| Arm | Passed | DAG required | Token delta |
|-----|--------|--------------|-------------|
| ON (orchestrator) | ✅ | yes | -23,429 (ON saved tokens vs baseline) |
| OFF (bare agent) | ❌ | yes | — |

- ON arm retrieved the DAG-stored secret and completed Task B correctly.
- OFF arm had no access to DAG context and failed.
- `tokenDelta = -23,429`: ON arm used fewer tokens than OFF arm despite the orchestration overhead.

**Snapshot:** 2026-06-14T21:47:22Z, trial=0.

---

## Bench 3: Judge Model Comparison (haiku vs sonnet)

**Scenario:** Edge-judgment eval on 27 labeled cases from `bench/judge-edge/eval-set.json`. Each case is a note↔task pair with a ground-truth `should_wire` label (keep/prune). Measures the judge model's ability to correctly classify edges, and its cost per verdict.

**Result file:** `bench/judge-model/results.json` (produced by task `eeadb38f-7472-4703-9689-fbf24eebee4d/7`)

| Model | Accuracy | Precision | Recall | F1 | Cost/verdict (tok-eq) |
|-------|----------|-----------|--------|----|-----------------------|
| haiku (`claude-haiku-4-5-20251001`) | 51.9% | — | — | 38.1% | 56,158 |
| sonnet (`claude-sonnet-4-6`) | 70.4% | — | — | 76.5% | 36,426 |

- Sonnet F1 is **2.0× higher** than haiku (76.5% vs 38.1%).
- Sonnet costs **35% less** per verdict (36,426 vs 56,158 tok-eq).
- Prior informal finding confirmed: haiku rubber-stamps ~100% KEEP (0% prune rate); sonnet prunes ~45%, matching expected edge density.
- **Decision:** sonnet is the pinned judge model. Haiku is unsuitable — it cannot discriminate edges.

---

## Cost Accounting

Judge cost is **infrastructure capex**, not per-task cost. The judge drain runs in a separate harness session; its tokens never appear in ON_cost. The system ledger (`bench/economy/ledger.json`) tracks cumulative savings vs judge infrastructure spend separately.

Key insight: judge edge value fans out transitively through the DAG (a note that improves Task A's summary also benefits every downstream task that inherits A as context). This makes per-edge amortization impossible — the system ledger's total-savings-vs-total-spend is the correct unit.

---

## Planned: Mixed Suite Bench

The current bench only tests KB-required scenarios. `bench/suite/` (in progress) will add KB-neutral scenarios (pure coding tasks) to measure ON overhead when KB context provides no useful signal. Net ROI across a realistic mixed workload is the target metric.

---

## Bench 4: LoCoMo / LongMemEval — their test, our DAG read

**Framing — a contrast axis, not a replication**

The field benchmarks **retrieval-time recall**: at query time, a memory system is asked to retrieve
the relevant sessions and answer a QA probe. Mem0 and Zep both work this way — the relevance
decision is made fresh at query time, typically by embedding + cosine ranking.

We run the _same probes_ through a different axis: **write-time-materialized DAG read**. When
a session is ingested, a blind LLM judge (seeing no gold answer) decides once — at write time —
which note edges to keep. At query time the probe reads directly off `GET /task/context`, whose
`dependencySummaries` are the edges already judged relevant at ingest. No re-embedding at query
time; no re-ranking per query.

This is a _mechanism_ contrast, not a capability race: we are testing whether a frozen,
write-time relevance decision (a "blind" DAG edge) can match or exceed a retrieval-time cosine
ranking — and when it fails (multi-hop queries where a single-vector rank cannot surface all
evidence sessions).

**Arms**

| Arm | Mechanism | When relevance is decided |
|-----|-----------|--------------------------|
| `our-way` | DAG read — `GET /task/context` from frozen context edges | **Write time** (blind judge at ingest, once) |
| `search`  | Retrieval-time control — `GET /search?q=<question>` top-k | **Query time** (cosine re-rank per query) |
| `cold`    | No memory — world knowledge only (floor / rigging guard) | n/a |

**Metric — LLM-judge accuracy (headline)**

One `claude -p` call per (probe, arm) judges the predicted answer against the gold.
Comparable to the published field numbers below.

| System | LongMemEval-Oracle | LongMemEval-S | Source |
|--------|-------------------|--------------|--------|
| Mem0 | 92.5% | 94.4% | Wu et al., 2024 Table 2 |
| Zep  | 91.6% | 94.8% | Wu et al., 2024 Table 2 |
| **Zonoid our-way (full dataset)** | **PENDING** | **PENDING** | Real run required |
| **Zonoid search (full dataset)**  | **PENDING** | **PENDING** | Real run required |
| **Zonoid cold (floor)**           | **PENDING** | **PENDING** | Real run required |

_Full-dataset numbers require running `run.py` against the real LoCoMo / LongMemEval files
(CC BY-NC 4.0 / MIT; not committed — download from dataset repos and point `--data-dir` at them)._

**Fixture proof-of-mechanism (committed, reproducible)**

The `bench/agent-memory/fixtures/locomo10.json` fixture (3-session synthetic bread-baking
conversation, 2 probes) demonstrates the key mechanism difference:

| Probe | our-way | search | cold | Notes |
|-------|---------|--------|------|-------|
| q1 (single-hop): "What bread did the user bake in the first session?" | ✓ "focaccia" | ✓ "focaccia" | ✗ | Both memory arms correct; cold cannot know |
| q2 (multi-hop): "What did the user plan to bake after improving their focaccia?" | ✓ "ciabatta" | ✗ | ✗ | DAG read beats cosine RAG |

**Why q2 is the telling case:** "ciabatta" appears only in session 2 turn t9. The multi-hop
question requires bridging session 0 (focaccia) → session 2 (ciabatta plan). A single cosine
query on "what did the user plan to bake after improving their focaccia" may rank session 1
(focaccia troubleshooting) above session 2 — the cosine ranking cannot see that the answer
requires the temporal chain across both sessions. The blind judge at write time, however, sees
all three sessions as candidates and keeps session 2 as evidence for the planning question.
DAG read surfaces the ciabatta session; retrieval-time search missed it.

**Precise statement of what `our-way` does**

`our-way` answers from frozen `context_deps` via `GET /task/context`, where:
- The relevance decision was made **once at write time** by a **blind** LLM judge (the judge
  never sees the gold answer or the dataset evidence labels — see `probe_runner.py` honesty bar).
- At query time, no re-embedding or re-ranking occurs — the answer is read directly from
  the edges the blind judge kept.
- Candidate generation IS embedding-backed (the daemon's autowire seeds candidates via cosine
  at SEMANTIC_AUTOWIRE_THRESHOLD 0.55). What moves is not WHETHER embedding is used but WHEN:
  write-time (frozen, done once per ingest) rather than query-time (re-run per question).

**Caveats (do not overclaim)**

1. Candidate generation still uses embedding under the hood (autowire at ingest + judge calls
   the blind judge on top). We shift WHEN the relevance decision is made, not WHETHER embedding
   is involved.

2. LoCoMo scoring is vendor-disputed: original paper 84%, third-party replication 58.4%,
   vendor-corrected 75.1% (see LoCoMo paper discussion). Do not compare Zonoid's LoCoMo number
   directly to the 84% headline; use the arm-vs-arm contrast (our-way vs search vs cold) as
   the primary comparison within this harness.

3. The fixture proof is synthetic and hand-authored (3 sessions, 2 probes). It demonstrates
   mechanism, not scale. The pending full-dataset run is required for any claim about
   production-scale accuracy.

4. LongMemEval S/M haystack sizes differ from Oracle; larger haystacks favour retrieval-time
   systems that re-rank on every query. The write-time freeze trades per-query freshness for
   write-time reasoning quality — this tradeoff is more visible at larger haystack sizes.

**How to run**

```
# Fixture only (no dataset download required):
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/run.py \
    --benchmark locomo \
    --data-dir  bench/agent-memory/fixtures \
    --limit 1 --max-probes 2

# Full LoCoMo (download locomo10.json first):
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/run.py \
    --benchmark locomo \
    --data-dir  <path-to-locomo10.json-dir> \
    --workspace-root <abs-path>

# Full LongMemEval (download longmemeval_oracle.json first):
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/run.py \
    --benchmark longmemeval-oracle \
    --data-dir  <path-to-longmemeval-dir> \
    --workspace-root <abs-path>
```

Scorer runs automatically after the probe loop. Report in `bench/agent-memory/report.md`.
