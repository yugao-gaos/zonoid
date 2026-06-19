# Agent-Memory Benchmark Report — LoCoMo

_Metrics: LLM-judge accuracy (headline, comparable to published bars) + token-level F1 (diagnostic, deterministic) + pass/fail rate (coding benches)._

## Overall per arm

| Arm | LLM-judge accuracy | Token-F1 | n probes |
| --- | --- | --- | --- |
| dag-combined | 54.0% | 50.2% | 50 |
| distill | 52.0% | 49.1% | 50 |

## Per-category breakdown

| Category | dag-combined acc | dag-combined F1 | distill acc | distill F1 |
| --- | --- | --- | --- | --- |
| 1 | 26.3% | 37.7% | 21.1% | 35.7% |
| 2 | 83.3% | 71.4% | 79.2% | 71.2% |
| 3 | 28.6% | 11.0% | 42.9% | 9.5% |

## Scorecard

**Contrast axis: LLM-judge accuracy**

### Internal arms

| Arm | LLM-judge accuracy | n probes |
| --- | --- | --- |
| dag-combined | 54.0% | 50 |
| distill | 52.0% | 50 |

### Competitor bars (published)

| System | LongMemEval-Oracle | LongMemEval-S | LoCoMo | Source |
| --- | --- | --- | --- | --- |
| Mem0 | 92.5% | 94.4% | ~84% (disputed) | published |
| Zep | 91.6% | 94.8% | ~75.1% (corrected) | published |

> **Note:** competitor bars are from published papers and may be evaluated on different benchmark subsets, evaluation protocols, or model versions. Arm-vs-arm comparisons (internal table above) are directly comparable; internal vs competitor comparisons are cross-setup and should be interpreted as directional context, not apples-to-apples.

> **Note (LoCoMo scoring dispute):** LoCoMo vendor scores vary across sources: original paper 84%, third-party replication 58.4%, vendor-corrected 75.1%. Treat LoCoMo absolute accuracy numbers with caution; use the arm-vs-arm contrast (our-way vs search vs cold) as the primary comparison within this harness, not the absolute comparison to the published 84%. Competitor bars are published numbers on possibly different subsets/protocols — directional context, not apples-to-apples.
