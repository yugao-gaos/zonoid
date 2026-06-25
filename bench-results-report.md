# Zonoid Retrieval Bench

_Metrics: LLM-judge accuracy (headline, comparable to published bars) + token-level F1 (diagnostic, deterministic) + pass/fail rate (coding benches)._

## Overall per arm

| Arm | LLM-judge accuracy | Token-F1 | n probes |
| --- | --- | --- | --- |
| cold | 58.9% | 16.3% | 73 |
| on | 76.7% | 23.5% | 73 |
| rag_control | 49.3% | 16.8% | 73 |

## Per-category breakdown

| Category | cold acc | cold F1 | on acc | on F1 | rag_control acc | rag_control F1 |
| --- | --- | --- | --- | --- | --- | --- |
| config | 100.0% | 19.8% | 100.0% | 15.2% | 33.3% | 6.3% |
| convention | 66.7% | 23.1% | 80.0% | 34.7% | 80.0% | 29.1% |
| decision | 36.4% | 8.0% | 68.2% | 20.0% | 36.4% | 9.8% |
| gotcha | 44.4% | 15.3% | 77.8% | 24.7% | 50.0% | 17.7% |
| invariant | 91.7% | 23.1% | 75.0% | 18.0% | 41.7% | 18.1% |
