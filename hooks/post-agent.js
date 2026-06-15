#!/usr/bin/env node
'use strict';
// PostToolUse(Agent|Task): when a subagent returns, nudge the main agent with the set of
// newly-ready tasks so it can advance immediately (uses the read-only /ready). Node port.
const k = require('./lib/hookkit');

(async () => {
  const input = await k.readInput();
  const sid = input.session_id || '';
  if (k.isOff(sid)) k.allow();          // opted out
  const ready = await k.getJson(`/ready?session=${encodeURIComponent(sid)}`, 500);
  const labels = (ready && Array.isArray(ready.ready)) ? ready.ready.map((r) => r && r.label).filter(Boolean) : [];
  if (!labels.length) k.allow();
  const ctx = `[Orchestrator] Downstream tasks now ready (unblocked by work you just dispatched): ${labels.join(', ')}. Dispatch them as background subagents (pass their TASK_IDs) before reporting to the user.`;
  k.emitContext('PostToolUse', ctx);
})().catch(() => process.exit(0));
