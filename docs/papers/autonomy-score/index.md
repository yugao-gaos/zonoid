# Measuring Autonomous Leverage: Autonomy Score and Productive Token %

**Zonoid self-learning loop · Case study 002 · June 2026**

> **Observed values (2026-06-11):** Autonomy score **103.5×** — 103.5 productive output tokens per human-typed input token. Productive token %: **92%** (16.1M of 17.5M total tokens flowed to merged work). These numbers describe one session on one project; external validity is unknown.

---

## Abstract

We introduce two metrics for quantifying the autonomous leverage of a coding-agent orchestrator: **Autonomy Score** (productive output tokens per human-typed input token) and **Productive Token %** (fraction of total tokens that flowed to merged work). We describe their implementations in Zonoid (`lib/human-input.js` and `lib/costflow.js`), explain the key engineering choices — a token cost-flow model over the task graph, and a conservative definition of "human input" that strips all machine-injected content. On a single session measured 2026-06-11 we observe an autonomy score of 103.5× and a productive % of 92%. We are honest about what these numbers do and do not imply: they are internal consistency metrics on a task graph, not direct measurements of real-world developer productivity, and the industry evidence on AI-assisted coding productivity is at best mixed and at worst negative for experienced developers.

---

## 1. Motivation

Token dashboards for AI coding tools typically report total spend and per-session cost. They do not answer the question a developer actually cares about: **for each token of human effort I put in, how many tokens of productive output did the system generate on my behalf?**

Two failure modes are invisible to raw token counts:

1. **Waste**: agents that consume tokens but produce work that never lands to git. High total spend, low productive output.
2. **Human overhead inflation**: systems that require extensive human steering — repeated corrections, clarification loops, copy-paste of generated context. High human input, moderate output.

Autonomy Score and Productive Token % are designed to surface both failure modes in a single session.

---

## 2. Metric Definitions

### 2.1 Autonomy Score

```
autonomy_score = productive_output_tokens ÷ human_typed_input_tokens
```

A score of 100× means the orchestrator generated 100 productive output tokens for every token the human typed. The metric is dimensionless and scale-independent — a session with 1M tokens and one with 100M tokens are directly comparable.

### 2.2 Productive Token %

```
productive_pct = productive_tokens / (productive + trapped + exploration) × 100
```

Total tokens are partitioned into three exhaustive, non-overlapping categories:

| Category | Definition |
|----------|-----------|
| **Productive** | Tokens in tasks whose work landed to git main (merged sinks) |
| **Exploration** | Tokens in terminal tasks explicitly tagged as exploration (dead-ends that were intentional) |
| **Trapped (waste)** | Tokens in terminal non-merged non-exploration tasks — work that went nowhere |

Conservation law: `productive + trapped + exploration = total` (exact, up to float rounding).

---

## 3. The Denominator Problem

"Human input tokens" is harder to define than it appears. A raw count of `role:user` message tokens includes:

- **Tool result payloads** — returned by `bash`, `read`, MCP calls. These are model outputs and system data, not human typing.
- **`<system-reminder>` blocks** — injected by the harness at every turn; can be 2,000–8,000 tokens each.
- **`<command-*>` and `<local-command-stdout>` blocks** — orchestrator router verdicts, slash command expansions.
- **Automated task notifications** — the daemon notifying the main session that a subagent completed.
- **Scheduled-task prompts and onboarding-harness prompts** — machine-generated, zero human authorship.
- **Judge candidate prompts** — the QA harness injects structured judge prompts that look like user messages.
- **`isSidechain` / `isMeta` messages** — internal harness traffic, never typed by a human.

`lib/human-input.js` parses main-session JSONL transcripts and strips all of the above. What remains is the actual human-typed text: commands, questions, corrections, and steering. Token count is estimated at `chars ÷ 3.8` (validated against a 2026-06-10 manual measurement of a known-length message).

The denominator is intentionally conservative: **if in doubt, exclude**. A falsely low denominator inflates the autonomy score and makes the system look better than it is. We prefer a metric that is hard to game by accident.

---

## 4. The Numerator: Cost-Flow Attribution

Productive output tokens are computed via a token cost-flow model over the workspace task graph (`lib/costflow.js`). The model is designed to answer: of the total tokens consumed this session, how many contributed to work that actually landed?

### 4.1 Token ownership

Every task node owns tokens proportional to its share of the session transcript, split by claim-window duration. If a task was active for 30% of the session wall-clock, it owns 30% of that session's tokens.

### 4.2 Sink and trap rules

