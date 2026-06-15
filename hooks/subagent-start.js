#!/usr/bin/env node
'use strict';
// SubagentStart: register the subagent with the daemon for observability. Non-blocking. Node port.
const k = require('./lib/hookkit');

(async () => {
  const input = await k.readInput();
  const sid = input.session_id || '';
  if (k.isOff(sid)) k.allow();          // opted out
  const agentId = input.agent_id || '';
  const agentType = input.agent_type || 'agent';
  const transcript = input.transcript_path || '';
  if (!agentId) k.allow();
  // Agent-tool spawns use .output paths, not .jsonl — register with agent_tool_spawn:true so the
  // daemon matches on agent_id instead of trying to extract a session.
  await k.post('/agent/start', {
    agent_id: agentId,
    agent_type: agentType,
    transcript_path: transcript,
    session: sid,
    parent_session_id: sid,
    agent_tool_spawn: true,
  }, 500);
  process.exit(0);
})().catch(() => process.exit(0));
