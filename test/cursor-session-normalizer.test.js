#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'adapters', 'cursor', 'lib.sh');
let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

function runFn(fn, input) {
  const escaped = input.replace(/'/g, "'\\''");
  const r = spawnSync('bash', ['-c', `source "${LIB}"; ${fn} '${escaped}'`], {
    encoding: 'utf8',
    env: { ...process.env, CURSOR_PROJECT_DIR: '/proj/root' },
  });
  if (r.status !== 0) {
    console.error(r.stderr);
  }
  return (r.stdout || '').trim();
}

{
  const sid = runFn('orch_session_id', '{"conversation_id":"conv-1"}');
  ok('conversation_id → session', sid === 'conv-1');
}
{
  const sid = runFn('orch_session_id', '{"session_id":"sess-1","conversation_id":"conv-1"}');
  ok('session_id wins over conversation_id', sid === 'sess-1');
}
{
  const sid = runFn('orch_session_id', '{"sessionId":"legacy"}');
  ok('sessionId fallback', sid === 'legacy');
}
{
  const ws = runFn('orch_workspace', '{"workspace_roots":["/ws/a"]}');
  ok('workspace_roots[0]', ws === '/ws/a');
}
{
  const out = runFn('orch_normalize_json', '{"conversation_id":"c1","workspace_roots":["/ws"]}');
  const j = JSON.parse(out);
  ok('normalize adds session_id', j.session_id === 'c1');
  ok('normalize adds cwd', j.cwd === '/ws');
}
{
  const out = runFn('orch_to_bash_gate_json', '{"conversation_id":"c2","command":"echo hi"}');
  const j = JSON.parse(out);
  ok('bash gate maps command', j.tool_input.command === 'echo hi');
  ok('bash gate maps session', j.session_id === 'c2');
}
{
  const out = runFn('orch_to_subagent_start_json', '{"subagent_id":"a1","parent_conversation_id":"p1","subagent_type":"explore","agent_transcript_path":"/t/a1.jsonl"}');
  const j = JSON.parse(out);
  ok('subagent start agent_id', j.agent_id === 'a1');
  ok('subagent start session', j.session_id === 'p1');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
