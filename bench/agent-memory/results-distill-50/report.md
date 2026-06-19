# Agent-Memory Benchmark Report — LoCoMo

_Metrics: LLM-judge accuracy (headline, comparable to published bars) + token-level F1 (diagnostic, deterministic) + pass/fail rate (coding benches)._

## Overall per arm

| Arm | LLM-judge accuracy | Token-F1 | n probes |
| --- | --- | --- | --- |
| combined | 36.0% | 32.8% | 50 |
| distill | 34.0% | 30.3% | 50 |

## Per-category breakdown

| Category | combined acc | combined F1 | distill acc | distill F1 |
| --- | --- | --- | --- | --- |
| 1 | 26.3% | 27.0% | 21.1% | 22.1% |
| 2 | 50.0% | 46.9% | 50.0% | 45.6% |
| 3 | 14.3% | 0.0% | 14.3% | 0.0% |

## Scorecard

**Contrast axis: LLM-judge accuracy**

### Internal arms

| Arm | LLM-judge accuracy | n probes |
| --- | --- | --- |
| combined | 36.0% | 50 |
| distill | 34.0% | 50 |

### Competitor bars (published)

| System | LongMemEval-Oracle | LongMemEval-S | LoCoMo | Source |
| --- | --- | --- | --- | --- |
| Mem0 | 92.5% | 94.4% | ~84% (disputed) | published |
| Zep | 91.6% | 94.8% | ~75.1% (corrected) | published |

> **Note:** competitor bars are from published papers and may be evaluated on different benchmark subsets, evaluation protocols, or model versions. Arm-vs-arm comparisons (internal table above) are directly comparable; internal vs competitor comparisons are cross-setup and should be interpreted as directional context, not apples-to-apples.

> **Note (LoCoMo scoring dispute):** LoCoMo vendor scores vary across sources: original paper 84%, third-party replication 58.4%, vendor-corrected 75.1%. Treat LoCoMo absolute accuracy numbers with caution; use the arm-vs-arm contrast (our-way vs search vs cold) as the primary comparison within this harness, not the absolute comparison to the published 84%. Competitor bars are published numbers on possibly different subsets/protocols — directional context, not apples-to-apples.
