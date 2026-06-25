# Headless bench report

Generated 2026-06-12T00:27:13.622Z from `/Users/imyu/Desktop/zonoid/bench/heldout/results-heldout.jsonl` (107 result lines).

Token figures are **mean ± sample stdev** over solved trials. GROSS = all `message.usage` in the
transcript; PLUMBING = usage on messages tagged `attributionMcpServer:"orchestrator-graph"`; NET = GROSS - PLUMBING.

## Per problem × arm — Raw tokens

Every token counted equally (cache reads at face value). This OVERSTATES dollar cost.

| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| overlay-save | off | 7 | 4,344,190 ± 988,896 | 4,344,190 ± 988,896 | 0 ± 0 | 366,428 ± 97,097 |
| overlay-save | on | 9 | 3,700,733 ± 1,013,303 | 105,159 ± 29,544 | 3,595,575 ± 1,032,026 | 385,433 ± 98,479 |
| task-transcript | on | 2 | 584,400 ± 4,052 | 101,574 ± 20,814 | 482,826 ± 16,762 | 96,141 ± 37,388 |

## Per problem × arm — Cost-weighted (tok-equivalents)

Input-token-equivalents: input×1, output×5, cache_read×0.1, cache_creation×1.25. Weights are **approximate** and model-dependent.

| problem | arm | n | cost gross (tok-eq) | cost net (tok-eq) |
| --- | --- | ---: | ---: | ---: |
| overlay-save | off | 7 | 1,160,586 ± 213,902 | 1,160,586 ± 213,902 |
| overlay-save | on | 9 | 987,497 ± 216,290 | 63,943 ± 20,121 |
| task-transcript | on | 2 | 230,628 ± 40,239 | 70,727 ± 14 |

## Headline ratios (ON vs OFF, per problem)

Ratio of arm-ON mean over arm-OFF mean. <1.0× means the orchestrator arm used fewer tokens.

Raw columns weight every token equally; cost-weighted columns use the tok-equivalent weights above
(input/output/cache_read/cache_creation) and are **approximate**.

| problem | net ON/OFF (raw) | gross ON/OFF (raw) | cost net ON/OFF | cost gross ON/OFF |
| --- | ---: | ---: | ---: | ---: |
| overlay-save | 0.024× | 0.852× | 0.055× | 0.851× |
| task-transcript | n/a | n/a | n/a | n/a |

## v4 decomposition (W / H / C)

Decomposes spend into **Real-Work** `W` (= `diffTokens`, the final solution size), **Hardness**
`H = max(0, total_output — W)` (output beyond the artifact), and **Consult-overhead** `C`
(extra cache cost the ON arm carries to hold graph context). Means are over solved trials.

| problem | arm | n | W (tok) | total_output (tok) | H (tok) | explorers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| overlay-save | off | 7 | 9,319 ± 76 | 71,095 ± 17,327 | 61,776 ± 17,341 | 20 ± 4 |
| overlay-save | on | 9 | 9,289 ± 73 | 77,202 ± 21,783 | 67,913 ± 21,729 | 19 ± 5 |
| task-transcript | on | 2 | 671 ± 128 | 16,209 ± 6,305 | 15,539 ± 6,177 | 3 ± 0 |

`C = costCache(ON) — costCache(OFF)` where `costCache = cache_read×0.1 + cache_creation×1.25`. `METRIC = (H_off — H_on)×5 — C` (hardness savings cost-weighted by the output weight, minus consult overhead).

| problem | C (tok-eq) | METRIC (tok-eq) | pooled stdev (n) |
| --- | ---: | ---: | ---: |
| overlay-save | -202,631 | 171,949 | 97,721 (n=16) |
| task-transcript | n/a (missing arm) | n/a | n/a |

**Win evaluation** (all four guards must PASS for a WIN):

- precondition: `H_off >= 2×W_off` (hardness must dominate raw work)
- fairness: both-arm solve-rate >= 0.8
- margin: `METRIC > 0` AND gap > 1 pooled stdev
- corroboration: `W_on / W_off <= 1.1` (ON not just writing less code)

| problem | precondition | fairness | margin | corroboration | WIN |
| --- | --- | --- | --- | --- | --- |
| overlay-save | PASS | FAIL | PASS | PASS | NO-WIN |
| task-transcript | — | — | — | — | NO-WIN (missing arm) |

