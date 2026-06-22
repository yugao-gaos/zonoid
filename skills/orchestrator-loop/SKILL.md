---
name: orchestrator-loop
description: Run or reason about the Zonoid orchestrator loop, including heartbeat ticks, ready-task dispatch, parallel work decomposition, judge drains, planning and optimization actions, and request-loop wakeups. Use when driving the task graph forward across turns or coordinating subagents.
---

# Orchestrator Loop

Use the daemon as the source of scheduling truth. Keep each loop tick cheap, dispatch work through
graph tasks, and reschedule only when active work remains.

Read the relevant reference before acting:

- [heartbeat.md](references/heartbeat.md) for `next_action`, wakeup scheduling, task spawning,
  judge drains, and plan/optimize loop actions.
- [parallel-dispatch.md](references/parallel-dispatch.md) for decomposing parallelizable work,
  typed handoff envelopes, feature branches, and worker contracts.

Always surface the dashboard during orchestrator work:

`http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>`
