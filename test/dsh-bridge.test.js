'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DSH_TOOL_NAMES } = require('../lib/mcp/client-profile');
const { TOOLS, handleRpc } = require('../lib/mcp-core');

const root = path.resolve(__dirname, '..');

function fakeRelay(handler) {
  const calls = [];
  return {
    calls,
    async get(pathname) {
      calls.push({ method: 'GET', pathname });
      return handler ? handler('GET', pathname) : {};
    },
    async post(pathname, body) {
      calls.push({ method: 'POST', pathname, body });
      return handler ? handler('POST', pathname, body) : {};
    },
  };
}

async function bridgeModules() {
  return {
    ...(await import('../packages/dsh/lib/bridge.mjs')),
    ...(await import('../packages/dsh/lib/gate.mjs')),
  };
}

function agent(workspace, id = 'dsh-session-1') {
  const injected = [];
  return { id, session: { id, header: { cwd: workspace } }, injected, inject(message) { injected.push(message); } };
}

test('DSH MCP identity advertises only the routine worker surface', async () => {
  const listed = await handleRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { client: 'dsh', call: () => ({}) },
  );
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), DSH_TOOL_NAMES);
  assert.ok(listed.result.tools.length < TOOLS.length);
  assert.ok(listed.result.tools.some((tool) => tool.name === 'subconscious_assignment'));
  assert.ok(!listed.result.tools.some((tool) => tool.name === 'merge_attempt'));
  assert.ok(!listed.result.tools.some((tool) => tool.name === 'submit_judge_verdict'));

  const refused = await handleRpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'merge_attempt', arguments: { task_key: 'x' } } },
    { client: 'dsh', call: () => ({}) },
  );
  assert.equal(refused.error.code, -32602);
  assert.match(refused.error.message, /unknown tool/);

  const baseline = await handleRpc(
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { call: () => ({}) },
  );
  assert.equal(baseline.result.tools.length, TOOLS.length, 'non-DSH clients keep the existing surface');

  const previousClient = process.env.ORCH_CLIENT;
  process.env.ORCH_CLIENT = 'dsh';
  try {
    const stdioProfile = await handleRpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { call: () => ({}) },
    );
    assert.deepEqual(stdioProfile.result.tools.map((tool) => tool.name), DSH_TOOL_NAMES);
  } finally {
    if (previousClient == null) delete process.env.ORCH_CLIENT;
    else process.env.ORCH_CLIENT = previousClient;
  }
});

test('Cordis lifecycle relays canonical workspace, one start, context, ready, and one finish', async () => {
  const { createBridge } = await bridgeModules();
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dsh-bridge-')));
  const dshAgent = agent(workspace);
  const relay = fakeRelay((method, pathname) => {
    if (method === 'POST' && pathname === '/classify') return { additional_context: '[Zonoid] claimed context' };
    return {};
  });
  const bridge = createBridge({ relay });

  await Promise.all([bridge.ensureStarted(dshAgent), bridge.ensureStarted(dshAgent)]);
  assert.equal(relay.calls.filter((call) => call.pathname === '/agent/start').length, 1);
  assert.deepEqual(relay.calls.find((call) => call.pathname === '/workspace').body, { path: workspace });
  assert.deepEqual(relay.calls.find((call) => call.pathname === '/agent/start').body, {
    agent_id: 'dsh-session-1',
    agent_type: 'dsh',
    session: 'dsh-session-1',
    workspace,
  });
  await bridge.sessionStart(dshAgent);
  await bridge.sessionStart(dshAgent);
  assert.equal(dshAgent.injected.length, 1, 'session identity is injected exactly once');
  assert.match(dshAgent.injected[0].content[0].text, /session_id "dsh-session-1"/);
  assert.match(dshAgent.injected[0].content[0].text, /prepared assignment/);

  const original = {
    id: 'prompt-1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'implement the bridge' }],
  };
  const decision = await bridge.preStep(
    { agent: dshAgent, messages: [original], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [original] }),
  );
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[1].source.kind, 'plugin');
  assert.equal(decision.messages[1].source.plugin, '@zonoid/dsh');
  assert.equal(decision.messages[1].content[0].text, '[Zonoid] claimed context');
  assert.deepEqual(relay.calls.find((call) => call.pathname === '/classify').body, {
    prompt: 'implement the bridge',
    session_id: 'dsh-session-1',
    workspace,
  });

  await bridge.nudge(dshAgent);
  assert.ok(relay.calls.some((call) => call.method === 'GET' && call.pathname.startsWith('/ready?')));
  await bridge.agentDisposed(dshAgent);
  await bridge.close();
  assert.equal(relay.calls.filter((call) => call.pathname === '/agent/done').length, 1);
});

