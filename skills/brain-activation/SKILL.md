---
name: brain-activation
description: Use when an agent needs to decide what to do next, propose graph tasks, activate autonomous daemon planning, handle plan/optimize loop actions, inspect the living product shape, or turn candidate directions into measured self-learning experiments.
---

# Brain Activation

Use daemon-provided graph, search, learning, and task-detail tools to choose the next concrete move.
Do not implement retrieval or invent speculative work.

Read the relevant reference before acting:

- [activation-workflow.md](references/activation-workflow.md) for product-shape reads, candidate
  generation, evidence checks, and metric framing.
- [daemon-plan-optimize.md](references/daemon-plan-optimize.md) when the loop returns `plan` or
  `optimize`, or when an older prompt invokes `self-learn-planner`.

Output concrete recommendations or graph actions with evidence, success criteria, and routing.
