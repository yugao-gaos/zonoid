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
