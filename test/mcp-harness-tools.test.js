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
  ok('default surface includes subconscious_search_context', defaultList.result.tools.some((t) => t.name === 'subconscious_search_context'));
  ok('default surface includes subconscious_idea_scheduler', defaultList.result.tools.some((t) => t.name === 'subconscious_idea_scheduler'));
  ok('default surface includes subconscious_assignment', defaultList.result.tools.some((t) => t.name === 'subconscious_assignment'));

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

  const assignmentTool = TOOLS.find((t) => t.name === 'subconscious_assignment');
  ok('subconscious_assignment is on default MCP surface', !!assignmentTool);
  ok('subconscious_assignment schema exposes required actions',
    assignmentTool &&
    assignmentTool.inputSchema.properties.action.enum.includes('prepare') &&
    assignmentTool.inputSchema.properties.action.enum.includes('accept') &&
    assignmentTool.inputSchema.properties.action.enum.includes('complete') &&
    assignmentTool.inputSchema.properties.action.enum.includes('submit_verdict'));
  ok('subconscious_assignment schema exposes agentic search context inputs',
    assignmentTool &&
    assignmentTool.inputSchema.properties.search_context &&
    assignmentTool.inputSchema.properties.context_query &&
    assignmentTool.inputSchema.properties.query);
  ok('subconscious_assignment description is the preferred path',
    assignmentTool &&
    assignmentTool.description.includes('Preferred facade') &&
    assignmentTool.description.includes('Raw graph/git/status tools remain available'));

  const assignmentCalls = [];
  const assignmentCall = (method, path, body) => {
    assignmentCalls.push({ method, path, body });
    if (path === '/subconscious/assignment') {
      return { ok: true, assignment: { task_key: body.task_key, branch: 'orch/attempt/local-task', worktree: '/tmp/wt' } };
    }
    if (path === '/git/merge') return { merged: true, head: 'abc123' };
    return { ok: true, status: body && body.status };
  };
  const preparedAssignment = await assignmentTool.run({
    action: 'prepare',
    workspace: WS,
    task_key: 'local/task',
    parent_task_keys: ['local/parent'],
    context_task_keys: ['note:ctx'],
    search_context: true,
    context_query: 'Need filtered Subconscious context',
    create_judge: true,
    repo_path: WS,
    base: 'orch/feature/test',
  }, assignmentCall);
  ok('subconscious_assignment prepare runs POST /subconscious/assignment',
    assignmentCalls[0] &&
    assignmentCalls[0].method === 'POST' &&
    assignmentCalls[0].path === '/subconscious/assignment' &&
    assignmentCalls[0].body.action === 'prepare' &&
    assignmentCalls[0].body.create_judge === true &&
    assignmentCalls[0].body.search_context === true &&
    assignmentCalls[0].body.context_query === 'Need filtered Subconscious context' &&
    preparedAssignment.assignment.task_key === 'local/task');

  assignmentCalls.length = 0;
  await assignmentTool.run({
    action: 'read',
    workspace: WS,
    task_key: 'local/task',
    agent_id: 'dispatcher-a',
    search_context: true,
    context_query: 'Read filtered Subconscious context',
    k: 2,
  }, assignmentCall);
  ok('subconscious_assignment read forwards agentic context query params',
    assignmentCalls[0] &&
    assignmentCalls[0].method === 'GET' &&
    assignmentCalls[0].path.startsWith('/subconscious/assignment?') &&
    assignmentCalls[0].path.includes('search_context=1') &&
    assignmentCalls[0].path.includes('context_query=Read%20filtered%20Subconscious%20context') &&
    assignmentCalls[0].path.includes('k=2'));

  assignmentCalls.length = 0;
  await assignmentTool.run({ action: 'accept', workspace: WS, task_key: 'local/task', agent_id: 'worker-a', session_id: 'sess-a' }, assignmentCall);
  ok('subconscious_assignment accept calls existing in_progress status path',
    assignmentCalls[0] &&
    assignmentCalls[0].method === 'POST' &&
    assignmentCalls[0].path === '/overlay/status' &&
    assignmentCalls[0].body.key === 'local/task' &&
    assignmentCalls[0].body.status === 'in_progress' &&
    assignmentCalls[0].body.session_id === 'sess-a');

  let assignmentInjectedSession = null;
  await handleRpc(
    { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'subconscious_assignment', arguments: { action: 'accept', task_key: 'local/session', agent_id: 'worker-b' } } },
    { call: (method, path, body) => { if (path === '/overlay/status') assignmentInjectedSession = body; return { ok: true }; }, session: 'ctx-session' },
  );
  ok('handleRpc injects ctx.session into subconscious_assignment accept',
    assignmentInjectedSession && assignmentInjectedSession.session_id === 'ctx-session');

  assignmentCalls.length = 0;
  await assignmentTool.run({ action: 'complete', workspace: WS, task_key: 'local/task', agent_id: 'worker-a', summary: 'done' }, assignmentCall);
  ok('subconscious_assignment complete calls terminal status path',
    assignmentCalls[0] &&
    assignmentCalls[0].path === '/overlay/status' &&
    assignmentCalls[0].body.status === 'done' &&
    assignmentCalls[0].body.summary === 'done');

  assignmentCalls.length = 0;
  const approveOut = await assignmentTool.run({ action: 'submit_verdict', verdict: 'APPROVE', workspace: WS, task_key: 'local/task', judge_task_key: 'local/task-judge', reason: 'passes' }, assignmentCall);
  ok('subconscious_assignment submit_verdict APPROVE calls merge internally',
    assignmentCalls.some((call) => call.path === '/git/merge' && call.body.key === 'local/task') &&
    approveOut.ok === true);
  ok('subconscious_assignment submit_verdict APPROVE completes judge when supplied',
    assignmentCalls.some((call) => call.path === '/overlay/status' && call.body.key === 'local/task-judge' && call.body.status === 'done'));

  assignmentCalls.length = 0;
  const failedApproveOut = await assignmentTool.run({ action: 'submit_verdict', verdict: 'APPROVE', workspace: WS, task_key: 'local/missing', judge_task_key: 'local/missing-judge', reason: 'passes' }, (method, path, body) => {
    assignmentCalls.push({ method, path, body });
    if (path === '/git/merge') return { merged: false, reason: 'branch not found for local/missing' };
    return { ok: true, status: body && body.status };
  });
  ok('subconscious_assignment submit_verdict APPROVE fails when merge reports not merged',
    failedApproveOut.ok === false &&
    failedApproveOut.error === 'branch not found for local/missing' &&
    failedApproveOut.merge &&
    failedApproveOut.merge.merged === false);
  ok('subconscious_assignment submit_verdict APPROVE does not complete judge after failed merge',
    !assignmentCalls.some((call) => call.path === '/overlay/status' && call.body.key === 'local/missing-judge'));

  assignmentCalls.length = 0;
  const kickBackOut = await assignmentTool.run({ action: 'submit_verdict', verdict: 'KICK_BACK', workspace: WS, task_key: 'local/task', judge_task_key: 'local/task-judge', reason: 'needs fix' }, assignmentCall);
  ok('subconscious_assignment submit_verdict KICK_BACK does not merge',
    !assignmentCalls.some((call) => call.path === '/git/merge') && kickBackOut.ok === true);
  ok('subconscious_assignment submit_verdict KICK_BACK marks implementation failed',
    assignmentCalls.some((call) => call.path === '/overlay/status' && call.body.key === 'local/task' && call.body.status === 'failed'));

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
  ok('drain_kb_queue exposes autoInject opt-out', drainTool && drainTool.inputSchema.properties.autoInject && drainTool.description.includes('Default auto-injects'));
  ok('inject_kb is on default MCP surface', TOOLS.some((t) => t.name === 'inject_kb'));

  const searchContextTool = TOOLS.find((t) => t.name === 'subconscious_search_context');
  ok('subconscious_search_context is on default MCP surface', !!searchContextTool);
  ok('subconscious_search_context schema exposes task and query fields',
    searchContextTool &&
    searchContextTool.inputSchema.properties.agent_id &&
    searchContextTool.inputSchema.properties.task_key &&
    searchContextTool.inputSchema.properties.intent &&
    searchContextTool.inputSchema.properties.situation &&
    searchContextTool.inputSchema.properties.query);
  ok('subconscious_search_context description advertises DAG and RAG steps',
    searchContextTool &&
    searchContextTool.description.includes('task-gated DAG') &&
    searchContextTool.description.includes('broad RAG'));
  let capturedSearchContext = null;
  const searchContextOut = await searchContextTool.run({
    agent_id: 'agent-a',
    workspace: WS,
    task_key: 'local/task',
    intent: 'prepare worker context',
    situation: 'Need filtered context before assignment',
    k: 3,
    include_internal: true,
  }, (method, path, body) => {
    capturedSearchContext = { method, path, body };
    return {
      ok: true,
      subconscious_context: {
        kind: 'subconscious_agentic_search_context',
        search_steps: [{ mode: 'dag_task_gated' }, { mode: 'rag_broad' }],
        context_task_keys: ['note:ctx'],
      },
    };
  });
  ok('subconscious_search_context runs POST /subconscious/search-context',
    capturedSearchContext &&
    capturedSearchContext.method === 'POST' &&
    capturedSearchContext.path === '/subconscious/search-context');
  ok('subconscious_search_context passes expected request shape',
    capturedSearchContext &&
    capturedSearchContext.body.agent_id === 'agent-a' &&
    capturedSearchContext.body.task_key === 'local/task' &&
    capturedSearchContext.body.intent === 'prepare worker context' &&
    capturedSearchContext.body.k === 3 &&
    capturedSearchContext.body.include_internal === true);
  ok('subconscious_search_context returns route output',
    searchContextOut &&
    searchContextOut.subconscious_context &&
    searchContextOut.subconscious_context.context_task_keys[0] === 'note:ctx');

  const subconsciousTool = TOOLS.find((t) => t.name === 'ask_subconscious');
  ok('ask_subconscious is on default MCP surface', !!subconsciousTool);
  ok('ask_subconscious schema exposes agent_id and route prompt fields',
    subconsciousTool &&
    subconsciousTool.inputSchema.properties.agent_id &&
    subconsciousTool.inputSchema.properties.task_key &&
    subconsciousTool.inputSchema.properties.session_id &&
    subconsciousTool.inputSchema.properties.companion_agent_id &&
    subconsciousTool.inputSchema.properties.approval_signals &&
    subconsciousTool.inputSchema.properties.include_internal &&
    subconsciousTool.inputSchema.properties.debug &&
    subconsciousTool.inputSchema.properties.intent &&
    subconsciousTool.inputSchema.properties.situation &&
    subconsciousTool.inputSchema.properties.query);
  ok('ask_subconscious description advertises next-action pressure',
    subconsciousTool && subconsciousTool.description.includes('next-action pressure'));
  ok('ask_subconscious description advertises the Subconscious-first envelope',
    subconsciousTool &&
    subconsciousTool.description.includes('single Subconscious envelope') &&
    subconsciousTool.description.includes('approval posture'));
  ok('ask_subconscious description advertises execution permit requirement',
    subconsciousTool && subconsciousTool.description.includes('execution permit requirement'));
  let capturedSubconsciousAsk = null;
  const subconsciousOut = await subconsciousTool.run({
    agent_id: 'agent-a',
    task_key: 'local/task',
    session_id: 'foreground-session',
    foreground_agent_id: 'foreground-agent',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    intent: 'choose next implementation step',
    situation: 'Need the relevant context before editing',
    approval_signals: ['deployment'],
    k: 4,
    include_internal: true,
  }, (method, path, body) => {
    capturedSubconsciousAsk = { method, path, body };
    return {
      ok: true,
      verdict: 'inject_relevant_context',
      selected_task_key: 'local/task',
      next_action: 'review_context_then_work_selected_anchor',
      subconscious: {
        kind: 'subconscious_agent_surface',
        verdict: 'inject_relevant_context',
        prediction: 'relevant_context_likely',
        context: { summary: { anchored_task_key: 'local/task' } },
        anchor: { selected_task_key: 'local/task' },
        approval_posture: { requires_approval: false },
        execution_permit: { required: true, status: 'required_before_write' },
      },
      execution_permit: { required: true, status: 'required_before_write' },
      internal: { evidence: { results: [{ key: 'note:context' }] } },
    };
  });
  ok('ask_subconscious runs POST /subconscious/ask',
    capturedSubconsciousAsk && capturedSubconsciousAsk.method === 'POST' && capturedSubconsciousAsk.path === '/subconscious/ask');
  ok('ask_subconscious passes expected request shape',
    capturedSubconsciousAsk &&
    capturedSubconsciousAsk.body.agent_id === 'agent-a' &&
    capturedSubconsciousAsk.body.task_key === 'local/task' &&
    capturedSubconsciousAsk.body.session_id === 'foreground-session' &&
    capturedSubconsciousAsk.body.companion_agent_id === 'companion-agent' &&
    capturedSubconsciousAsk.body.intent === 'choose next implementation step' &&
    capturedSubconsciousAsk.body.situation === 'Need the relevant context before editing' &&
    capturedSubconsciousAsk.body.approval_signals[0] === 'deployment' &&
    capturedSubconsciousAsk.body.k === 4 &&
    capturedSubconsciousAsk.body.include_internal === true);
  ok('ask_subconscious returns route output', subconsciousOut && subconsciousOut.verdict === 'inject_relevant_context');
  ok('ask_subconscious forwards Subconscious-first output shape',
    subconsciousOut &&
    subconsciousOut.subconscious &&
    subconsciousOut.subconscious.kind === 'subconscious_agent_surface' &&
    subconsciousOut.subconscious.context.summary.anchored_task_key === 'local/task' &&
    !subconsciousOut.subconscious.context.evidence &&
    subconsciousOut.subconscious.anchor.selected_task_key === 'local/task' &&
    !subconsciousOut.subconscious.pressure &&
    subconsciousOut.subconscious.approval_posture.requires_approval === false &&
    subconsciousOut.subconscious.execution_permit.status === 'required_before_write' &&
    subconsciousOut.execution_permit.required === true &&
    subconsciousOut.internal.evidence.results[0].key === 'note:context');

  const permitTool = TOOLS.find((t) => t.name === 'subconscious_execution_permit');
  ok('subconscious_execution_permit is on default MCP surface', !!permitTool);
  const installJs = fs.readFileSync(path.join(__dirname, '..', 'bin', 'install.js'), 'utf8');
  const cursorSettings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'adapters', 'cursor', 'settings.sample.json'), 'utf8'));
  ok('installer allow-list includes assignment facade tool',
    installJs.includes('mcp__orchestrator-graph__subconscious_assignment'));
  ok('Cursor sample permissions include assignment facade tool',
    cursorSettings.permissions.allow.includes('mcp__orchestrator-graph__subconscious_assignment'));
  ok('installer allow-list includes permit diagnostic tool',
    installJs.includes('mcp__orchestrator-graph__subconscious_execution_permit'));
  ok('Cursor sample permissions include permit diagnostic tool',
    cursorSettings.permissions.allow.includes('mcp__orchestrator-graph__subconscious_execution_permit'));
  ok('subconscious_execution_permit schema exposes issue read revoke and permit fields',
    permitTool &&
    permitTool.inputSchema.properties.action.enum.includes('issue') &&
    permitTool.inputSchema.properties.action.enum.includes('read') &&
    permitTool.inputSchema.properties.action.enum.includes('revoke') &&
    permitTool.inputSchema.properties.session_id &&
    permitTool.inputSchema.properties.task_key &&
    permitTool.inputSchema.properties.worktree &&
    permitTool.inputSchema.properties.branch &&
    permitTool.inputSchema.properties.allowed_paths);
  let capturedPermit = null;
  const permitOut = await permitTool.run({
    action: 'issue',
    workspace: '/tmp/ws',
    session_id: 'foreground-session',
    agent_id: 'agent-a',
    foreground_agent_id: 'foreground-agent',
    task_key: 'local/task',
    worktree: '/tmp/ws/wt',
    branch: 'orch/attempt/local-task',
    allowed_paths: ['/tmp/ws/wt/src'],
  }, (method, path, body) => {
    capturedPermit = { method, path, body };
    return { ok: true, execution_permit: { id: 'permit-a', task_key: body.task_key } };
  });
  ok('subconscious_execution_permit issue runs POST /subconscious/permit',
    capturedPermit && capturedPermit.method === 'POST' && capturedPermit.path === '/subconscious/permit');
  ok('subconscious_execution_permit issue passes expected body',
    capturedPermit &&
    capturedPermit.body.action === 'issue' &&
    capturedPermit.body.session_id === 'foreground-session' &&
    capturedPermit.body.task_key === 'local/task' &&
    capturedPermit.body.worktree === '/tmp/ws/wt' &&
    capturedPermit.body.branch === 'orch/attempt/local-task' &&
    capturedPermit.body.allowed_paths[0] === '/tmp/ws/wt/src');
  ok('subconscious_execution_permit returns route output', permitOut && permitOut.execution_permit.id === 'permit-a');

  const searchTool = TOOLS.find((t) => t.name === 'search_knowledge');
  ok('search_knowledge remains available as a lower-level primitive',
    searchTool &&
    searchTool.description.includes('Lower-level knowledge retrieval primitive') &&
    searchTool.description.includes('call ask_subconscious first') &&
    !searchTool.description.includes('default consult path'));

  const sessionCompanionTool = TOOLS.find((t) => t.name === 'subconscious_session_companion');
  ok('subconscious_session_companion is on default MCP surface', !!sessionCompanionTool);
  ok('subconscious_session_companion schema exposes session and companion fields',
    sessionCompanionTool &&
    sessionCompanionTool.inputSchema.properties.session_id &&
    sessionCompanionTool.inputSchema.properties.foreground_agent_id &&
    sessionCompanionTool.inputSchema.properties.companion_agent_id &&
    sessionCompanionTool.inputSchema.properties.companion_loop_id);
  let capturedSessionCompanion = null;
  const sessionCompanionOut = await sessionCompanionTool.run({
    action: 'update',
    workspace: '/tmp/ws',
    session_id: 'foreground-session',
    foreground_agent_id: 'foreground-agent',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    status: 'paired',
  }, (method, path, body) => {
    capturedSessionCompanion = { method, path, body };
    return { ok: true, session_companion: { session_id: body.session_id } };
  });
  ok('subconscious_session_companion runs POST /subconscious/session-companion',
    capturedSessionCompanion && capturedSessionCompanion.method === 'POST' && capturedSessionCompanion.path === '/subconscious/session-companion');
  ok('subconscious_session_companion passes expected request shape',
    capturedSessionCompanion &&
    capturedSessionCompanion.body.session_id === 'foreground-session' &&
    capturedSessionCompanion.body.foreground_agent_id === 'foreground-agent' &&
    capturedSessionCompanion.body.companion_agent_id === 'companion-agent' &&
    capturedSessionCompanion.body.companion_loop_id === 'companion-loop');
  ok('subconscious_session_companion returns route output', sessionCompanionOut && sessionCompanionOut.session_companion.session_id === 'foreground-session');

  const anchorAllocatorTool = TOOLS.find((t) => t.name === 'subconscious_anchor_allocator');
  ok('subconscious_anchor_allocator is on default MCP surface', !!anchorAllocatorTool);
  ok('subconscious_anchor_allocator schema exposes anchor and wiring fields',
    anchorAllocatorTool &&
    anchorAllocatorTool.inputSchema.properties.session_id &&
    anchorAllocatorTool.inputSchema.properties.companion_agent_id &&
    anchorAllocatorTool.inputSchema.properties.task_key &&
    anchorAllocatorTool.inputSchema.properties.parent_task_keys &&
    anchorAllocatorTool.inputSchema.properties.context_task_keys);
  let capturedAnchorAllocator = null;
  const anchorAllocatorOut = await anchorAllocatorTool.run({
    action: 'update',
    workspace: '/tmp/ws',
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    task_key: 'local/task',
    reason: 'anchor foreground session to current task',
    status: 'selected',
    parent_task_keys: ['local/parent'],
    context_task_keys: ['note:context'],
  }, (method, path, body) => {
    capturedAnchorAllocator = { method, path, body };
    return { ok: true, anchor_allocation: { task_key: body.task_key } };
  });
  ok('subconscious_anchor_allocator runs POST /subconscious/anchor',
    capturedAnchorAllocator && capturedAnchorAllocator.method === 'POST' && capturedAnchorAllocator.path === '/subconscious/anchor');
  ok('subconscious_anchor_allocator passes expected request shape',
    capturedAnchorAllocator &&
    capturedAnchorAllocator.body.session_id === 'foreground-session' &&
    capturedAnchorAllocator.body.companion_agent_id === 'companion-agent' &&
    capturedAnchorAllocator.body.task_key === 'local/task' &&
    capturedAnchorAllocator.body.parent_task_keys[0] === 'local/parent' &&
    capturedAnchorAllocator.body.context_task_keys[0] === 'note:context');
  ok('subconscious_anchor_allocator returns route output', anchorAllocatorOut && anchorAllocatorOut.anchor_allocation.task_key === 'local/task');

  const ideaSchedulerTool = TOOLS.find((t) => t.name === 'subconscious_idea_scheduler');
  ok('subconscious_idea_scheduler is on default MCP surface', !!ideaSchedulerTool);
  ok('subconscious_idea_scheduler schema exposes policy and anchor fields',
    ideaSchedulerTool &&
    ideaSchedulerTool.inputSchema.properties.agent_id &&
    ideaSchedulerTool.inputSchema.properties.idea &&
    ideaSchedulerTool.inputSchema.properties.approval_signals &&
    ideaSchedulerTool.inputSchema.properties.task_key &&
    ideaSchedulerTool.description.includes('requiring approval'));
  let capturedIdeaScheduler = null;
  const ideaSchedulerOut = await ideaSchedulerTool.run({
    action: 'schedule',
    workspace: '/tmp/ws',
    agent_id: 'daemon-agent',
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    task_key: 'local/task',
    source: 'daemon_loop',
    idea: 'Schedule a local context review for current task.',
    context_task_keys: ['note:context'],
    confidence: 0.6,
  }, (method, path, body) => {
    capturedIdeaScheduler = { method, path, body };
    return { ok: true, subconscious_idea: { idea: body.idea } };
  });
  ok('subconscious_idea_scheduler runs POST /subconscious/idea-scheduler',
    capturedIdeaScheduler && capturedIdeaScheduler.method === 'POST' && capturedIdeaScheduler.path === '/subconscious/idea-scheduler');
  ok('subconscious_idea_scheduler passes expected request shape',
    capturedIdeaScheduler &&
    capturedIdeaScheduler.body.agent_id === 'daemon-agent' &&
    capturedIdeaScheduler.body.session_id === 'foreground-session' &&
    capturedIdeaScheduler.body.task_key === 'local/task' &&
    capturedIdeaScheduler.body.context_task_keys[0] === 'note:context');
  ok('subconscious_idea_scheduler returns route output', ideaSchedulerOut && ideaSchedulerOut.subconscious_idea.idea === 'Schedule a local context review for current task.');

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