- A **merged** node (work landed to git main) is a **productive sink** — it claims its accumulated tokens and passes 0 downstream. Its tokens count as productive.
- A **terminal non-merged** node **traps** its tokens. They count as waste (or exploration if tagged).
- Sessions with no task outputs get **catch-all nodes**; their cost flows to productive only if they steered merged work downstream via context edges.

### 4.3 Graph topology

Context edges in the task graph create dependencies between nodes. A merged node's productive status propagates upstream: tasks that produced context consumed by a merged node are credited as productive contributors.

Strongly connected components (cycles via context edges) are condensed into super-nodes using Tarjan's algorithm before flow runs in topological order. This prevents infinite flow loops in cyclic task graphs.

---

## 5. Observed Values

Measured 2026-06-11 on the Zonoid project:

| Metric | Value |
|--------|-------|
| Total session tokens | 17.5M |
| Productive tokens | 16.1M |
| Productive % | **92%** |
| Human-typed input tokens (estimated) | ~155,600 |
| Autonomy score | **103.5×** |

The 8% non-productive tokens are split between trapped waste (tasks that were started but abandoned or superseded) and exploration tasks. No large exploration-tagged sessions were present in this measurement window.

The autonomy score of 103.5× means the orchestrator generated roughly 103 productive output tokens for every token the human typed — steering, corrections, task definitions, and questions included.

---

## 6. Industry Context

These metrics exist in a vacuum: no vendor publishes autonomy score or productive token % as a named KPI, and there is no industry baseline to compare against. The broader landscape of AI coding productivity research offers important context:

**The METR RCT (July 2025):** The most methodologically rigorous study to date — a randomized controlled trial with 16 experienced software engineers working on 246 real tasks — found that AI tools made developers **19% slower** on average, while those same developers believed they were 20% faster (Kinniment et al., METR, 2025). The 39 percentage-point calibration error between perceived and actual performance is a significant warning about self-reported productivity studies.

**GitHub's controlled study:** GitHub's best-case controlled study found 55.8% faster completion on a single toy task (writing an HTTP server from scratch). Single-task benchmarks on isolated greenfield work are not representative of maintaining a complex existing codebase.

**Developer self-reports:** Surveys report 3.6–4 hours/week saved by AI tools, but the correlation between satisfaction scores and actual savings is only r=0.34 — satisfaction is a weak proxy for productivity (Stack Overflow Developer Survey, 2025).

**Token economics:** Agentic sessions have roughly a 25:1 input-to-output ratio (Vantage, 2026), meaning output tokens are the expensive minority. A high autonomy score reflects a large multiplier on this minority — but total cost still scales with the numerator.

The gap between Zonoid's 103.5× autonomy score and the METR finding of 19% slowdown is not a contradiction. Autonomy score measures token leverage within the system, not wall-clock developer productivity. A system could in principle generate many productive tokens while simultaneously increasing the human overhead of integration, review, and steering in ways not captured by either metric.

---

## 7. Limitations

**Single session, single project.** The 103.5× and 92% figures are from one measured session on the Zonoid project. The project is purpose-built to run coding agents; its task graph, merge rate, and human steering patterns are not representative of general software development.

**Cost-flow model assumptions.** Token ownership by claim-window duration is a proxy. In reality, a short high-leverage task may deserve more credit than a long exploratory one. The model does not distinguish token quality, only token volume.

**Human input estimation.** The `chars ÷ 3.8` estimate introduces noise. Short, high-entropy commands (e.g. `orch off`) are underweighted; long prose corrections are more accurately estimated.

**Productive ≠ correct.** Tokens that flow to a merged task are called productive. But merged work can still contain bugs, introduce regressions, or require immediate follow-up. The metric measures landing rate, not quality. Paper 001 (KB Injection Lifts Agent Solve Rate) addresses agent correctness separately.

**No causal claim on human productivity.** Autonomy score does not measure whether the developer shipped more, shipped faster, or shipped better software. It measures the token leverage ratio within the orchestrator. The METR RCT evidence suggests the mapping from token leverage to human productivity is nontrivial and potentially negative in some regimes.

**Exploration tagging is self-reported.** Whether a terminal task is classified as intentional exploration or waste depends on the task's tags in the graph. Miscategorized exploration inflates productive %, and miscategorized waste deflates it.

---

## References

- Kinniment et al., "Measuring the Impact of AI Coding Assistants on Experienced Developer Productivity," METR, July 2025.
- Vantage, "State of AI Cost," 2026 — agentic 25:1 input:output ratio finding.
- Stack Overflow Developer Survey, 2025 — self-reported hours saved, r=0.34 satisfaction correlation.
- GitHub, "The Impact of AI on Developer Productivity," 2023 — 55.8% faster on HTTP server task.
