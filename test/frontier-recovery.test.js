#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const SUITE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-frontier-recovery-')));
const previousOrchData = process.env.ORCH_DATA;
process.env.ORCH_DATA = path.join(SUITE_ROOT, 'runtime');

const daemon = require('../daemon');
const { ensureCurrentDaemon, probeDaemon, HEALTH_SIGNATURE } = require('../lib/daemon-handoff');
const githubAccount = require('../lib/github-account');
const graphRepo = require('../lib/graph-repo');
const { ensureManagedGraphLoop, managedGraphLoopId } = require('../lib/loop-autostart');

const LISTENER_SOURCE = String.raw`
  'use strict';
  const http = require('http');
  const head = process.env.FIXTURE_HEAD;
  const build = 'git:' + head;
  const signature = process.env.FIXTURE_SIGNATURE;
  const body = () => ({ ok: true, phase: 'ready', head, build, version: 'fixture', pid: process.pid, bootedAt: new Date().toISOString() });
  const server = http.createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/version') { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-zonoid-health-signature', signature);
    res.end(JSON.stringify(body()));
  });
  server.listen(Number(process.env.ORCH_PORT), '127.0.0.1');
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
`;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function spawnListener(port, head) {
  return spawn(process.execPath, ['-e', LISTENER_SOURCE], {
    env: {
      ...process.env,
      ORCH_PORT: String(port),
      FIXTURE_HEAD: head,
      FIXTURE_SIGNATURE: HEALTH_SIGNATURE,
    },
    stdio: 'ignore',
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function makeLoopContext() {
  const loops = new Map();
  return {
    loops,
    now: () => Date.now(),
    newLoop: (over = {}) => ({
      id: null,
      active: false,
      iterations: 0,
      spent: 0,
      baseline: 0,
      real: false,
      startedAt: null,
      lastProgress: null,
      session: null,
      workspace: null,
      managed: null,
      config: {
        tokenBudget: 100000,
        maxIterations: 200,
        minPoll: 30,
        maxPoll: 1200,
        estPerTick: 800,
        batch: 8,
        maxConcurrency: 10,
        judgeParallelCap: 6,
      },
      ...over,
    }),
  };
}

test('stale daemon, inactive owner credentials, and zombie capacity recover as one autonomous path', async (t) => {
  const port = await freePort();
  const pidFile = path.join(SUITE_ROOT, 'daemon.pid');
  const lockFile = path.join(SUITE_ROOT, 'daemon-handoff.lock');
  const currentHead = git(path.join(__dirname, '..'), ['rev-parse', 'HEAD']);
  const oldHead = `stale-${currentHead.slice(0, 12)}`;
  const oldChild = spawnListener(port, oldHead);
  let currentChild = null;
  t.after(async () => {
    daemon.__setAgentsForTest({});
    await stopChild(currentChild);
    await stopChild(oldChild);
  });

  const oldObservation = await waitFor(async () => {
    const observed = await probeDaemon({ port, timeoutMs: 200 });
    return observed.ready ? observed : null;
  });
  assert.ok(oldObservation, 'the old-head fixture must own the test port');
  assert.equal(oldObservation.head, oldHead);
  fs.writeFileSync(pidFile, String(oldChild.pid));

  const handoff = await ensureCurrentDaemon({
    port,
    pidFile,
    lockFile,
    expectedIdentity: { head: currentHead, build: `git:${currentHead}` },
    spawnDaemon: () => {
      currentChild = spawnListener(port, currentHead);
      return currentChild;
    },
    healthTimeoutMs: 200,
    handoffTimeoutMs: 2500,
    startupTimeoutMs: 4000,
    pollMs: 20,
  });

  assert.equal(handoff.ok, true);
  assert.equal(handoff.action, 'replaced');
  const currentObservation = await probeDaemon({ port, timeoutMs: 300 });
  assert.equal(currentObservation.ready, true);
  assert.equal(currentObservation.head, currentHead, 'health identity must match the feature head');
  assert.equal(currentObservation.build, `git:${currentHead}`);
  assert.equal(currentObservation.pid, currentChild.pid);
  assert.notEqual(currentObservation.pid, oldChild.pid);
  assert.ok(await waitFor(() => oldChild.exitCode !== null || oldChild.signalCode !== null), 'old listener must exit');

  const workspace = path.join(SUITE_ROOT, 'workspace');
  const graphDir = path.join(workspace, '.graph');
  const bareRemote = path.join(SUITE_ROOT, 'graph-remote.git');
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bareRemote], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch', 'main', graphDir], { stdio: 'ignore' });
  git(graphDir, ['config', 'user.name', 'Recovery Test']);
  git(graphDir, ['config', 'user.email', 'recovery@example.test']);
  fs.writeFileSync(path.join(graphDir, 'state.jsonl'), '{"seed":true}\n');
  git(graphDir, ['add', 'state.jsonl']);
  git(graphDir, ['commit', '-m', 'seed graph']);

  const owner = 'repo-owner';
  const graphRemote = `https://github.com/${owner}/widgets-graph.git`;
  const productRemote = `git@github.com:${owner}/widgets.git`;
  git(graphDir, ['remote', 'add', 'origin', graphRemote]);
  fs.appendFileSync(path.join(graphDir, 'state.jsonl'), '{"ready":true}\n');

  const gitConfig = path.join(SUITE_ROOT, 'gitconfig');
  fs.writeFileSync(gitConfig, `[url "file://${bareRemote}"]\n\tinsteadOf = ${graphRemote}\n`);
  const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const originalGhToken = process.env.GH_TOKEN;
  let activeAccount = 'normal-user';
  const credentialRequests = [];
  const fakeGh = async (args) => {
    credentialRequests.push(args);
    assert.equal(activeAccount, 'normal-user');
    return 'owner-token-fixture\n';
  };
  // Install the local transport only after graphRepo has read the original GitHub URL and asked
  // for its owner credential. The returned scope snapshots these variables for fetch/push.
  const fakeGraphGh = async (args) => {
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    return fakeGh(args);
  };

  try {
    const productScope = await githubAccount.scopeForRemote(productRemote, { runGh: fakeGh });
    assert.equal(productScope.owner, owner);
    const flushed = await graphRepo.flush(workspace, {
      push: true,
      retries: 0,
      githubAccount: { runGh: fakeGraphGh },
    });
    assert.equal(flushed.status, 'pushed');
    assert.equal(git(bareRemote, ['rev-parse', 'refs/heads/main']), flushed.commit);
  } finally {
    if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
  }
  assert.equal(activeAccount, 'normal-user', 'credential scoping must not switch the active account');
  assert.equal(process.env.GH_TOKEN, originalGhToken, 'credential scoping must not leak into process env');
  assert.deepEqual(credentialRequests, [
    ['auth', 'token', '--hostname', 'github.com', '--user', owner],
    ['auth', 'token', '--hostname', 'github.com', '--user', owner],
  ]);

  const loopCtx = makeLoopContext();
  const managedId = managedGraphLoopId(workspace);
  const legacy = loopCtx.newLoop({
    id: 'legacy-random-owner',
    active: true,
    workspace,
    managed: 'graph',
  });
  loopCtx.loops.set(legacy.id, legacy);
  const overlay = {
    config: { automode: true, self_plan: true },
    assignee: { 'codex/zombie': 'dead-agent' },
    blocked: {},
    unwired: {},
    reviews: {},
    git: { 'codex/already-merged': { merged: true } },
    snapshots: {
      'followup/harness-judge-drain': { status: 'pending', metadata: { harness: true } },
      'codex/already-merged': { status: 'completed', metadata: {} },
    },
  };
  const graph = { tasks: [
    { id: 'codex/zombie', label: 'Zombie worker', status: 'in_progress', deps: [] },
    { id: 'followup/harness-judge-drain', label: 'Internal judge drain', status: 'ready', deps: [] },
    { id: 'codex/already-merged', label: 'Terminal stale row', status: 'ready', deps: [] },
    { id: 'codex/harmless-ready', label: 'Harmless fixture task', status: 'ready', deps: [] },
  ] };
  daemon.__setAgentsForTest({
    'dead-agent': { agent_id: 'dead-agent', state: 'dead', endedAt: '2026-06-20T00:00:00.000Z' },
  });

  const firstEnsure = ensureManagedGraphLoop({ ctx: loopCtx, workspace, graph, overlay });
  const secondEnsure = ensureManagedGraphLoop({ ctx: loopCtx, workspace, graph, overlay });
  assert.equal(firstEnsure.created, true);
  assert.equal(secondEnsure.created, false);
  assert.equal(overlay.config.automode, true);
  assert.equal(overlay.config.self_plan, true);
  assert.equal(overlay.config.headless_driver, true, 'legacy partial autonomy must repair the daemon executor');
  assert.equal(overlay.frontier_liveness.status, 'active');
  assert.equal(overlay.frontier_liveness.managed_loop_id, managedId);
  assert.equal(legacy.active, false, 'legacy duplicate owner must be retired');
  assert.equal(
    [...loopCtx.loops.values()].filter((loop) => loop.active && loop.managed === 'graph' && loop.workspace === workspace).length,
    1,
    'exactly one managed workspace loop may remain active'
  );

  const decision = daemon.decideOne(loopCtx.loops.get(managedId), {
    ws: workspace,
    ov: overlay,
    graph,
    pendingGuidance: [],
    reviewPending: 0,
    batch: { remaining: 1 },
  });
  assert.equal(decision.action, 'spawn', 'a stale worker row must not suppress forward progress');
  assert.deepEqual(decision.tasks, [
    { key: 'codex/harmless-ready', label: 'Harmless fixture task' },
  ], 'only legitimate, non-terminal, non-internal work may advance');
});

test('a drained self-plan frontier retains its owner and reaches the bounded planner action', () => {
  const workspace = path.join(SUITE_ROOT, 'drained-self-plan-workspace');
  const loopCtx = makeLoopContext();
  const overlay = {
    config: { automode: true, self_plan: true, headless_driver: true },
    blocked: { 'codex/guidance-held': { reason: 'requires user guidance' } },
    unwired: {}, reviews: {},
    git: { 'codex/already-landed': { merged: true } },
    snapshots: {},
  };
  const graph = { tasks: [
    { id: 'codex/guidance-held', label: 'Guidance held', status: 'ready', deps: [] },
    { id: 'codex/already-landed', label: 'Already landed', status: 'ready', deps: [] },
  ] };

  const ensured = ensureManagedGraphLoop({ ctx: loopCtx, workspace, graph, overlay });
  const managedId = managedGraphLoopId(workspace);
  const decision = daemon.decideOne(loopCtx.loops.get(managedId), {
    ws: workspace,
    ov: overlay,
    graph,
    pendingGuidance: [],
    reviewPending: 0,
    batch: { remaining: 1 },
  });

  assert.equal(ensured.created, true);
  assert.equal(decision.action, 'plan');
  assert.match(decision.reason, /DAG drained/);
  assert.equal(
    [...loopCtx.loops.values()].filter((loop) => loop.active && loop.managed === 'graph' && loop.workspace === workspace).length,
    1,
    'a drained self-plan frontier must have exactly one canonical owner'
  );
});

test.after(() => {
  if (previousOrchData === undefined) delete process.env.ORCH_DATA;
  else process.env.ORCH_DATA = previousOrchData;
  fs.rmSync(SUITE_ROOT, { recursive: true, force: true });
  // Importing daemon.js starts the unref'd embedding sidecar. Match the existing graph-loop
  // integration harness and let the test runner finish cleanly once every assertion has settled.
  setImmediate(() => process.exit(process.exitCode || 0));
});
