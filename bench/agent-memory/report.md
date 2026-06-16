# Agent-Memory Benchmark Report — LoCoMo

_Metric: LLM-judge accuracy (headline) + token-level F1 (diagnostic)._  
_Competitor bars: Mem0 92.5/94.4, Zep 91.6/94.8 (LongMemEval Oracle/S; Wu et al., 2024)._

## Overall accuracy per arm

| Arm | LLM-judge accuracy | Token-F1 | n probes |
|-----|-------------------|----------|---------|
| our-way | 100.0% | 100.0% | 2 |
| search | 50.0% | 50.0% | 2 |
| cold | 0.0% | 0.0% | 2 |
| *(Mem0)* | *(92.5% / 94.4%)* | *(n/a)* | *(published)* |
| *(Zep)*  | *(91.6% / 94.8%)* | *(n/a)* | *(published)* |

## Per-category accuracy

| Category | our-way acc | search acc | cold acc | our-way F1 | search F1 | cold F1 |
| --- | --- | --- | --- | --- | --- | --- |
| multi-hop | 100.0% | 0.0% | 0.0% | 100.0% | 0.0% | 0.0% |
| single-hop | 100.0% | 100.0% | 0.0% | 100.0% | 100.0% | 0.0% |

## Competitor context

| System | LongMemEval-Oracle | LongMemEval-S | Source |
|--------|-------------------|--------------|--------|
| Mem0 | 92.5% | 94.4% | Wu et al., 2024 Table 2 |
| Zep  | 91.6% | 94.8% | Wu et al., 2024 Table 2 |

> **Note (LoCoMo scoring dispute):** LoCoMo vendor scores vary across sources: original paper 84%, third-party replication 58.4%, vendor-corrected 75.1%. Treat LoCoMo absolute accuracy numbers with caution; use them for arm-vs-arm comparisons rather than absolute comparisons to the published 84%.
