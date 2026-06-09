# Headless bench report

Generated 2026-06-09T17:01:54.834Z from `bench/results-v2.jsonl` (10 result lines).

Token figures are **mean ± sample stdev** over solved trials. GROSS = all `message.usage` in the
transcript; PLUMBING = usage on messages tagged `attributionMcpServer:"orchestrator-graph"`; NET = GROSS - PLUMBING.

## Per problem × arm

| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| graph-dependent | off | 5 | 325,550 ± 36,792 | 325,550 ± 36,792 | 0 ± 0 | 62,487 ± 9,776 |
| graph-dependent | on | 5 | 555,825 ± 124,588 | 101,710 ± 18,164 | 454,115 ± 111,665 | 75,621 ± 10,701 |

## Headline ratios (ON vs OFF, per problem)

Ratio of arm-ON mean over arm-OFF mean. <1.0× means the orchestrator arm used fewer tokens.

| problem | net ON/OFF | gross ON/OFF |
| --- | ---: | ---: |
| graph-dependent | 0.312× | 1.707× |

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
