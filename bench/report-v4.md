# Headless bench report

Generated 2026-06-09T20:16:30.450Z from `bench/results-v4.jsonl` (10 result lines).

Token figures are **mean ± sample stdev** over solved trials. GROSS = all `message.usage` in the
transcript; PLUMBING = usage on messages tagged `attributionMcpServer:"orchestrator-graph"`; NET = GROSS - PLUMBING.

## Per problem × arm — Raw tokens

Every token counted equally (cache reads at face value). This OVERSTATES dollar cost.

| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| v4-hard | off | 5 | 179,498 ± 39,770 | 179,498 ± 39,770 | 0 ± 0 | 85,070 ± 15,993 |
| v4-hard | on | 5 | 290,960 ± 29,415 | 93,257 ± 24,817 | 197,703 ± 33,283 | 89,222 ± 12,513 |

## Per problem × arm — Cost-weighted (tok-equivalents)

Input-token-equivalents: input×1, output×5, cache_read×0.1, cache_creation×1.25. Weights are **approximate** and model-dependent.

| problem | arm | n | cost gross (tok-eq) | cost net (tok-eq) |
| --- | --- | ---: | ---: | ---: |
| v4-hard | off | 5 | 156,534 ± 27,386 | 156,534 ± 27,386 |
| v4-hard | on | 5 | 173,562 ± 12,555 | 53,519 ± 15,253 |

## Headline ratios (ON vs OFF, per problem)

Ratio of arm-ON mean over arm-OFF mean. <1.0× means the orchestrator arm used fewer tokens.

Raw columns weight every token equally; cost-weighted columns use the tok-equivalent weights above
(input/output/cache_read/cache_creation) and are **approximate**.

| problem | net ON/OFF (raw) | gross ON/OFF (raw) | cost net ON/OFF | cost gross ON/OFF |
| --- | ---: | ---: | ---: | ---: |
| v4-hard | 0.520× | 1.621× | 0.342× | 1.109× |

## v4 decomposition (W / H / C)

Decomposes spend into **Real-Work** `W` (= `diffTokens`, the final solution size), **Hardness**
`H = max(0, total_output — W)` (output beyond the artifact), and **Consult-overhead** `C`
(extra cache cost the ON arm carries to hold graph context). Means are over solved trials.

| problem | arm | n | W (tok) | total_output (tok) | H (tok) | explorers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| v4-hard | off | 5 | 374 ± 25 | 19,057 ± 4,337 | 18,682 ± 4,327 | 2 ± 0 |
| v4-hard | on | 5 | 403 ± 33 | 18,617 ± 3,533 | 18,214 ± 3,535 | 3 ± 1 |

`C = costCache(ON) — costCache(OFF)` where `costCache = cache_read×0.1 + cache_creation×1.25`. `METRIC = (H_off — H_on)×5 — C` (hardness savings cost-weighted by the output weight, minus consult overhead).

| problem | C (tok-eq) | METRIC (tok-eq) | pooled stdev (n) |
| --- | ---: | ---: | ---: |
| v4-hard | 19,084 | -16,744 | 18,666 (n=10) |

**Win evaluation** (all four guards must PASS for a WIN):

- precondition: `H_off >= 2×W_off` (hardness must dominate raw work)
- fairness: both-arm solve-rate >= 0.8
- margin: `METRIC > 0` AND gap > 1 pooled stdev
- corroboration: `W_on / W_off <= 1.1` (ON not just writing less code)

| problem | precondition | fairness | margin | corroboration | WIN |
| --- | --- | --- | --- | --- | --- |
| v4-hard | PASS | PASS | FAIL | PASS | NO-WIN |

Guard inputs per problem:

- **v4-hard**: W_on=403 W_off=374 (ratio 1.076); H_on=18,214 H_off=18,682 (2×W_off=748); solve ON=1.000 OFF=1.000; C=19,084; METRIC=-16,744.

## Contamination & drop notes

No contamination: every OFF-arm run had zero `orchestrator-graph` attribution.

No runs dropped: all input runs were solved.

## Known limitation

MCP tool **schema** tokens loaded into context (counted under `cache_creation_input_tokens` /
`cache_read_input_tokens` when the system prompt + tool list are cached) are amortized across the
whole session and are **not attributable to individual messages**. PLUMBING therefore captures the
orchestrator `tool_use` / `tool_result` round-trips but **under-counts the always-resident schema
overhead** of having the orchestrator-graph MCP server loaded. Treat NET as an upper bound on the
"work-only" token cost and PLUMBING as a lower bound on the true orchestration overhead.
