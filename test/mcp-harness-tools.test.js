#!/usr/bin/env node
// Harness-scoped MCP tool list (P7-G1): default surface unchanged; codex adds create_task.
// Run: node test/mcp-harness-tools.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { TOOLS, handleRpc, makeCall, formatToolsList } = require('../lib/mcp-core');
const { extraToolsForClient, resolveSession } = require('../lib/mcp-harness-tools');
const filedrop = require('../lib/filedrop-tasks');
const scheduleWakeup = require('../lib/schedule-wakeup');
const codexSessionBridge = require('../lib/codex-session-bridge');

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
  ok('default surface includes ask_subconscious', defaultList.result.tools.some((t) => t.name === 'ask_subconscious'));

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
  await withEnv({
    ORCH_SESSION: null,
    ZONOID_SESSION: null,
    CLAUDE_CODE_SESSION_ID: null,
    CODEX_THREAD_ID: null,
  }, async () => {
    const fallback = resolveSession({ client: 'codex' });
    ok('Codex fallback is stable in one MCP process', fallback === resolveSession({ client: 'codex' }) && /^codex-mcp-\d+-[a-f0-9]{32}$/.test(fallback));
    ok('Codex fallback does not apply to cursor', resolveSession({ client: 'cursor' }) === '');
    const desktopWake = await extraToolsForClient('codex', WS)[1].run({ delaySeconds: 60, reason: 'test', prompt: 'wake' });
    ok('ScheduleWakeup works for Codex Desktop without a session', desktopWake.ok === true && desktopWake.command.includes(`${fallback}.fire`));
    ok('Codex fallback wake is timer-only', desktopWake.delivery && desktopWake.delivery.supported === false && desktopWake.delivery.method === 'timer-only');
    scheduleWakeup.cancelWakeup(fallback);

    codexSessionBridge.writeLatestSession({ workspace: WS, session_id: 'real-codex-session', transcript: '/tmp/real-codex.jsonl' });
    const bridgedWake = await extraToolsForClient('codex', WS, { session: fallback })[1].run({ delaySeconds: 60, reason: 'test', prompt: 'wake' });
    ok('Codex ScheduleWakeup prefers bridged real session over MCP fallback', bridgedWake.ok === true && bridgedWake.command.includes('real-codex-session.fire') && bridgedWake.session_source === 'codex-bridge');
    ok('Codex bridged wake returns resume delivery command', bridgedWake.delivery && bridgedWake.delivery.supported === true && bridgedWake.delivery.session_id === 'real-codex-session' && bridgedWake.delivery.command.includes('wakeup-monitor.js'));
    scheduleWakeup.cancelWakeup('real-codex-session');
  });
  await withEnv({ CODEX_THREAD_ID: 'codex-thread', ORCH_SESSION: 'orch-session' }, async () => {
    ok('Codex context session keeps precedence over environment', resolveSession({ client: 'codex', session: 'context-session' }) === 'context-session');
    ok('Codex ORCH_SESSION keeps precedence over CODEX_THREAD_ID', resolveSession({ client: 'codex' }) === 'orch-session');
  });
  const fallbackChild = () => spawnSync(process.execPath, ['-e', "process.stdout.write(require('./lib/mcp-harness-tools').resolveSession({ client: 'codex' }))"], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, ORCH_SESSION: '', ZONOID_SESSION: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' },
  }).stdout.trim();
  const fallbackA = fallbackChild();
  const fallbackB = fallbackChild();
  ok('Codex fallback is isolated across MCP processes', fallbackA !== fallbackB && /^codex-mcp-\d+-[a-f0-9]{32}$/.test(fallbackA) && /^codex-mcp-\d+-[a-f0-9]{32}$/.test(fallbackB));

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

  const subconsciousTool = TOOLS.find((t) => t.name === 'ask_subconscious');
  ok('ask_subconscious is on default MCP surface', !!subconsciousTool);
  ok('ask_subconscious schema exposes agent_id and route prompt fields',
    subconsciousTool &&
    subconsciousTool.inputSchema.properties.agent_id &&
    subconsciousTool.inputSchema.properties.task_key &&
    subconsciousTool.inputSchema.properties.intent &&
    subconsciousTool.inputSchema.properties.situation &&
    subconsciousTool.inputSchema.properties.query);
  let capturedSubconsciousAsk = null;
  const subconsciousOut = await subconsciousTool.run({
    agent_id: 'agent-a',
    task_key: 'local/task',
    intent: 'choose next implementation step',
    situation: 'Need the relevant context before editing',
    k: 4,
  }, (method, path, body) => {
    capturedSubconsciousAsk = { method, path, body };
    return { ok: true, verdict: 'inject_relevant_context' };
  });
  ok('ask_subconscious runs POST /subconscious/ask',
    capturedSubconsciousAsk && capturedSubconsciousAsk.method === 'POST' && capturedSubconsciousAsk.path === '/subconscious/ask');
  ok('ask_subconscious passes expected request shape',
    capturedSubconsciousAsk &&
    capturedSubconsciousAsk.body.agent_id === 'agent-a' &&
    capturedSubconsciousAsk.body.task_key === 'local/task' &&
    capturedSubconsciousAsk.body.intent === 'choose next implementation step' &&
    capturedSubconsciousAsk.body.situation === 'Need the relevant context before editing' &&
    capturedSubconsciousAsk.body.k === 4);
  ok('ask_subconscious returns route output', subconsciousOut && subconsciousOut.verdict === 'inject_relevant_context');

  const subconsciousSkillTool = TOOLS.find((t) => t.name === 'subconscious_skill');
  ok('subconscious_skill is on default MCP surface', !!subconsciousSkillTool);
  ok('subconscious_skill schema exposes action enum and lifecycle fields',
    subconsciousSkillTool &&
    subconsciousSkillTool.inputSchema.properties.action.enum.includes('propose_candidate') &&
    subconsciousSkillTool.inputSchema.properties.action.enum.includes('record_evaluation') &&
    subconsciousSkillTool.inputSchema.properties.action.enum.includes('promote_winner') &&
    subconsciousSkillTool.inputSchema.properties.action.enum.includes('rollback_promotion') &&
    subconsciousSkillTool.inputSchema.properties.action.enum.includes('recommend_third_party') &&
    subconsciousSkillTool.inputSchema.properties.skill_markdown &&
    subconsciousSkillTool.inputSchema.properties.measurements &&
    subconsciousSkillTool.inputSchema.properties.policy);
  ok('subconscious_skill description preserves safety invariant',
    subconsciousSkillTool && /never overwrites SKILL\.md/i.test(subconsciousSkillTool.description));
  let capturedSubconsciousSkill = null;
  const skillOut = await subconsciousSkillTool.run({
    action: 'list_proposals',
    workspace: WS,
    capability: 'planning',
    limit: 3,
  }, (method, path, body) => {
    capturedSubconsciousSkill = { method, path, body };
    return { ok: true, proposals: [] };
  });
  ok('subconscious_skill runs POST /subconscious/skill',
    capturedSubconsciousSkill && capturedSubconsciousSkill.method === 'POST' && capturedSubconsciousSkill.path === '/subconscious/skill');
  ok('subconscious_skill passes action body unchanged',
    capturedSubconsciousSkill &&
    capturedSubconsciousSkill.body.action === 'list_proposals' &&
    capturedSubconsciousSkill.body.workspace === WS &&
    capturedSubconsciousSkill.body.capability === 'planning' &&
    capturedSubconsciousSkill.body.limit === 3);
  ok('subconscious_skill returns route output', skillOut && skillOut.ok === true && Array.isArray(skillOut.proposals));

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
