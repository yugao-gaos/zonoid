# Headless bench report

Generated 2026-06-09T21:50:58.827Z from `bench/results-v5-haiku.jsonl` (10 result lines).

Token figures are **mean ± sample stdev** over solved trials. GROSS = all `message.usage` in the
transcript; PLUMBING = usage on messages tagged `attributionMcpServer:"orchestrator-graph"`; NET = GROSS - PLUMBING.

## Per problem × arm — Raw tokens

Every token counted equally (cache reads at face value). This OVERSTATES dollar cost.

| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| v5-grounded | off | 5 | 444,802 ± 45,971 | 444,802 ± 45,971 | 0 ± 0 | 30,079 ± 3,276 |
| v5-grounded | on | 5 | 537,183 ± 92,737 | 365,373 ± 216,276 | 171,810 ± 242,508 | 45,748 ± 18,692 |

## Per problem × arm — Cost-weighted (tok-equivalents)

Input-token-equivalents: input×1, output×5, cache_read×0.1, cache_creation×1.25. Weights are **approximate** and model-dependent.

| problem | arm | n | cost gross (tok-eq) | cost net (tok-eq) |
| --- | --- | ---: | ---: | ---: |
| v5-grounded | off | 5 | 129,253 ± 9,721 | 129,253 ± 9,721 |
| v5-grounded | on | 5 | 155,240 ± 21,797 | 121,363 ± 59,650 |

## Headline ratios (ON vs OFF, per problem)

Ratio of arm-ON mean over arm-OFF mean. <1.0× means the orchestrator arm used fewer tokens.

Raw columns weight every token equally; cost-weighted columns use the tok-equivalent weights above
(input/output/cache_read/cache_creation) and are **approximate**.

| problem | net ON/OFF (raw) | gross ON/OFF (raw) | cost net ON/OFF | cost gross ON/OFF |
| --- | ---: | ---: | ---: | ---: |
| v5-grounded | 0.821× | 1.208× | 0.939× | 1.201× |

## v4 decomposition (W / H / C)

Decomposes spend into **Real-Work** `W` (= `diffTokens`, the final solution size), **Hardness**
`H = max(0, total_output — W)` (output beyond the artifact), and **Consult-overhead** `C`
(extra cache cost the ON arm carries to hold graph context). Means are over solved trials.

| problem | arm | n | W (tok) | total_output (tok) | H (tok) | explorers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| v5-grounded | off | 5 | 332 ± 17 | 7,776 ± 1,113 | 7,444 ± 1,129 | 4 ± 1 |
| v5-grounded | on | 5 | 309 ± 68 | 10,027 ± 3,348 | 9,719 ± 3,393 | 4 ± 1 |

`C = costCache(ON) — costCache(OFF)` where `costCache = cache_read×0.1 + cache_creation×1.25`. `METRIC = (H_off — H_on)×5 — C` (hardness savings cost-weighted by the output weight, minus consult overhead).

| problem | C (tok-eq) | METRIC (tok-eq) | pooled stdev (n) |
| --- | ---: | ---: | ---: |
| v5-grounded | 14,714 | -26,086 | 13,342 (n=10) |

**Win evaluation** (all four guards must PASS for a WIN):

- precondition: `H_off >= 2×W_off` (hardness must dominate raw work)
- fairness: both-arm solve-rate >= 0.8
- margin: `METRIC > 0` AND gap > 1 pooled stdev
- corroboration: `W_on / W_off <= 1.1` (ON not just writing less code)

| problem | precondition | fairness | margin | corroboration | WIN |
| --- | --- | --- | --- | --- | --- |
| v5-grounded | PASS | PASS | FAIL | PASS | NO-WIN |

Guard inputs per problem:

- **v5-grounded**: W_on=309 W_off=332 (ratio 0.930); H_on=9,719 H_off=7,444 (2×W_off=664); solve ON=1.000 OFF=1.000; C=14,714; METRIC=-26,086.

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
