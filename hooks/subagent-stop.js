#!/usr/bin/env node
'use strict';
// SubagentStop: mark the subagent done in the daemon. Non-blocking. Node port of subagent-stop.sh.
const k = require('./lib/hookkit');

(async () => {
  const input = await k.readInput();
  const sid = input.session_id || '';
  if (k.isOff(sid)) k.allow();          // opted out
  const agentId = input.agent_id || '';
  if (!agentId) k.allow();
  await k.post('/agent/done', { agent_id: agentId }, 500);
  process.exit(0);
})().catch(() => process.exit(0));