Guard inputs per problem:

- **overlay-save**: W_on=9,289 W_off=9,319 (ratio 0.997); H_on=67,913 H_off=61,776 (2×W_off=18,638); solve ON=0.818 OFF=0.636; C=-202,631; METRIC=171,949.

## Solve rates (all candidates)

Solve rate per candidate × arm across all trials (including those without transcripts).

| problem | arm | solved | total | rate |
| --- | --- | ---: | ---: | ---: |
| bench-metric | OFF | 2 | 2 | 1.000 |
| bench-metric | ON | 2 | 2 | 1.000 |
| locale-sum | OFF | 5 | 10 | 0.500 |
| locale-sum | ON | 13 | 18 | 0.722 |
| overlay-save | OFF | 7 | 11 | 0.636 |
| overlay-save | ON | 9 | 11 | 0.818 |
| task-transcript | OFF | 0 | 20 | 0.000 |
| task-transcript | ON | 9 | 33 | 0.273 |

## Contamination & drop notes

No contamination: every OFF-arm run had zero `orchestrator-graph` attribution.

**Dropped from aggregates (solved===false):**

- overlay-save / off / trial 34 (solved===false)
- overlay-save / on / trial 35 (solved===false)
- overlay-save / off / trial 36 (solved===false)
- overlay-save / on / trial 36 (solved===false)
- overlay-save / off / trial 37 (solved===false)
- overlay-save / off / trial 38 (solved===false)
- task-transcript / on / trial 41 (solved===false)
- task-transcript / on / trial 42 (solved===false)
- task-transcript / on / trial 43 (solved===false)

**Unreadable transcripts (excluded entirely):**

- task-transcript / off / trial 0: <redacted> (ENOENT)
- task-transcript / off / trial 1: <redacted> (ENOENT)
- task-transcript / off / trial 2: <redacted> (ENOENT)
- task-transcript / off / trial 3: <redacted> (ENOENT)
- task-transcript / off / trial 4: <redacted> (ENOENT)
- task-transcript / on / trial 0: <redacted> (ENOENT)
- task-transcript / on / trial 1: <redacted> (ENOENT)
- task-transcript / on / trial 2: <redacted> (ENOENT)
- task-transcript / on / trial 3: <redacted> (ENOENT)
- task-transcript / on / trial 4: <redacted> (ENOENT)
- task-transcript / on / trial 5: <redacted> (ENOENT)
- task-transcript / on / trial 6: <redacted> (ENOENT)
- task-transcript / on / trial 7: <redacted> (ENOENT)
- task-transcript / off / trial 5: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 6: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 7: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 8: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 9: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 10: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 11: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 12: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 13: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 14: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 15: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 16: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 17: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 18: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / off / trial 19: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 3: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 4: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 5: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 6: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 7: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 8: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 9: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 10: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 11: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 12: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 13: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 14: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 15: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 16: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 17: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 18: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 19: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 0: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 1: undefined (ERR_INVALID_ARG_TYPE)
- task-transcript / on / trial 2: undefined (ERR_INVALID_ARG_TYPE)
- bench-metric / off / trial 0: undefined (ERR_INVALID_ARG_TYPE)
- bench-metric / off / trial 1: undefined (ERR_INVALID_ARG_TYPE)
- bench-metric / on / trial 0: undefined (ERR_INVALID_ARG_TYPE)
- bench-metric / on / trial 1: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 0: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 1: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 2: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 20: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 21: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 22: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 23: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 24: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 3: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / off / trial 4: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 0: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 1: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 10: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 11: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 12: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 3: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 4: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 5: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 6: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 7: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 8: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 9: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 0: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 1: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 2: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 3: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 4: undefined (ERR_INVALID_ARG_TYPE)
- locale-sum / on / trial 99: undefined (ERR_INVALID_ARG_TYPE)

## Known limitation

MCP tool **schema** tokens loaded into context (counted under `cache_creation_input_tokens` /
`cache_read_input_tokens` when the system prompt + tool list are cached) are amortized across the
whole session and are **not attributable to individual messages**. PLUMBING therefore captures the
orchestrator `tool_use` / `tool_result` round-trips but **under-counts the always-resident schema
overhead** of having the orchestrator-graph MCP server loaded. Treat NET as an upper bound on the
"work-only" token cost and PLUMBING as a lower bound on the true orchestration overhead.
