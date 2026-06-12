# Zonoid Research Papers

Empirical studies on the self-learning task knowledge graph.

---

## Published

| Paper | Result | Date |
|-------|--------|------|
| [KB Injection Lifts Agent Solve Rate](quality-gain/) | OFF 50% → ON 80% on held-out benchmark (n=20 each arm, +30pp) | June 2026 |
| [Measuring Autonomous Leverage: Autonomy Score and Productive Token %](autonomy-score/) | 103.5× autonomy, 92% productive on 2026-06-11 session; no industry baseline exists | June 2026 |

---

## Methodology

Each paper follows the same held-out bench protocol:

1. **Prose spec only** — agent sees the task description, no tests, no rubric
2. **External grading** — held-out test suite run after the agent finishes, never visible to the agent
3. **Oracle isolation** — grader files stripped from solve worktree before agent runs
4. **Clean arms** — OFF arm has no MCP; ON arm gets one gated `search_knowledge` call
5. **Post-fix data only** — all results from after infra fixes (vec persistence, supersede persistence)
