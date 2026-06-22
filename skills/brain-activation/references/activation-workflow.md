
# Brain Activation

## Purpose

Activate deliberation over the living work graph. Use daemon-provided RAG, DAG, task-detail, and graph-frontier tools to infer the current product shape, then propose the next highest-leverage work that either follows that shape or improves it.

This skill is agent-neutral. Any agent with access to the daemon graph/search tools can use the protocol.

## Boundary

- Do not implement search, embeddings, graph traversal, or retrieval storage.
- Do not freeze product direction into a rigid system spec unless explicitly asked.
- Do not silently create speculative work from a plausible idea.
- Do use existing daemon search/detail/graph/task tools to gather evidence, debate options, define metrics, and recommend or route measured experiments.

## Activation Workflow

1. Establish the activation question.
   - Default: "What should happen next that best follows or improves the current product shape?"
   - If a narrower context exists, include it: feature area, repo path, current task, failed attempt, benchmark, or user goal.

2. Pull first-pass context from the daemon.
   - Search for current product definition, recent decisions, user preferences, known constraints, benchmark notes, and active graph frontier.
   - If operating inside a task and the daemon supports gated search, use the current task key so DAG context can inject first.
   - Include graph/frontier context when the question is about what to do next, not just what is known.

3. Check coverage before deciding.
   - Name what is known.
   - Name what is thin, stale, contradictory, or missing.
   - If the first pass does not cover the decision well, continue with multi-step search.

4. Iterate search when useful.
   - Reformulate queries around missing evidence, adjacent product areas, failed/blocked tasks, competitors, benchmarks, and implementation seams.
   - Fetch task details when search summaries are too thin.
   - Stop when new searches mostly repeat known evidence or no longer affect the candidate ranking.

5. Generate candidates.
   - Produce several concrete task ideas, normally 3-7.
   - Each candidate must cite the evidence pattern that produced it: notes, tasks, failures, gaps, or product-shape constraints.
   - Prefer tasks that are verifiable and small enough to enter the self-learning loop.

6. Debate candidates.
   - For each serious candidate, write the pro case, con case, missing evidence, and failure mode.
   - Ask whether it follows the current product shape, improves it, or risks drifting away from it.
   - Drop candidates that are mostly aesthetic, speculative, unmeasurable, or unsupported by graph evidence.

7. Define judging metrics before execution.
   - For top candidates, define the primary success metric.
   - Add guardrails for regressions, scope control, cost, latency, UX, or quality as appropriate.
   - Define the baseline or comparison: current behavior, prior task result, competing candidate, benchmark, or manual rubric.
   - Define how the result will be measured: command, test, review rubric, benchmark artifact, or observable graph outcome.

8. Route the outcome.
   - If the user asked only for ideas, return ranked recommendations.
   - If execution is authorized, create or recommend graph tasks with metric specs and success criteria.
   - When a candidate needs implementation, send it through the self-learning loop: attempt, measure, judge, merge/hold, and record learning.
   - If evidence is insufficient, recommend a research or measurement task instead of implementation.

## Candidate Scoring

Score each candidate 0-5 on:

- Product-shape fit: Does it reinforce or improve the current direction?
- Leverage: Would success unlock meaningful future work?
- Evidence strength: Is it grounded in graph/KB/task evidence?
- Verifiability: Can the self-learning loop judge it?
- Risk discipline: Is the blast radius acceptable and reversible?

Rank by the total score, but allow a lower total to win when it has much cleaner measurability or lower risk.

## Output Format

Return:

1. Current product-shape read: 2-5 bullets.
2. Search coverage: what was searched, what is still thin.
3. Candidate table: task idea, evidence, pro, con, score.
4. Top recommendation: why this should happen next.
5. Judging metrics: success metric, guardrails, baseline, measurement method.
6. Proposed graph action: create task, research first, hold, or no action.

Keep recommendations concrete enough that a cold agent can execute or evaluate them later.
