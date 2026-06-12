---
name: orch-loop
description: Run the orchestrator heartbeat — periodically ask the daemon what to do and advance the task graph, with hard token controls. Use to auto-progress a DAG across turns (spawn ready tasks as dependencies complete) without an always-on event loop. Stops automatically when the graph drains or the budget is hit.
---

> **DEFAULT — autonomous code work is HELD, never merged.** Every code-producing task the loop
> spawns MUST: (1) do its work in an ISOLATED git branch + worktree off the CODE repo
> (`~/.claude/orchestrator`; branch `orch/attempt/<task-slug>`, e.g. `git worktree add -b orch/attempt/<slug> worktrees/self/<slug> HEAD`) — NEVER edit the live checkout and NEVER merge to `main`;
> (2) commit in that worktree; (3) `complete_task(key, "MERGE PENDING — <branch>: <what changed + test result>")` so the task reaches `done` (REQUIRED: a judge blocked by attempts only becomes `ready` when every attempt is `done`). Pass each worker its `TASK_ID` and these rules verbatim. Merging to `main` is a HUMAN decision on review — the loop never merges and never halts on guidance; it queues everything for the morning.


# Orchestrator heartbeat

Drives the task graph forward on a self-paced schedule. The **daemon decides**; you just
execute and re-schedule. Keep each tick cheap.

**ONE heartbeat drives the WHOLE loop registry.** The daemon keeps a KEYED registry of loops (each
its own budget/config/session). A single `next_action` call returns a **batched array** — one
decision per active loop — and you reschedule **ONE** `ScheduleWakeup` for all of them. Never run a
wakeup chain per loop.

## Start
1. (Optional) set token controls: `mcp__orchestrator-graph__loop_control({ action: "start", tokenBudget, maxIterations, minPoll, maxPoll, batch, maxConcurrency, judgeParallelCap, session })`. Defaults: 100k tokens / 200 ticks / 30s–1200s poll / 8 per batch / 10 max concurrency / 6 judge parallel cap. These are HARD caps enforced by the daemon. Pass `session` = this conversation's id so a cooperative-stop on its claimed task halts that loop within one tick (see Cooperative stop). **`loop_control(action:"start")` INSERTS a new loop and returns its `loopId`** — it never clobbers an existing loop, so several loops can run at once.
2. Then run one tick (below) and schedule the next with **one** `ScheduleWakeup`.

