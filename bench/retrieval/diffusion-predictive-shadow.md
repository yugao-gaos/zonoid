# Diffusion Predictive Shadow Benchmark

Generated: 2026-06-22T01:23:55.327Z
Workspace: `/Users/imyu/Desktop/zonoid/.zonoid/worktrees/62dae274979b8432/codex-diffusion-predictive-shadow-benchmark`
Graph snapshot: `/Users/imyu/Desktop/zonoid/.zonoid/worktrees/62dae274979b8432/codex-diffusion-predictive-shadow-benchmark/.graph/checkpoint.json`

This is an offline shadow run. It reads gate labels, graph state, and retrieval weights, but it does not write `.graph/retrieval-weights.jsonl` or mutate overlay edge weights.

## Inputs

- Labeled rows: 83
- Quadrants: TP 6, FP 1, FN 1, TN 75, unknown 0
- Rows with recalled edge metadata: 0
- Graph tasks: 1972
- Judged context edges: 2964

## Data Notes

- No labeled gate rows include recalled_context_edges/recalled_edges; the current live data is sparse for this benchmark.

## Strategy Metrics

| Metric | Direct baseline | Diffused strategy |
| --- | ---: | ---: |
| Updated edge count | 0 | 0 |
| Update attempts | 0 | 0 |
| Avg final updated weight | n/a | n/a |
| Min final updated weight | n/a | n/a |
| Max final updated weight | n/a | n/a |
| Avg actual delta | n/a | n/a |
| Matched edges moved expected direction | 0/0 | 0/0 |

## Direct Vs Diffused Deltas

- Compared edges: 0
- Direct-only changed edges: 0
- Diffused-only changed edges: 0
- Average delta difference: n/a
- Average absolute delta difference: n/a
