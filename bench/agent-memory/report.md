# Agent-Memory Benchmark Report — LongMemEval

_Metrics: LLM-judge accuracy (headline, comparable to published bars) + token-level F1 (diagnostic, deterministic) + pass/fail rate (coding benches)._

## Overall per arm

| Arm | LLM-judge accuracy | Token-F1 | n probes |
| --- | --- | --- | --- |
| our-way | 100.0% | 81.2% | 4 |
| search | 0.0% | 0.0% | 4 |
| cold | 0.0% | 0.0% | 4 |

## Per-category breakdown

| Category | our-way acc | our-way F1 | search acc | search F1 | cold acc | cold F1 |
| --- | --- | --- | --- | --- | --- | --- |
| multi-hop | 100.0% | 100.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| multi-session | 100.0% | 100.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| single-hop | 100.0% | 100.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| temporal-reasoning | 100.0% | 25.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Scorecard

**Contrast axis: LLM-judge accuracy**

### Internal arms

| Arm | LLM-judge accuracy | n probes |
| --- | --- | --- |
| our-way | 100.0% | 4 |
| search | 0.0% | 4 |
| cold | 0.0% | 4 |

### Competitor bars (published)

| System | LongMemEval-Oracle | LongMemEval-S | LoCoMo | Source |
| --- | --- | --- | --- | --- |
| Mem0 | 92.5% | 94.4% | ~84% (disputed) | published |
| Zep | 91.6% | 94.8% | ~75.1% (corrected) | published |

> **Note:** competitor bars are from published papers and may be evaluated on different benchmark subsets, evaluation protocols, or model versions. Arm-vs-arm comparisons (internal table above) are directly comparable; internal vs competitor comparisons are cross-setup and should be interpreted as directional context, not apples-to-apples.

> **Note (LoCoMo scoring dispute):** LoCoMo vendor scores vary across sources: original paper 84%, third-party replication 58.4%, vendor-corrected 75.1%. Treat LoCoMo absolute accuracy numbers with caution; use the arm-vs-arm contrast (our-way vs search vs cold) as the primary comparison within this harness, not the absolute comparison to the published 84%. Competitor bars are published numbers on possibly different subsets/protocols — directional context, not apples-to-apples.