## Each tick (keep it minimal — conserve tokens)
1. Call `mcp__orchestrator-graph__next_action` **once**. It returns `{ loops: [ { loopId, action, tasks?, next_poll_seconds, ... } ] }` — one entry per ACTIVE loop (empty array ⇒ nothing active; do NOT reschedule).
2. **Fan out per `loopId`** — act on each entry independently:
   - **`stop`** → THAT loop is over (its DAG drained, its budget hit, or it was stopped/swept). Drop it from the rescheduling set.
   - **`idle`** → do nothing for that loop. Keep it in the rescheduling set.
   - **`spawn`** → for each task in that entry's `tasks`, start it: pass its `key` as `TASK_ID` to a subagent (via the Workflow tool / parallel-orchestrate, or an Agent Team), and call `start_task(key, agent_id)`. When each finishes successfully, the subagent calls `complete_task(key, summary)`. **On failure or error, the subagent MUST call `set_status(key, "failed", <one-line reason>)` before exiting** — silent exit leaves the task `in_progress` indefinitely; the staleness sweep is the last resort, not the primary path. If `start_task` returns **409** (already in_progress by another agent / claimed by another loop this tick), SKIP that task and let the next heartbeat re-poll — never force-takeover. Include in each worker's prompt the GATE-FIRST consult rule: before coding, call `search_knowledge(<task in one sentence>, gated:true)`; on `decision:"inject"` apply the returned note, on `"abstain"` proceed without retrieval (never re-query ungated). Report usage per `loopId`. **A `spawn` entry MAY also carry `judge:{parallel:K, budget:N}`** (CAPACITY-FILL — see below): when present, ALSO fan out K concurrent edge-judge efforts IN ADDITION to spawning the tasks. Tasks first, judge fills the remaining concurrency.
   - **`judge_edges`** → a **capacity-fill self-learning tick** (LOWER priority than `spawn` — the entry carries `parallel:K` and `budget:N`). Tasks always win: the daemon spawns ready tasks into the loop's spare concurrency (`headroom = maxConcurrency − running`) FIRST, then fans the edge-judge into the LEFTOVER slots — so `K = min(headroom − spawnedThisTick, judgeQueueDepth, judgeParallelCap)`, further clamped to what the loop's remaining token budget affords. A pure `judge_edges` entry means there were no ready tasks (or no headroom for them) this tick. **Fan out K CONCURRENT `self-learn-edge-judge` efforts** (not one), **each on model `sonnet`** (never haiku — verdict discrimination degrades to rubber-stamp keeps): run K parallel invocations, each doing `GET /judge/next?budget=N` → reason each item per that skill's conservative keep/prune/create/surface criteria (default verdict = NO edge) → `POST /judge/verdict`. Because the daemon is single-threaded, the K `GET /judge/next` calls advance the persisted cursor in series and return **DISJOINT slices** — no edge is judged twice. Each effort takes at most N items; the cursor resumes next tick. All K efforts count against the loop's normal token/iteration budget (the daemon already charged `spent` for all K and advanced `iterations`), so the loop still auto-stops at the cap. K ≤ `judgeParallelCap` (default 6). Keep it in the rescheduling set.
   - **Whenever a decision carries `judge:{parallel:K, budget:N}`** (on EITHER a `spawn` or a `judge_edges` action), fan out **K concurrent** `self-learn-edge-judge` efforts as just described, in addition to any task spawns. Tasks-first, judge fills the remainder, K ≤ `judgeParallelCap`, all under the loop's token budget.
   - **Whenever a decision carries `wire: [{key, label}]`** (on a `spawn`, `idle`, or `judge_edges` action): those tasks are READY but **unwired** — created with no edges and never wired in. The daemon will NEVER spawn them (a worker's `start_task` would 409), so YOU must wire each one before your next tick: call `suggest_links(key)` and add the right `add_dependency` (blocking/context) edges, or `mark_root(key)` ONLY if your judgment says it is genuinely a standalone root — never mark_root just to unblock. Once wired (or rooted) the unwired flag clears and the task becomes spawnable on the following heartbeat. Do NOT spawn a worker for a task listed in `wire[]`.
   - **`plan`** → that loop's DAG drained and self-planning is on (`self_plan`). Self-learning tick: invoke the **`self-learn-planner`** skill. It reads accumulated learnings (`get_learnings` — judge verdicts, failures, recent completions), proposes 1-3 parallelism-maximizing initiatives and wires them in (structuring "try alternatives" as a **problem → attempts → judge** subtree per the **`self-learn-judge`** skill, so the judge's verdict is recorded back as durable learning), and calls `request_guidance` on any decision the user must make. If it proposes nothing, it reports no-action. The new tasks become `spawn`able on the following heartbeat.
   - **`optimize`** → the daemon's converged-vs-iterate control (`decideOptimize`) decided that loop's just-judged metric problem should ITERATE again. The entry carries `problem` (the problem key `P`), `metric`, and `prior_verdict` (the last judge verdict). Invoke the **`self-learn-planner`** skill scoped to `P`: feed it `prior_verdict` (and `get_learnings`) and have it wire a NEW **attempts → judge** round on the SAME `P` proposing a **DIFFERENT** change (never a repeat of `prior_verdict.winner`). Do NOT cancel/replan `P` — only ADD the next attempt subtree. The new attempts become `spawn`able next heartbeat. (Converged/budget-stopped problems fall through to `plan`/`stop`; a STUCK problem returns `await_user`.)
   - **`await_user`** → the planner/judge OR the optimize control raised a `request_guidance` question for that loop (e.g. an optimization is **stuck**). That loop is halted until the user answers (`/guidance/resolve`). Drop it from the rescheduling set; report the question(s) briefly.
3. **Reschedule ONE `ScheduleWakeup`** carrying this same heartbeat prompt, with delay = the **MIN `next_poll_seconds` across all entries still in the rescheduling set** (every entry whose action was `idle`/`spawn`/`judge_edges`/`plan`/`optimize`). If EVERY entry reported `stop`/`await_user` (or the array was empty), do NOT reschedule — the whole heartbeat is done; report briefly. Keep calling `ScheduleWakeup` directly — do NOT route through any native `/loop` wrapper.

## Cooperative stop (in-process self-exit)
The heartbeat tick runs **in-process**, so the PreToolUse cooperative-stop hook can't interrupt it.
The daemon enforces the stop for you instead: every `next_action` tick first polls EACH loop's own
stop signal (a cancel on that loop's session's claimed task, or a stop on its agent — same logic as
`GET /should-stop?session=<id>`). If set, that loop's entry returns `action:'stop', reason:'cooperative stop'`
and the daemon clears its `active` flag — so the loop self-exits **within one iteration**, after
finishing the current step and persisting. Pass `session` to `loop_control(action:"start")` to arm this per loop. Hard
token/iteration caps (and the central liveness sweep for dead-session/stalled loops) are enforced the
same way. A killed driver simply stops calling `next_action`; loops PAUSE (registry persisted to
`loops.json`, no corruption) and a fresh heartbeat resumes them — and the daemon's periodic sweep
demotes any whose driving session is dead.

## Token discipline
- On an `idle` tick, do not reason or call other tools — the daemon already decided. One MCP call + a one-word reply.
- Trust the daemon's `next_poll_seconds`: it backs off to long intervals when idle/waiting and short when work is flowing.
- `loop_control({ action: "stop", loopId })` cancels a specific loop anytime (loopId required); `orch off` (the conversation toggle) ends the loop(s) this conversation drives. An `await_user` action means the planner/judge raised a `request_guidance` question — that loop is halted until the user answers (`/guidance/resolve`).
