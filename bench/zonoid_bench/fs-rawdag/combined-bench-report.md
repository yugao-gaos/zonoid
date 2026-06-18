# Zonoid Combined ON-vs-OFF Cost-Bounded Bench

_Combined ON-vs-OFF cost-bounded agentic bench (canonical, note-mqjmq2cbdy3)._
_ON-config: raw-dag_

- **ON arm** (raw-dag): production-faithful memory retrieval (mint probe TASK -> autowire NOTE->probe context_deps at cosine>=0.55 -> eager-judge keep/prune -> frozen /task/context (= get_dependency_summaries) + RAG fill = search_knowledge tiered). Token CEILING 500000 weighted tok-eq = runaway guard ONLY, not a target.
- **OFF arm**: pure agentic, clean env (no MCP/KB/.graph/ORCH_*). Budget cap = ON's ACTUAL spend on that problem, enforced post-hoc.
- **Cost**: input + output*5 + cache_read*0.1 + cache_creation*1.25 (scripts/bench-economy.js formula).
- **Grader**: validated LLM-judge (LoCoMo/LongMemEval rubric). Gold answers never enter any retrieve/answer step.

## Overall

| Metric | Value |
| --- | --- |
| n problems | 8 |
| ON accuracy | 100.0% |
| OFF accuracy (unbounded) | 12.5% |
| OFF-within-budget rate | 12.5% |
| **Memory-win count** | **7** (87.5%) |
| ON mean cost (weighted tok-eq) | 8366 |
| OFF mean cost (weighted tok-eq) | 14406 |
| ON over-ceiling count | 0 |

## Per-category breakdown

_Self-reveals contamination: cold-solvable categories (config, invariant) show OFF matching ON cheaply (low memory-win); decision/gotcha show OFF failing within ON's budget (high memory-win)._

| Category | n | ON acc | OFF acc | OFF-in-budget | Memory wins | ON cost | OFF cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gotcha | 8 | 100.0% | 12.5% | 12.5% | 7 (87.5%) | 8366 | 14406 |
