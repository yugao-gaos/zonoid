#!/usr/bin/env node
'use strict';
// PreToolUse(*) ENFORCED COOPERATIVE-STOP gate: if THIS conversation's claimed task has a
// cancel_requested flag, OR its assigned agent has a stop_requested flag, deny the tool call so the
// worker halts and reports. Exit 2 = deny; exit 0 = allow. Fail-open. Node port of orch-stop.sh.
const k = require('./lib/hookkit');

(async () => {
  if (k.gateOff()) k.allow();           // escape hatch
  const input = await k.readInput();
  const sid = input.session_id || '';
  if (!sid) k.allow();                  // can't correlate
  if (k.isOff(sid)) k.allow();          // orchestrator disabled

  // agent_id present only inside a SUBAGENT's context; forward it so the daemon halts ONLY the
  // worker a stop targets, not the driver that requested it (which shares this session_id).
  const agent = input.agent_id || '';
  let url = `/should-stop?session=${encodeURIComponent(sid)}`;
  if (agent) url += `&agent=${encodeURIComponent(agent)}`;
  const resp = await k.getJson(url, 600);
  if (!resp) k.allow();                 // daemon unreachable -> fail open

  if (resp.stop === true) {
    const reason = resp.reason || 'cancellation/stop requested';
    const msg = `STOP: ${reason} — halt current work now. Completion notice: before exiting, call subconscious_assignment action:"complete" with status "failed" to record your progress in the graph. Then call ScheduleWakeup(delaySeconds=7200, reason="idle heartbeat", prompt="<<autonomous-loop-dynamic>>") so the session stays reachable for future tasks.`;
    // stdout carries the JSON hookSpecificOutput; stderr mirrors it (smoke test reads stderr).
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }));
    process.stderr.write(msg + '\n');
    process.exit(2);
  }
  process.exit(0);
})().catch(() => process.exit(0));
