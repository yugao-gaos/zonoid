# Headless bench report

Generated 2026-06-09T15:22:48.251Z from `bench/results.jsonl` (12 result lines).

Token figures are **mean ± sample stdev** over solved trials. GROSS = all `message.usage` in the
transcript; PLUMBING = usage on messages tagged `attributionMcpServer:"orchestrator-graph"`; NET = GROSS - PLUMBING.

Model: **opus** (both arms, all trials). n = 3 trials per (problem, arm). 0 dropped, 0 contaminated.

## Headline verdict — total overhead (gross) AND net work

Two distinct overhead measures matter:

- **TOTAL overhead = gross ON − gross OFF.** This is the *whole* cost of having the orchestrator-graph
  MCP available: the always-resident tool-schema tax (loaded into context every turn) **plus** any
  tool-call plumbing. This is the headline number — NET does not capture the schema tax.
- **NET = gross − plumbing** isolates "work-only" tokens by removing orchestrator `tool_use`/`tool_result`
  round-trips.

**Key finding: plumbing was 0 on every ON run.** The ON-arm preamble grants the graph read-only and says
the agent *may* consult it; on these self-contained specs opus chose **not to call any orchestrator tool**.
So on this benchmark NET ≡ GROSS for every cell, and the entire ON−OFF gross delta is the resident schema
tax + run-to-run variance — there is no tool-call plumbing component to subtract.

| problem | gross OFF (mean±sd) | gross ON (mean±sd) | TOTAL overhead Δ | overhead % | net OFF | net ON | plumbing ON |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| context-rich | 352,877 ± 744 | 343,232 ± 31,068 | **−9,645** | **−2.7%** | 352,877 ± 744 | 343,232 ± 31,068 | 0 |
| greenfield | 252,558 ± 66,767 | 267,039 ± 128,606 | **+14,481** | **+5.7%** | 252,558 ± 66,767 | 267,039 ± 128,606 | 0 |

**Did context-rich's context use offset the overhead vs greenfield?** Effectively yes, on the means —
but inside the noise. context-rich ON came in 2.7% *below* OFF (a tight cell: OFF sd = 0.2%, ON sd = 9%),
consistent with the orchestrator context being mildly cost-neutral-to-helpful when prior knowledge is
relevant. greenfield ON ran 5.7% *above* OFF, the direction you'd expect from pure schema tax with no
context to amortize it against — but greenfield variance is enormous (ON sd ≈ 48% of mean), so this delta
is **not statistically distinguishable from zero**. Bottom line: with opus on these specs the
orchestrator MCP imposes a **small single-digit-percent overhead at most**, and on the context-rich
problem the available prior context appears to **offset even that**, whereas greenfield (no useful prior
context) shows the bare overhead direction. Net work did **not** drop in either arm (plumbing = 0).

## Per problem × arm

| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| context-rich | off | 3 | 352,877 ± 744 | 352,877 ± 744 | 0 ± 0 | 37,891 ± 1,813 |
| context-rich | on | 3 | 343,232 ± 31,068 | 343,232 ± 31,068 | 0 ± 0 | 38,646 ± 3,033 |
| greenfield | off | 3 | 252,558 ± 66,767 | 252,558 ± 66,767 | 0 ± 0 | 41,050 ± 11,382 |
| greenfield | on | 3 | 267,039 ± 128,606 | 267,039 ± 128,606 | 0 ± 0 | 40,631 ± 15,759 |

## Headline ratios (ON vs OFF, per problem)

Ratio of arm-ON mean over arm-OFF mean. <1.0× means the orchestrator arm used fewer tokens.

| problem | net ON/OFF | gross ON/OFF |
| --- | ---: | ---: |
| context-rich | 0.973× | 0.973× |
| greenfield | 1.057× | 1.057× |

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
