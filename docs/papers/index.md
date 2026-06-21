# Zonoid Research Papers

Empirical studies behind Zonoid's agent-subconscious layer: project-local context activation,
task-graph cost flow, and self-learning.

> **Scope — what these papers measure.** These are **component** studies of **KB injection (RAG
> retrieval)**: the ON arm makes a single gated `search_knowledge` call into one task's context, the
> OFF arm makes none. They measure whether injecting a relevant project-local note lifts solve rate
> on an *isolated* task. They do **not** measure Zonoid as a whole — DAG context flow across wired
> tasks, multi-task orchestration, the task graph, or the autonomous loop are not exercised here. So
> the lifts below are evidence for the **retrieval/gate mechanism**, not a whole-product ON-vs-OFF
> result. Whole-product evaluation (full orchestrator vs plain agent, on context-required
> interdependent tasks) is a separate effort — see [swe-bench-eval](../swe-bench-eval.md) and the
> product end-to-end bench.

---

## Published

| Paper | Result | Date |
|-------|--------|------|
| [KB Injection Lifts Agent Solve Rate](quality-gain/) | OFF 50% → ON 80% on held-out benchmark (n=20 each arm, +30pp) | June 2026 |
| [Measuring Autonomous Leverage: Autonomy Score and Productive Token %](autonomy-score/) | Strict (git-verified, output-only): 72× autonomy, 75.4% productive; lenient self-report gave 103.5×/92% | June 2026 |
| [Whole-Product Token Economy: Orchestrator ON vs OFF on Context-Required Tasks](token-economy/) | ON 7.5× cheaper + solved (27/27), OFF failed within budget — whole-product result | June 2026 |

---

## Methodology

Each paper follows the same held-out bench protocol:

1. **Prose spec only** — agent sees the task description, no tests, no rubric
2. **External grading** — held-out test suite run after the agent finishes, never visible to the agent
3. **Oracle isolation** — grader files stripped from solve worktree before agent runs
4. **Clean arms** — OFF arm has no MCP; ON arm gets one gated `search_knowledge` call
5. **Post-fix data only** — all results from after infra fixes (vec persistence, supersede persistence)
