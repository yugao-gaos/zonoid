# ScheduleWakeup

Short reference for session-scoped delayed re-prompts (heartbeat / idle polling). Full adapter
mapping: [adapter-contract.md](./adapter-contract.md#scheduler-contract-schedulewakeup).

## Contract

```
ScheduleWakeup(delaySeconds, reason, prompt)
```

- **Cancel + arm:** each call kills any prior wake for the session, then starts one new timer.
- **Fire line:** after `delaySeconds`, append to `<runtime-data-dir>/wake/<session-slug>.fire`:

  ```
  ORCH_SCHEDULED_TASK {"delaySeconds":7200,"reason":"idle heartbeat","prompt":"<<autonomous-loop-dynamic>>"}
  ```

- **Monitor:** hookless clients can run the tool-returned `command` (typically
  `tail -n0 -F <fire path>`) and match stdout against `notify_pattern`
  (`^ORCH_SCHEDULED_TASK`). Codex Desktop real-session delivery is also supervised by the daemon.

## Codex Desktop sessions

Codex hooks can expose a `session_id`, but that hook process does not share request-scoped state
with the MCP subprocess. Codex `SessionStart` persists the latest real session id for the current
workspace in an adapter-owned bridge file. Codex `ScheduleWakeup` resolves the session at call time:
explicit `session_id` first, then hook/context/env ids, then the workspace bridge, and finally a
cryptographically random session key local to that MCP process. The fallback key is stable for that
process only, collision-resistant across MCP processes, and neither workspace-global nor persisted
as a cross-thread identity.

Arming a wake always guarantees timer delivery to the `.fire` file. When the resolved Codex session
is real, the daemon starts an in-process delivery supervisor at Codex `SessionStart` and again on
daemon boot for bridged workspaces. The supervisor creates the `.fire` file if needed, watches for
new `ORCH_SCHEDULED_TASK` lines, and invokes `codex resume <session-id> <prompt>`. The tool still
returns `delivery.supported: true`, `delivery.session_id`, and a `delivery.command` pipeline for
compatibility and diagnostics. When only the random fallback is available, `delivery.supported` is
`false`: the timer is armed, but there is no Codex Desktop thread identity to resume.

## Where it lives

| Layer | Path |
|---|---|
| Core substrate | `lib/schedule-wakeup.js` |
| Shared wake host | `lib/wake-host.js` (one process delivers a whole registry) |
| Shell CLI | `adapters/common/schedule-wakeup.sh` (`arm` / `cancel`) |
| MCP (cursor, codex) | `lib/mcp-harness-tools.js` → tool name `ScheduleWakeup` |
| Codex delivery supervisor | `lib/codex-wakeup-delivery.js` daemon-owned watcher → `codex resume <session-id> <prompt>` |
| Codex delivery monitor CLI | `adapters/codex/wakeup-monitor.js` compatibility pipeline for manual diagnostics |
| OpenCode plugin | `packages/opencode-plugin` → tool `schedule_wakeup`; in-plugin delivery via `packages/opencode-plugin/lib/wake-delivery.js` → SDK `client.session.promptAsync` (self-driving heartbeat) |
| Adapter scheduler | `lib/adapters/scheduler-substrate.js` |
| Claude native | Built-in — no MCP duplicate |

Wake pid/fire files live under the Zonoid runtime data dir's `wake/` folder.
`ORCH_DATA` wins exactly when set; otherwise `ZONOID_DATA`, legacy
`CLAUDE_PLUGIN_DATA`, or `~/.claude/orchestrator/.zonoid` is used. Durable graph
state remains in workspace `.graph/`.

## Delivery: one shared wake host

`armWakeup` does **not** spawn a process per wakeup. It writes a self-describing registry row and
ensures a single **wake host** (`lib/wake-host.js`) is running for that registry; the host delivers
every pending wakeup in it.

**Registry.** `KEY -> {fireAt, session, payload, fire}` in
`<workspace>/.graph/scheduled-wakeups.json` (falls back to the runtime data dir when
`ORCH_WORKSPACE` is unset). The row carries everything needed to fire it, so *any* host — the one
`armWakeup` started, or one a later sweep starts — can deliver it. The row is written **before** the
host is ensured, so a row can never be stranded behind a host that idle-exits in the gap.

**Host.** One per registry, pid published as `<wake-dir>/wake-host-<hash-of-registry-path>.pid`.
Each tick (immediately on start, then every `ORCH_WAKE_HOST_TICK_MS`, default 1000ms) it appends the
fire line for every row whose `fireAt` has passed, drops those rows, and exits once nothing has been
pending for `ORCH_WAKE_HOST_IDLE_MS` (default 10s). The pidfile is the handover token: a host that
no longer owns it stops on its next tick, so a racing second host never double-fires.

**Why.** The previous design spawned a detached `node -e` sleeper per wakeup, so the live-process
count tracked the pending-wakeup count and every way a fire could be lost (hard kill, crashed
sleeper, a registry split across differing `ORCH_WORKSPACE` values so the daemon sweep never saw the
row) leaked a process nothing could find again. 3,893 accumulated on one machine and exhausted the
process table — system-wide `EPERM` `uv_spawn` failures. N pending wakeups now cost one process.

**Cancel never kills the host.** The host owns every session's pending wake, so deleting the row
*is* the cancel. `cancelWakeup` refuses to kill a pid that matches the host pidfile, and the bash
adapter's `cancel` skips any pid listed in a `wake-host-*.pid` — which is why those pidfiles live in
the wake dir rather than beside the registry.

## Leak reaping (daemon sweeps)

Two sweeps run in the daemon's 60s cycle (`daemon.js`, inside `require.main === module`, each
`setInterval(...).unref()`'d) and both reuse the module's single `isPidAlive` / `killPid` pair —
there is no second liveness or kill path. `killPid` records its recently-killed memo **only on a
real kill**: memoizing a kill that never happened (`taskkill` failing to spawn is exactly what
process-table exhaustion produces) would make `isPidAlive` report a live process as dead, and the
sweeps would prune its row and lose track of it for good.

### Part 1 — `sweepStaleWakeups()` (always on)

Reconciles every registry row against process reality, and doubles as the host's supervisor:

| Row state | Action |
|---|---|
| hosted, `now > fireAt + GRACE` | no host delivered it → prune the row |
| hosted, pending | leave alone |
| *legacy* pid dead | prune the row (it fired + exited; the reap-on-fire write may have been lost) |
| *legacy* pid alive, `now > fireAt + GRACE` | stuck sleeper → `killPid` + prune |
| *legacy* pending, or only just past `fireAt` | leave alone |

An undelivered hosted row is evidence the recorded host is not working — stuck, or its pid recycled
onto an unrelated process — so the sweep releases the host registration (unlink only; that pid is
never killed, because it can no longer be identified). Afterwards, if any hosted row is still
pending it calls `ensureWakeHost`, so a host that died, hung, or was killed out from under the
registry is replaced. Rows carrying a `pid` and no `payload` are *legacy* rows from the old
one-sleeper-per-wakeup design and are still reaped by pid.

`GRACE` defaults to **5 min**, override with `ORCH_WAKEUP_GRACE_MIN`. Rows with a non-numeric
`fireAt` are never treated as overdue — a legacy row is then pruned only when its pid is dead.
Returns `{swept, killed, pruned, hosted}`.

### Part 2 — `sweepOrphanProcesses()` (opt-in, default OFF)

An OS-level janitor for leaked *node* processes generally, not just sleepers. Gated behind
`ORCH_PROCESS_JANITOR`: unset ⇒ a pure no-op returning `{enabled:false}`, having enumerated and
killed nothing. When enabled it kills only the intersection of:

1. command line matches a narrow **ephemeral allowlist** — `node --test` runners,
   `node -e "…require('./daemon')…"` blobs, and `daemon.js` launches carrying an `ORCH_*PORT=` env; and
2. age > `ORCH_PROCESS_JANITOR_MAX_MIN` (default **20 min**); and
3. pid is not protected — this daemon, plus the embed/rerank sidecars (read live from their
   pidfiles each pass, so a sidecar restart is always covered).

Anything not matching rule 1 is left strictly alone, so services, editors, shells, `mcp-graph.js`,
and the user's own node programs can never become candidates — `mcp-graph` needs no pidfile because
its argv structurally never matches. Each kill logs pid, matched pattern, and age to stderr.
Process enumeration is `ps -eo pid,etimes,args` on POSIX and `Get-CimInstance Win32_Process` on
Windows; any enumeration failure returns `[]`, so a janitor that cannot see safely does nothing.

## Heartbeat nudge (classify)

`POST /classify` injects a fixed heartbeat line into `additional_context` (see
`lib/classify-assemble.js` `HEARTBEAT`). It tells the agent to call `ScheduleWakeup` after idle
ticks; on wake, run `next_action` and reschedule only when loops still need polling.

## Init

`zonoid init --harness cursor|codex|opencode` chmods `adapters/common/schedule-wakeup.sh` and
documents the monitor workflow in CLI next-steps. OpenCode also symlinks the plugin with
`schedule_wakeup`.
