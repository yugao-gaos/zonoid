# Headless bench report

Generated 2026-06-10T04:17:10.222Z from `bench/results-v7.jsonl` (55 result lines).

Token figures are **mean ± sample stdev** over solved trials. GROSS = all `message.usage` in the
transcript; PLUMBING = usage on messages tagged `attributionMcpServer:"orchestrator-graph"`; NET = GROSS - PLUMBING.

## Per problem × arm — Raw tokens

Every token counted equally (cache reads at face value). This OVERSTATES dollar cost.

| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| v1-dagrag | off | 4 | 287,171 ± 57,953 | 287,171 ± 57,953 | 0 ± 0 | 50,748 ± 8,127 |
| v1-dagrag | on | 4 | 640,881 ± 167,019 | 149,415 ± 13,341 | 491,466 ± 171,512 | 84,771 ± 15,104 |
| v1-lean | off | 4 | 287,171 ± 57,953 | 287,171 ± 57,953 | 0 ± 0 | 50,748 ± 8,127 |
| v1-lean | on | 4 | 369,609 ± 74,489 | 102,078 ± 4 | 267,531 ± 74,485 | 60,872 ± 16,926 |
| v1-off | off | 4 | 287,171 ± 57,953 | 287,171 ± 57,953 | 0 ± 0 | 50,748 ± 8,127 |
| v1-search | off | 4 | 287,171 ± 57,953 | 287,171 ± 57,953 | 0 ± 0 | 50,748 ± 8,127 |
| v1-search | on | 4 | 417,072 ± 69,809 | 142,009 ± 26,623 | 275,063 ± 64,066 | 59,878 ± 5,314 |
| v4-dagrag | off | 4 | 202,824 ± 56,351 | 202,824 ± 56,351 | 0 ± 0 | 66,209 ± 12,748 |
| v4-dagrag | on | 4 | 454,152 ± 29,812 | 195,382 ± 32,728 | 258,770 ± 29,980 | 128,775 ± 27,229 |
| v4-lean | off | 4 | 202,824 ± 56,351 | 202,824 ± 56,351 | 0 ± 0 | 66,209 ± 12,748 |
| v4-lean | on | 3 | 309,917 ± 53,426 | 82,249 ± 0 | 227,668 ± 53,426 | 92,784 ± 31,034 |
| v4-off | off | 4 | 202,824 ± 56,351 | 202,824 ± 56,351 | 0 ± 0 | 66,209 ± 12,748 |
| v4-search | off | 4 | 202,824 ± 56,351 | 202,824 ± 56,351 | 0 ± 0 | 66,209 ± 12,748 |
| v4-search | on | 4 | 330,122 ± 38,673 | 89,169 ± 13,677 | 240,954 ± 27,896 | 83,459 ± 11,272 |

## Per problem × arm — Cost-weighted (tok-equivalents)

Input-token-equivalents: input×1, output×5, cache_read×0.1, cache_creation×1.25. Weights are **approximate** and model-dependent.

| problem | arm | n | cost gross (tok-eq) | cost net (tok-eq) |
| --- | --- | ---: | ---: | ---: |
| v1-dagrag | off | 4 | 116,346 ± 22,401 | 116,346 ± 22,401 |
| v1-dagrag | on | 4 | 235,817 ± 38,320 | 78,177 ± 10,008 |
| v1-lean | off | 4 | 116,346 ± 22,401 | 116,346 ± 22,401 |
| v1-lean | on | 4 | 125,550 ± 32,336 | 53,027 ± 16 |
| v1-off | off | 4 | 116,346 ± 22,401 | 116,346 ± 22,401 |
| v1-search | off | 4 | 116,346 ± 22,401 | 116,346 ± 22,401 |
| v1-search | on | 4 | 168,760 ± 40,665 | 76,776 ± 15,841 |
| v4-dagrag | off | 4 | 143,962 ± 28,178 | 143,962 ± 28,178 |
| v4-dagrag | on | 4 | 294,061 ± 39,807 | 107,763 ± 8,826 |
| v4-lean | off | 4 | 143,962 ± 28,178 | 143,962 ± 28,178 |
| v4-lean | on | 3 | 181,406 ± 48,652 | 46,801 ± 0 |
| v4-off | off | 4 | 143,962 ± 28,178 | 143,962 ± 28,178 |
| v4-search | off | 4 | 143,962 ± 28,178 | 143,962 ± 28,178 |
| v4-search | on | 4 | 171,848 ± 17,075 | 50,897 ± 7,805 |

## Headline ratios (ON vs OFF, per problem)

Ratio of arm-ON mean over arm-OFF mean. <1.0× means the orchestrator arm used fewer tokens.

Raw columns weight every token equally; cost-weighted columns use the tok-equivalent weights above
(input/output/cache_read/cache_creation) and are **approximate**.

| problem | net ON/OFF (raw) | gross ON/OFF (raw) | cost net ON/OFF | cost gross ON/OFF |
| --- | ---: | ---: | ---: | ---: |
| v1-dagrag | 0.520× | 2.232× | 0.672× | 2.027× |
| v1-lean | 0.355× | 1.287× | 0.456× | 1.079× |
| v1-off | n/a | n/a | n/a | n/a |
| v1-search | 0.495× | 1.452× | 0.660× | 1.451× |
| v4-dagrag | 0.963× | 2.239× | 0.749× | 2.043× |
| v4-lean | 0.406× | 1.528× | 0.325× | 1.260× |
| v4-off | n/a | n/a | n/a | n/a |
| v4-search | 0.440× | 1.628× | 0.354× | 1.194× |

## v4 decomposition (W / H / C)

Decomposes spend into **Real-Work** `W` (= `diffTokens`, the final solution size), **Hardness**
`H = max(0, total_output — W)` (output beyond the artifact), and **Consult-overhead** `C`
(extra cache cost the ON arm carries to hold graph context). Means are over solved trials.

