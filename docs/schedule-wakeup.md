# ScheduleWakeup

Short reference for session-scoped delayed re-prompts (heartbeat / idle polling). Full adapter
mapping: [adapter-contract.md](./adapter-contract.md#scheduler-contract-schedulewakeup).

## Contract

```
ScheduleWakeup(delaySeconds, reason, prompt)
```

- **Cancel + arm:** each call kills any prior wake for the session, then starts one new timer.
- **Fire line:** after `delaySeconds`, append to `$ORCH_DATA/wake/<session-slug>.fire`:

  ```
  ORCH_SCHEDULED_TASK {"delaySeconds":7200,"reason":"idle heartbeat","prompt":"<<autonomous-loop-dynamic>>"}
  ```

- **Monitor:** run the tool-returned `command` (typically `tail -n0 -F <fire path>`) and match
  stdout against `notify_pattern` (`^ORCH_SCHEDULED_TASK`).

## Codex Desktop sessions

Codex hooks can expose a `session_id`, but that hook process does not share request-scoped state
with the MCP subprocess. The Codex MCP server therefore prefers an explicit `session_id`, hook or
context data, `ORCH_SESSION`, `ZONOID_SESSION`, and `CODEX_THREAD_ID`; when all are absent, it
generates a cryptographically random session key local to that MCP process. The key is stable for
that process only, collision-resistant across MCP processes, and neither workspace-global nor
persisted as a cross-thread identity.

Arming a wake guarantees only timer delivery to the `.fire` file. The MCP server cannot cause
Codex Desktop to re-prompt a conversation; the host must monitor the returned `command` and deliver
the prompt after observing `notify_pattern`.

## Where it lives

| Layer | Path |
|---|---|
| Core substrate | `lib/schedule-wakeup.js` |
| Shell CLI | `adapters/common/schedule-wakeup.sh` (`arm` / `cancel`) |
| MCP (cursor, codex) | `lib/mcp-harness-tools.js` → tool name `ScheduleWakeup` |
| OpenCode plugin | `packages/opencode-plugin` → tool `schedule_wakeup` |
| Adapter scheduler | `lib/adapters/scheduler-substrate.js` |
| Claude native | Built-in — no MCP duplicate |

`ORCH_DATA` defaults to `CLAUDE_PLUGIN_DATA` or `~/.claude/orchestrator`.

## Heartbeat nudge (classify)

`POST /classify` injects a fixed heartbeat line into `additional_context` (see
`lib/classify-assemble.js` `HEARTBEAT`). It tells the agent to call `ScheduleWakeup` after idle
ticks; on wake, run `next_action` and reschedule only when loops still need polling.

## Init

`zonoid init --harness cursor|codex|opencode` chmods `adapters/common/schedule-wakeup.sh` and
documents the monitor workflow in CLI next-steps. OpenCode also symlinks the plugin with
`schedule_wakeup`.
