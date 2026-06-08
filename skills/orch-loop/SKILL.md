---
name: orch-loop
description: Run the orchestrator heartbeat — periodically ask the daemon what to do and advance the task graph, with hard token controls. Use to auto-progress a DAG across turns (spawn ready tasks as dependencies complete) without an always-on event loop. Stops automatically when the graph drains or the budget is hit.
---

# Orchestrator heartbeat

Drives the task graph forward on a self-paced schedule. The **daemon decides**; you just
execute and re-schedule. Keep each tick cheap.

## Start
1. (Optional) set token controls: `mcp__orchestrator-graph__loop_start({ tokenBudget, maxIterations, minPoll, maxPoll, batch })`. Defaults: 100k tokens / 200 ticks / 30s–1200s poll / 8 per batch. These are HARD caps enforced by the daemon.
2. Then run one tick (below) and schedule the next with `ScheduleWakeup`.

## Each tick (keep it minimal — conserve tokens)
1. Call `mcp__orchestrator-graph__next_action`.
2. Act on the result:
   - **`stop`** → the loop is over (DAG drained, budget hit, or stopped). Do NOT reschedule. Report the reason briefly.
   - **`idle`** → do nothing else. Reply just "idle" and schedule the next tick in `next_poll_seconds`.
   - **`spawn`** → for each task in `tasks`, start it: pass its `key` as `TASK_ID` to a subagent (via the Workflow tool / parallel-orchestrate, or an Agent Team), and call `start_task(key, agent_id)`. When each finishes, the subagent calls `complete_task(key, summary)`. Then schedule the next tick in `next_poll_seconds`.
3. Reschedule with `ScheduleWakeup(next_poll_seconds)` carrying this same heartbeat prompt — UNLESS action was `stop`.

## Token discipline
- On an `idle` tick, do not reason or call other tools — the daemon already decided. One MCP call + a one-word reply.
- Trust the daemon's `next_poll_seconds`: it backs off to long intervals when idle/waiting and short when work is flowing.
- `loop_stop` cancels the loop anytime; `orch off` (the conversation toggle) also ends it.