| problem | arm | n | W (tok) | total_output (tok) | H (tok) | explorers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| v1-dagrag | off | 4 | 1,399 ± 27 | 7,730 ± 2,675 | 6,332 ± 2,655 | 5 ± 1 |
| v1-dagrag | on | 4 | 1,444 ± 53 | 15,645 ± 4,233 | 14,202 ± 4,189 | 6 ± 2 |
| v1-lean | off | 4 | 1,399 ± 27 | 7,730 ± 2,675 | 6,332 ± 2,655 | 5 ± 1 |
| v1-lean | on | 4 | 1,357 ± 46 | 7,638 ± 4,519 | 6,282 ± 4,482 | 5 ± 1 |
| v1-off | off | 4 | 1,399 ± 27 | 7,730 ± 2,675 | 6,332 ± 2,655 | 5 ± 1 |
| v1-search | off | 4 | 1,399 ± 27 | 7,730 ± 2,675 | 6,332 ± 2,655 | 5 ± 1 |
| v1-search | on | 4 | 1,371 ± 38 | 10,874 ± 4,800 | 9,503 ± 4,805 | 5 ± 1 |
| v4-dagrag | off | 4 | 397 ± 28 | 14,981 ± 3,064 | 14,584 ± 3,073 | 3 ± 1 |
| v4-dagrag | on | 4 | 417 ± 31 | 29,444 ± 6,978 | 29,027 ± 6,992 | 3 ± 1 |
| v4-lean | off | 4 | 397 ± 28 | 14,981 ± 3,064 | 14,584 ± 3,073 | 3 ± 1 |
| v4-lean | on | 3 | 380 ± 21 | 20,349 ± 7,400 | 19,969 ± 7,381 | 3 ± 1 |
| v4-off | off | 4 | 397 ± 28 | 14,981 ± 3,064 | 14,584 ± 3,073 | 3 ± 1 |
| v4-search | off | 4 | 397 ± 28 | 14,981 ± 3,064 | 14,584 ± 3,073 | 3 ± 1 |
| v4-search | on | 4 | 404 ± 30 | 16,677 ± 2,252 | 16,274 ± 2,255 | 3 ± 0 |

`C = costCache(ON) — costCache(OFF)` where `costCache = cache_read×0.1 + cache_creation×1.25`. `METRIC = (H_off — H_on)×5 — C` (hardness savings cost-weighted by the output weight, minus consult overhead).

| problem | C (tok-eq) | METRIC (tok-eq) | pooled stdev (n) |
| --- | ---: | ---: | ---: |
| v1-dagrag | 80,514 | -119,865 | 26,571 (n=8) |
| v1-lean | 8,122 | -7,872 | 17,051 (n=8) |
| v1-off | n/a (missing arm) | n/a | n/a |
| v1-search | 34,319 | -50,176 | 19,869 (n=8) |
| v4-dagrag | 75,558 | -147,774 | 45,990 (n=8) |
| v4-lean | 11,649 | -38,574 | 27,913 (n=7) |
| v4-off | n/a (missing arm) | n/a | n/a |
| v4-search | 19,652 | -28,100 | 13,268 (n=8) |

**Win evaluation** (all four guards must PASS for a WIN):

- precondition: `H_off >= 2×W_off` (hardness must dominate raw work)
- fairness: both-arm solve-rate >= 0.8
- margin: `METRIC > 0` AND gap > 1 pooled stdev
- corroboration: `W_on / W_off <= 1.1` (ON not just writing less code)

| problem | precondition | fairness | margin | corroboration | WIN |
| --- | --- | --- | --- | --- | --- |
| v1-dagrag | PASS | PASS | FAIL | PASS | NO-WIN |
| v1-lean | PASS | PASS | FAIL | PASS | NO-WIN |
| v1-off | — | — | — | — | NO-WIN (missing arm) |
| v1-search | PASS | PASS | FAIL | PASS | NO-WIN |
| v4-dagrag | PASS | PASS | FAIL | PASS | NO-WIN |
| v4-lean | PASS | PASS | FAIL | PASS | NO-WIN |
| v4-off | — | — | — | — | NO-WIN (missing arm) |
| v4-search | PASS | PASS | FAIL | PASS | NO-WIN |

Guard inputs per problem:

- **v1-dagrag**: W_on=1,444 W_off=1,399 (ratio 1.032); H_on=14,202 H_off=6,332 (2×W_off=2,798); solve ON=1.000 OFF=1.000; C=80,514; METRIC=-119,865.
- **v1-lean**: W_on=1,357 W_off=1,399 (ratio 0.970); H_on=6,282 H_off=6,332 (2×W_off=2,798); solve ON=1.000 OFF=1.000; C=8,122; METRIC=-7,872.
- **v1-search**: W_on=1,371 W_off=1,399 (ratio 0.980); H_on=9,503 H_off=6,332 (2×W_off=2,798); solve ON=1.000 OFF=1.000; C=34,319; METRIC=-50,176.
- **v4-dagrag**: W_on=417 W_off=397 (ratio 1.050); H_on=29,027 H_off=14,584 (2×W_off=795); solve ON=1.000 OFF=1.000; C=75,558; METRIC=-147,774.
- **v4-lean**: W_on=380 W_off=397 (ratio 0.957); H_on=19,969 H_off=14,584 (2×W_off=795); solve ON=1.000 OFF=1.000; C=11,649; METRIC=-38,574.
- **v4-search**: W_on=404 W_off=397 (ratio 1.016); H_on=16,274 H_off=14,584 (2×W_off=795); solve ON=1.000 OFF=1.000; C=19,652; METRIC=-28,100.

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
