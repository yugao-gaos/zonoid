---
name: orch-loop
description: Run the orchestrator heartbeat — periodically ask the daemon what to do and advance the task graph, with hard token controls. Use to auto-progress a DAG across turns (spawn ready tasks as dependencies complete) without an always-on event loop. Stops automatically when the graph drains or the budget is hit.
---

# Orchestrator heartbeat

Drives the task graph forward on a self-paced schedule. The **daemon decides**; you just
execute and re-schedule. Keep each tick cheap.

## Start
1. (Optional) set token controls: `mcp__orchestrator-graph__loop_start({ tokenBudget, maxIterations, minPoll, maxPoll, batch, session })`. Defaults: 100k tokens / 200 ticks / 30s–1200s poll / 8 per batch. These are HARD caps enforced by the daemon. Pass `session` = this conversation's id so a cooperative-stop on its claimed task halts the loop within one tick (see Cooperative stop).
2. Then run one tick (below) and schedule the next with `ScheduleWakeup`.

## Each tick (keep it minimal — conserve tokens)
1. Call `mcp__orchestrator-graph__next_action`.
2. Act on the result:
   - **`stop`** → the loop is over (DAG drained, budget hit, or stopped). Do NOT reschedule. Report the reason briefly.
   - **`idle`** → do nothing else. Reply just "idle" and schedule the next tick in `next_poll_seconds`.
   - **`spawn`** → for each task in `tasks`, start it: pass its `key` as `TASK_ID` to a subagent (via the Workflow tool / parallel-orchestrate, or an Agent Team), and call `start_task(key, agent_id)`. When each finishes, the subagent calls `complete_task(key, summary)`. Then schedule the next tick in `next_poll_seconds`.
   - **`plan`** → the DAG drained and self-planning is on (`self_plan`). This is the self-learning tick that closes the loop: invoke the **`self-learn-planner`** skill. It reads the accumulated learnings (`get_learnings` — judge verdicts, failures, recent completions), proposes 1-3 parallelism-maximizing initiatives and wires them in (structuring "try alternatives" as a **problem → attempts → judge** subtree per the **`self-learn-judge`** skill, so the judge's verdict is recorded back as durable learning for the next run), and calls `request_guidance` on any decision the user must make. If it proposes nothing, it reports no-action. Then schedule the next tick — the newly-added tasks become `spawn`able on the following heartbeat.
3. Reschedule with `ScheduleWakeup(next_poll_seconds)` carrying this same heartbeat prompt — UNLESS action was `stop`.

## Cooperative stop (in-process self-exit)
The heartbeat tick runs **in-process**, so the PreToolUse cooperative-stop hook can't interrupt it.
The daemon enforces the stop for you instead: every `next_action` tick first polls the loop's own
stop signal (a cancel on the loop session's claimed task, or a stop on its agent — same logic as
`GET /should-stop?session=<id>`). If set, the tick returns `action:'stop', reason:'cooperative stop'`
and clears `loop.active` — so the loop self-exits **within one iteration**, after finishing the
current step and persisting. Pass `session` to `loop_start` to arm this. Hard token/iteration caps in
`loop_start` are enforced the same way.

## Token discipline
- On an `idle` tick, do not reason or call other tools — the daemon already decided. One MCP call + a one-word reply.
- Trust the daemon's `next_poll_seconds`: it backs off to long intervals when idle/waiting and short when work is flowing.
- `loop_stop` cancels the loop anytime; `orch off` (the conversation toggle) also ends it. An `await_user` action means the planner/judge raised a `request_guidance` question — the loop is halted until the user answers (`/guidance/resolve`).
