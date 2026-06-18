#!/usr/bin/env node
// Harness-scoped MCP tool list (P7-G1): default surface unchanged; codex adds create_task.
// Run: node test/mcp-harness-tools.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { TOOLS, handleRpc, makeCall, formatToolsList } = require('../lib/mcp-core');
const { extraToolsForClient, resolveSession } = require('../lib/mcp-harness-tools');
const filedrop = require('../lib/filedrop-tasks');
const scheduleWakeup = require('../lib/schedule-wakeup');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-harness-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-harness-ws-')));
const PORT = 19720 + Math.floor(Math.random() * 100);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

async function withEnv(overrides, fn) {
  const old = {};
  for (const k of Object.keys(overrides)) {
    old[k] = process.env[k];
    if (overrides[k] == null) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(overrides)) {
      if (old[k] == null) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  const baselinePayload = JSON.stringify(formatToolsList(TOOLS));
  const defaultList = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { call: () => ({}) });
  ok('default tools/list count matches TOOLS.length', defaultList.result.tools.length === TOOLS.length);
  ok('default tools/list byte-identical to formatToolsList(TOOLS)', JSON.stringify(defaultList.result.tools) === baselinePayload);
  ok('default surface has no create_task', !defaultList.result.tools.some((t) => t.name === 'create_task'));

  const startTaskTool = TOOLS.find((t) => t.name === 'start_task');
  ok('start_task schema has session_id', startTaskTool && startTaskTool.inputSchema.properties.session_id && startTaskTool.inputSchema.properties.session_id.type === 'string');
  ok('start_task description warns dispatchers', startTaskTool && startTaskTool.description.includes('must NOT call start_task'));
  let capturedClaim = null;
  await startTaskTool.run({ task_key: 'local/x', agent_id: 'w', session_id: 'sess-abc' }, (method, path, body) => {
    capturedClaim = { method, path, body };
    return { ok: true };
  });
  ok('start_task run passes session_id to overlay/status', capturedClaim && capturedClaim.method === 'POST' && capturedClaim.path === '/overlay/status' && capturedClaim.body.session_id === 'sess-abc');

  let harnessCaptured = null;
  await handleRpc(
    { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'start_task', arguments: { task_key: 'local/y', agent_id: 'w2' } } },
    { call: (method, path, body) => { if (path === '/overlay/status') harnessCaptured = body; return { ok: true }; }, session: 'harness-sess' },
  );
  ok('handleRpc injects ctx.session into start_task', harnessCaptured && harnessCaptured.session_id === 'harness-sess');
  await withEnv({
    ORCH_SESSION: null,
    ZONOID_SESSION: null,
    CLAUDE_CODE_SESSION_ID: null,
    CODEX_THREAD_ID: 'codex-thread-only',
  }, async () => {
    let codexCaptured = null;
    await handleRpc(
      { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'start_task', arguments: { task_key: 'local/codex', agent_id: 'w3' } } },
      { call: (method, path, body) => { if (path === '/overlay/status') codexCaptured = body; return { ok: true }; }, session: resolveSession({ client: 'codex' }) },
    );
    ok('resolveSession reads CODEX_THREAD_ID-only env for codex', resolveSession({ client: 'codex' }) === 'codex-thread-only');
    ok('resolveSession does not leak CODEX_THREAD_ID to cursor', resolveSession({ client: 'cursor' }) === '');
    ok('handleRpc injects CODEX_THREAD_ID-only session into start_task', codexCaptured && codexCaptured.session_id === 'codex-thread-only');
  });

  const judgeNextTool = TOOLS.find((t) => t.name === 'get_judge_next');
  ok('get_judge_next is on default MCP surface', !!judgeNextTool);
  ok('get_judge_next schema exposes node+budget', judgeNextTool && judgeNextTool.inputSchema.properties.node && judgeNextTool.inputSchema.properties.budget);
  ok('get_judge_next description names start_task hold', judgeNextTool && /start_task/.test(judgeNextTool.description));
  let capturedJudgeNext = null;
  await judgeNextTool.run({ node: 'local/y', budget: 7 }, (method, path, body) => {
    capturedJudgeNext = { method, path, body };
    return { ok: true };
  });
  ok('get_judge_next runs GET /judge/next?node=', capturedJudgeNext && capturedJudgeNext.method === 'GET' && capturedJudgeNext.path === '/judge/next?node=local%2Fy&budget=7');

  const judgeVerdictTool = TOOLS.find((t) => t.name === 'submit_judge_verdict');
  ok('submit_judge_verdict is on default MCP surface', !!judgeVerdictTool);
  ok('submit_judge_verdict schema exposes verdicts and edge actions',
    judgeVerdictTool && judgeVerdictTool.inputSchema.properties.verdicts && judgeVerdictTool.inputSchema.properties.keepEdge && judgeVerdictTool.inputSchema.properties.pruneEdge);
  let capturedJudgeVerdict = null;
  await judgeVerdictTool.run({ verdicts: [{ pruneEdge: { from: 'note:a', to: 'local/y' } }] }, (method, path, body) => {
    capturedJudgeVerdict = { method, path, body };
    return { ok: true };
  });
  ok('submit_judge_verdict runs POST /judge/verdict', capturedJudgeVerdict && capturedJudgeVerdict.method === 'POST' && capturedJudgeVerdict.path === '/judge/verdict');
  ok('submit_judge_verdict passes explicit verdict body', capturedJudgeVerdict && capturedJudgeVerdict.body.verdicts[0].pruneEdge.to === 'local/y');
  const emptyVerdict = await judgeVerdictTool.run({}, () => ({ ok: true }));
  ok('submit_judge_verdict rejects empty calls', /at least one/.test(emptyVerdict.error || ''));

  const drainTool = TOOLS.find((t) => t.name === 'drain_kb_queue');
  ok('drain_kb_queue exposes opt-in autoInject', drainTool && drainTool.inputSchema.properties.autoInject && drainTool.description.includes('Default is human-gated'));
  ok('inject_kb is on default MCP surface', TOOLS.some((t) => t.name === 'inject_kb'));

  const codexExtra = extraToolsForClient('codex', WS);
  ok('codex extraTools has create_task + ScheduleWakeup', codexExtra.length === 2 && codexExtra[0].name === 'create_task' && codexExtra[1].name === 'ScheduleWakeup');
  ok('ScheduleWakeup schema accepts explicit session_id', codexExtra[1].inputSchema.properties.session_id && codexExtra[1].inputSchema.properties.session_id.type === 'string');
  ok('claude extraTools empty', extraToolsForClient('claude', WS).length === 0);
  ok('cursor extraTools is ScheduleWakeup', extraToolsForClient('cursor', WS, { session: 'test' }).length === 1 && extraToolsForClient('cursor', WS, { session: 'test' })[0].name === 'ScheduleWakeup');
  const explicitWake = await codexExtra[1].run({ delaySeconds: 60, reason: 'test', prompt: 'wake', session_id: 'codex-explicit-session' });
  ok('ScheduleWakeup works with explicit session_id and no ctx.session', explicitWake.ok === true && explicitWake.command.includes('codex-explicit-session.fire'));
  scheduleWakeup.cancelWakeup('codex-explicit-session');

  const codexList = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { call: () => ({}), extraTools: codexExtra });
  ok('codex tools/list adds create_task + ScheduleWakeup', codexList.result.tools.length === TOOLS.length + 2);
  ok('codex list still includes get_graph', codexList.result.tools.some((t) => t.name === 'get_graph'));
  ok('codex default core names unchanged', JSON.stringify(codexList.result.tools.slice(0, TOOLS.length)) === baselinePayload);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    ok('daemon up', await waitForPing());
    await req('POST', '/workspace', { path: WS });
    const call = makeCall(PORT, WS);
    const mint = await handleRpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'create_task', arguments: { id: 'mint1', subject: 'codex minted task', agent_id: 'test-codex' } },
    }, { call, extraTools: codexExtra });
    const out = JSON.parse(mint.result.content[0].text);
    ok('create_task returns ok', out.ok === true);
    ok('create_task task_key', out.task_key === 'codex/mint1');
    ok('create_task sync shape', Array.isArray(out.adopted));
    ok('stub file on disk', fs.existsSync(path.join(filedrop.dirFor(WS), 'codex', 'mint1.json')));
    const stub = JSON.parse(fs.readFileSync(path.join(filedrop.dirFor(WS), 'codex', 'mint1.json'), 'utf8'));
    ok('stub created_by harness', stub.created_by && stub.created_by.harness === 'codex');
    const badMint = await handleRpc({
      jsonrpc: '2.0', id: 33, method: 'tools/call',
      params: { name: 'create_task', arguments: { id: '../escape', subject: 'bad task' } },
    }, { call, extraTools: codexExtra });
    const badOut = JSON.parse(badMint.result.content[0].text);
    ok('create_task rejects traversal ids', /letters, numbers/.test(badOut.error || ''));
    ok('create_task traversal did not write outside codex namespace', !fs.existsSync(path.join(filedrop.dirFor(WS), 'escape.json')));

    const httpList = await req('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    ok('HTTP /mcp has no create_task (default surface)', !httpList.body.result.tools.some((t) => t.name === 'create_task'));
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