test('native plugin registers the pinned Cordis seams and returns an awaited disposer', async () => {
  const plugin = await import('../packages/dsh/index.mjs');
  const handlers = new Map();
  let dispose = null;
  const ctx = {
    on(event, handler) { handlers.set(event, handler); },
    effect(factory) { dispose = factory(); },
  };
  plugin.apply(ctx, {
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  for (const event of [
    'session/created', 'agent/created', 'agent/session-start', 'agent/pre-step',
    'tools/pre-execute', 'tools/result', 'session/flush', 'agent/disposed', 'session/disposed',
  ]) {
    assert.equal(typeof handlers.get(event), 'function', `missing ${event} relay`);
  }
  assert.equal(typeof dispose, 'function');
  const teardown = dispose();
  assert.equal(typeof teardown?.then, 'function', 'Cordis teardown receives the bridge close promise');
  await teardown;
});

test('pre-tool stop and write claim decisions block before the tool body', async () => {
  const { createBridge } = await bridgeModules();
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dsh-stop-')));
  const dshAgent = agent(workspace, 'dsh-stop-session');
  let bodyCalls = 0;
  const stoppingRelay = fakeRelay((method, pathname) => {
    if (method === 'GET' && pathname.startsWith('/should-stop?')) return { stop: true, reason: 'user canceled' };
    return {};
  });
  const stopping = createBridge({ relay: stoppingRelay });
  const stopped = await stopping.preTool({
    name: 'read', arguments: { path: 'README.md' }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.deepEqual(stopped, { kind: 'deny', reason: 'orch-stop: user canceled' });
  assert.equal(bodyCalls, 0);

  const unclaimedRelay = fakeRelay((method, pathname) => {
    if (method === 'GET' && pathname.startsWith('/should-stop?')) return { stop: false };
    if (method === 'GET' && pathname.startsWith('/active-claim?')) return { claimed: false, claims: [] };
    return {};
  });
  const unclaimed = createBridge({ relay: unclaimedRelay });
  const denied = await unclaimed.preTool({
    name: 'write', arguments: { path: path.join(workspace, 'new.js'), content: 'x' }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /accept a prepared Subconscious assignment/);
  assert.equal(bodyCalls, 0);

  const shellDenied = await unclaimed.preTool({
    name: 'bash', arguments: { command: `printf x > ${path.join(workspace, 'shell.txt')}` }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.equal(shellDenied.kind, 'deny', 'shell writes use the same claim gate');
  assert.equal(bodyCalls, 0);

  const read = await unclaimed.preTool({
    name: 'read', arguments: { path: path.join(workspace, 'README.md') }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.deepEqual(read, { kind: 'allow' });
  assert.equal(bodyCalls, 1);

  const editorView = await unclaimed.preTool({
    name: 'str_replace_editor', arguments: { command: 'view', path: path.join(workspace, 'README.md') }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.deepEqual(editorView, { kind: 'allow' }, 'the editor view command remains read-only');
  assert.equal(bodyCalls, 2);
});

test('pre-tool write gate uses the claimed worker identity, not the DSH session identity', async () => {
  const { createBridge } = await bridgeModules();
  const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dsh-permit-')));
  const sessionId = 'dsh-permit-session';
  const agentId = 'prepared-worker';
  const taskKey = 'dsh/task';
  const permit = {
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    session_id: sessionId,
    agent_id: agentId,
    task_key: taskKey,
    branch: 'orch/attempt/dsh-task',
    worktree,
    allowed_paths: [worktree],
  };
  const relay = fakeRelay((method, pathname) => {
    if (pathname.startsWith('/should-stop?')) return { stop: false };
    if (pathname.startsWith('/active-claim?')) {
      return { claimed: true, claims: [{ key: taskKey, agent_id: agentId, workspace: worktree }] };
    }
    if (pathname.startsWith('/task/detail?')) return { task: { git: { branch: permit.branch, worktree } } };
    if (pathname.startsWith('/subconscious/permit?')) return { execution_permit: permit };
    return {};
  });
  const bridge = createBridge({ relay });
  const dshAgent = agent(worktree, sessionId);
  let bodyCalls = 0;

  const allowed = await bridge.preTool({
    name: 'write', arguments: { path: path.join(worktree, 'inside.js') }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.deepEqual(allowed, { kind: 'allow' });
  assert.equal(bodyCalls, 1);
  const permitLookup = relay.calls.find((call) => call.pathname.startsWith('/subconscious/permit?'));
  assert.equal(new URL(`http://localhost${permitLookup.pathname}`).searchParams.get('session_id'), sessionId);
  assert.equal(new URL(`http://localhost${permitLookup.pathname}`).searchParams.get('agent_id'), agentId);

  const outside = await bridge.preTool({
    name: 'write', arguments: { path: path.join(path.dirname(worktree), 'outside.js') }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.equal(outside.kind, 'deny');
  assert.match(outside.reason, /outside the assigned worktree/);
  assert.equal(bodyCalls, 1);

  const invalidRelay = fakeRelay((method, pathname) => {
    if (pathname.startsWith('/should-stop?')) return { stop: false };
    if (pathname.startsWith('/active-claim?')) return { claimed: true, claims: [{ key: taskKey, workspace: worktree }] };
    return {};
  });
  const invalidBridge = createBridge({ relay: invalidRelay });
  const invalid = await invalidBridge.preTool({
    name: 'write', arguments: { path: path.join(worktree, 'inside.js') }, agent: dshAgent,
    signal: new AbortController().signal,
  }, async () => { bodyCalls++; return { kind: 'allow' }; });
  assert.equal(invalid.kind, 'deny');
  assert.match(invalid.reason, /missing an authoritative agent identity/);
  assert.equal(bodyCalls, 1);
  assert.ok(!invalidRelay.calls.some((call) => call.pathname.startsWith('/subconscious/permit?')));
});

test('Cordis profile preserves the pinned blocking and teardown contract', () => {
  const profile = fs.readFileSync(path.join(root, 'packages', 'dsh', 'zonoid.cordis.patch.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'dsh', 'package.json'), 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh'], '0.1.1-rc.2');
  assert.match(profile, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(profile, /ORCH_CLIENT: dsh/);
  assert.match(profile, /ZONOID_DSH_MCP_ENTRY/);
  assert.match(profile, /failOnStartupError: true/);
  assert.match(profile, /reconnect:\s+enabled: false/);
  assert.match(profile, /name: '@zonoid\/dsh'/);
  assert.ok(rootPkg.files.includes('packages/dsh/'));
});
