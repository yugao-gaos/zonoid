#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const { checkDaemon, startWorkspaceOnboarding } = require('../packages/cli/bin/zonoid');
const onboardRoute = require('../routes/onboard');

const DAEMON_PATH = path.join(__dirname, '..', 'daemon.js');
const CLI_PATH = path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js');
const GIT_MINER_PATH = path.join(__dirname, '..', 'scripts', 'onboard-mine-git.js');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function testPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

async function daemonRequest(port, method, route, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* response body is diagnostic only */ }
  return { status: response.status, payload, headers: response.headers };
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

async function waitForHealthResponse(port, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await daemonRequest(port, 'GET', '/health');
      if (response.status === 200) return true;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function stopDaemon(port) {
  try {
    const version = await daemonRequest(port, 'GET', '/version');
    const pid = Number(version.payload && version.payload.pid);
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGTERM');
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { return; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } catch { /* daemon already stopped */ }
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for onboarding state');
}

function runFullInit(repo, dataDir, homeDir, port, daemonDeps = {}) {
  const source = `
    const { init } = require(${JSON.stringify(CLI_PATH)});
    init({
      harnesses: ['cursor'],
      daemonDeps: JSON.parse(process.env.INIT_DAEMON_DEPS),
    }).then(() => {
      console.log('FULL_INIT_OK');
    }).catch((err) => {
      console.error('FULL_INIT_FAILURE ' + (err && err.message || err));
      process.exitCode = 1;
    });
  `;
  return spawnSync(process.execPath, ['-e', source], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CODE_SESSION_ID: '',
      ORCH_PORT: String(port),
      ORCH_TOKEN: '',
      INIT_DAEMON_DEPS: JSON.stringify({ port, ...daemonDeps }),
    },
  });
}

function prepareInitRepo(prefix) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(fixtureDir, 'repo');
  const dataDir = path.join(fixtureDir, 'data');
  const homeDir = path.join(fixtureDir, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(homeDir);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  return { fixtureDir, repo, dataDir, homeDir };
}

async function runHeadlessPreparation(repo, outDir) {
  const savedLease = process.env.HEADLESS_DRAIN_GLOBAL_LEASE;
  process.env.HEADLESS_DRAIN_GLOBAL_LEASE = '0';
  try {
    const modulePath = require.resolve('../lib/headless-drain');
    delete require.cache[modulePath];
    const headlessDrain = require('../lib/headless-drain');
    const result = await headlessDrain.runDueDrains(
      { workspace: repo, registeredWorkspaces: [repo] },
      null,
      {
        judgeDeps: {
          overlayLoad: () => ({}),
          judgeLib: { judgeQueueDepth: () => 0, eagerJudgeNodes: () => [], buildQueue: () => [] },
        },
        labelDeps: {
          readJsonl: () => [], rowKey: () => '', journalPath: () => '', labeledPath: () => '',
        },
      }
    );
    const preparation = result.drains.find((entry) => entry.operation === 'preparation' && entry.outDir === outDir);
    assert.ok(preparation, `headless worker did not prepare ${outDir}: ${JSON.stringify(result)}`);
    assert.equal(preparation.exitCode, 0);
    return result;
  } finally {
    if (savedLease === undefined) delete process.env.HEADLESS_DRAIN_GLOBAL_LEASE;
    else process.env.HEADLESS_DRAIN_GLOBAL_LEASE = savedLease;
  }
}

function routePost(calls) {
  return async (route, body) => {
    const call = { route, body };
    calls.push(call);
    let response = null;
    const handler = onboardRoute({
      readBody: async () => body,
      send: (_res, status, payload) => { response = { status, payload }; },
      notifyChange: () => {},
      registeredWorkspaces: () => new Set([body.repo]),
    });
    const handled = await handler(route, 'POST', {}, {}, new URL(`http://localhost${route}`));
    assert.equal(handled, true);
    assert.ok(response);
    call.response = response;
    return response.payload;
  };
}

test('init lifecycle arms onboarding without a dashboard and leaves accumulated project work untouched', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auto-onboard-'));
  const source = path.join(repo, 'src', 'feature.js');
  const sourceBody = 'module.exports = function accumulatedWork() { return 42; };\n';
  const calls = [];

  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, sourceBody);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Existing project\n\nSeveral work sessions already happened here.\n');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'existing-project', version: '1.0.0' }, null, 2));
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'test']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'accumulated project work']);
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const statusBefore = git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);

    const startedAt = Date.now();
    const result = await startWorkspaceOnboarding(repo, {
      post: routePost(calls),
    });

    assert.equal(result.ok, true);
    assert.ok(Date.now() - startedAt < 2000, 'CLI onboarding startup must only persist and arm work');
    assert.deepEqual(calls.map((call) => call.route), ['/onboard/enqueue', '/onboard/drain-queue']);
    assert.deepEqual(calls[0].body, { repo });
    assert.equal(calls[1].body.repo, repo);
    assert.equal(calls[1].body.autoInject, true);
    assert.equal(calls[1].body.liveInject, true);
    assert.equal(calls[0].response.payload.preparationState, 'pending');
    assert.equal(calls[1].response.payload.status.preparationState, 'pending');
    assert.equal(fs.existsSync(path.join(result.outDir, 'onboard-queue.json')), false,
      'enqueue must return before miners run');
    const pending = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(pending.preparationState, 'pending', 'restart-safe preparation intent must be persisted before return');

    await runHeadlessPreparation(repo, result.outDir);
    const queue = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-queue.json'), 'utf8'));
    const status = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.ok(queue.total > 0, 'existing project content must be mined before any dashboard opens');
    assert.equal(status.repo, repo);
    assert.equal(status.autoInject, true);
    assert.equal(status.preparationState, 'ready');
    assert.equal(fs.readFileSync(source, 'utf8'), sourceBody);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(repo, ['status', '--porcelain=v1', '--untracked-files=all']), statusBefore,
      'workspace-local onboarding metadata must not dirty project status');
    assert.equal(git(repo, ['diff', '--', 'src/feature.js']), '');

    const cliSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js'), 'utf8');
    const readyAt = cliSource.indexOf('const daemonReady = await checkDaemon(daemonDeps);');
    const registerAt = cliSource.indexOf('const registeredRepo = await registerWorkspace(cwd, opts.workspace, daemonDeps);');
    const onboardAt = cliSource.indexOf('if (registeredRepo) await startWorkspaceOnboarding(registeredRepo, daemonDeps);');
    assert.ok(readyAt >= 0 && registerAt > readyAt && onboardAt > registerAt,
      'init must verify the daemon before registering and arm onboarding immediately afterward');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('onboarding startup failure is advisory and does not mutate project files', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auto-onboard-fail-'));
  const source = path.join(repo, 'work.txt');
  try {
    fs.writeFileSync(source, 'valuable existing work\n');
    const result = await startWorkspaceOnboarding(repo, {
      post: async () => { throw new Error('daemon unavailable'); },
    });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(source, 'utf8'), 'valuable existing work\n');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('empty and zero-commit projects onboard without inventing project history', async () => {
  const repos = [
    { label: 'empty directory', path: fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auto-onboard-empty-')), empty: true },
    { label: 'zero-commit git repo', path: fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auto-onboard-zero-commit-')), empty: false },
  ];

  try {
    git(repos[1].path, ['init']);
    const zeroCommitSource = path.join(repos[1].path, 'src', 'uncommitted.js');
    fs.mkdirSync(path.dirname(zeroCommitSource), { recursive: true });
    fs.writeFileSync(zeroCommitSource, 'exports.uncommittedWork = true;\n');
    fs.writeFileSync(path.join(repos[1].path, 'README.md'), '# Zero-commit project\n\nUseful work exists before the first commit.\n');
    for (const repoCase of repos) {
      const statusBefore = repoCase.empty ? null : git(repoCase.path, ['status', '--porcelain=v1', '--untracked-files=all']);
      const calls = [];
      const result = await startWorkspaceOnboarding(repoCase.path, {
        post: routePost(calls),
      });

      assert.equal(result.ok, true, `${repoCase.label} should onboard without an HTTP 500`);
      assert.deepEqual(calls.map((call) => call.route), ['/onboard/enqueue', '/onboard/drain-queue']);
      assert.equal(fs.existsSync(path.join(result.outDir, 'onboard-queue.json')), false);
      assert.equal(calls[1].response.payload.status.preparing, true);
      await runHeadlessPreparation(repoCase.path, result.outDir);
      const queue = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-queue.json'), 'utf8'));
      const status = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-drain-status.json'), 'utf8'));
      assert.equal(status.error, null);
      assert.equal(status.preparationState, 'ready');
      if (repoCase.empty) {
        assert.deepEqual(
          { total: queue.total, cursor: queue.cursor, kept: queue.kept, rejected: queue.rejected, pending: queue.pending },
          { total: 0, cursor: 0, kept: [], rejected: [], pending: [] }
        );
        assert.match(queue.generation, /^onboard-[a-f0-9]+$/);
      } else {
        assert.ok(queue.total > 0, 'non-git miners must retain useful zero-commit project evidence');
        assert.equal(git(repoCase.path, ['status', '--porcelain=v1', '--untracked-files=all']), statusBefore,
          'zero-commit project status must be unchanged apart from ignored runtime metadata');
      }
    }

    assert.equal(fs.readFileSync(zeroCommitSource, 'utf8'), 'exports.uncommittedWork = true;\n');
    assert.throws(() => git(repos[1].path, ['rev-parse', '--verify', 'HEAD']), /Command failed/,
      'onboarding must not manufacture a commit in a zero-commit repo');
  } finally {
    for (const repoCase of repos) fs.rmSync(repoCase.path, { recursive: true, force: true });
  }
});

test('cold daemon startup is non-blocking and waits until the daemon is ready', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-cold-daemon-'));
  const port = await testPort();
  const startedAt = Date.now();
  try {
    const ready = await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
      },
    });
    assert.equal(ready, true);
    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload && health.payload.phase, 'ready');
    assert.equal(health.headers.get('x-zonoid-health-signature'), 'zonoid-orchestrator-health-v1');
    assert.ok(Date.now() - startedAt < 15000, 'cold startup must return instead of waiting on the detached daemon process');
  } finally {
    await stopDaemon(port);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('full init rejects a real HTTP impostor without sending mutations or terminating it', async () => {
  const fixture = prepareInitRepo('zonoid-impostor-init-');
  const port = await testPort();
  const requestLog = path.join(fixture.fixtureDir, 'requests.log');
  const impostorSource = `
    const http = require('node:http');
    const fs = require('node:fs');
    const server = http.createServer((req, res) => {
      fs.appendFileSync(process.env.IMPOSTOR_REQUEST_LOG, req.method + ' ' + req.url + '\\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, phase: 'ready' }));
    });
    server.listen(Number(process.env.IMPOSTOR_PORT), '127.0.0.1');
  `;
  const impostor = spawn(process.execPath, ['-e', impostorSource], {
    env: { ...process.env, IMPOSTOR_PORT: String(port), IMPOSTOR_REQUEST_LOG: requestLog },
    stdio: 'ignore',
  });
  try {
    assert.ok(await waitForHealthResponse(port), 'impostor process came up');
    assert.equal(await checkDaemon({
      port,
      startupTimeoutMs: 250,
      healthTimeoutMs: 50,
      pollMs: 25,
    }), false, 'generic HTTP 200 must not be accepted as Zonoid readiness');

    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      startupTimeoutMs: 250,
      healthTimeoutMs: 50,
      pollMs: 25,
    });
    assert.notEqual(client.status, 0, client.stdout || client.stderr);
    assert.match(`${client.stdout}\n${client.stderr}`, /Initialization aborted: no verified Zonoid daemon is ready/);
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(requests.some((request) => request === 'POST /workspace'), false,
      `unsigned service must not receive workspace registration: ${requests.join(', ')}`);
    assert.equal(requests.some((request) => request.startsWith('POST /onboard/')), false,
      `unsigned service must not receive onboarding mutations: ${requests.join(', ')}`);
    assert.equal(processIsAlive(impostor.pid), true, 'init must not terminate an independently running process');
  } finally {
    if (processIsAlive(impostor.pid)) impostor.kill('SIGKILL');
    await waitForProcessExit(impostor.pid);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('full init aborts against an unresponsive service without sending mutations', async () => {
  const fixture = prepareInitRepo('zonoid-unresponsive-init-');
  const port = await testPort();
  const requestLog = path.join(fixture.fixtureDir, 'requests.log');
  const readyFile = path.join(fixture.fixtureDir, 'ready');
  const serviceSource = `
    const http = require('node:http');
    const fs = require('node:fs');
    const server = http.createServer((req, res) => {
      fs.appendFileSync(process.env.SERVICE_REQUEST_LOG, req.method + ' ' + req.url + '\\n');
      if (req.url === '/health') return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, outDir: process.cwd(), status: {} }));
    });
    server.listen(Number(process.env.SERVICE_PORT), '127.0.0.1', () => {
      fs.writeFileSync(process.env.SERVICE_READY_FILE, 'ready');
    });
  `;
  const service = spawn(process.execPath, ['-e', serviceSource], {
    env: {
      ...process.env,
      SERVICE_PORT: String(port),
      SERVICE_REQUEST_LOG: requestLog,
      SERVICE_READY_FILE: readyFile,
    },
    stdio: 'ignore',
  });

  try {
    await waitFor(() => fs.existsSync(readyFile), 2000);
    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      startupTimeoutMs: 250,
      healthTimeoutMs: 50,
      pollMs: 25,
    });
    assert.notEqual(client.status, 0, client.stdout || client.stderr);
    assert.match(`${client.stdout}\n${client.stderr}`, /Initialization aborted: no verified Zonoid daemon is ready/);
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(requests.some((request) => request === 'POST /workspace'), false,
      `unresponsive service must not receive workspace registration: ${requests.join(', ')}`);
    assert.equal(requests.some((request) => request.startsWith('POST /onboard/')), false,
      `unresponsive service must not receive onboarding mutations: ${requests.join(', ')}`);
    assert.equal(processIsAlive(service.pid), true, 'init must not terminate an independently running process');
  } finally {
    if (processIsAlive(service.pid)) service.kill('SIGKILL');
    await waitForProcessExit(service.pid);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('daemon readiness timeout terminates only the hung child it spawned', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-hung-child-'));
  const daemonPath = path.join(fixtureDir, 'hung-daemon.js');
  const pidFile = path.join(fixtureDir, 'hung-daemon.pid');
  const port = await testPort();
  fs.writeFileSync(daemonPath, `
    'use strict';
    const fs = require('node:fs');
    fs.writeFileSync(process.env.HUNG_DAEMON_PID_FILE, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `);

  let pid = null;
  try {
    assert.equal(await checkDaemon({
      port,
      daemonPath,
      startupTimeoutMs: 400,
      healthTimeoutMs: 50,
      pollMs: 25,
      childCleanupGraceMs: 100,
      env: { ...process.env, HUNG_DAEMON_PID_FILE: pidFile },
    }), false);
    assert.ok(fs.existsSync(pidFile), 'the owned hung child must have started');
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(await waitForProcessExit(pid), true, 'timeout must reap the exact child spawned by this invocation');
  } finally {
    if (pid && processIsAlive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('token-authenticated init registers the workspace and queues onboarding', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auth-daemon-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auth-init-'));
  const token = 'onboarding-init-token';
  const port = await testPort();
  fs.writeFileSync(path.join(dataDir, 'token'), `${token}\n`);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Token protected project\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'token-protected-project', version: '1.0.0' }));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'module.exports = () => "ready";\n');
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'initial project']);

  try {
    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '10',
        HEADLESS_DRAIN_CONTINUOUS_DELAY_MS: '50',
      },
    }), true);
    assert.equal((await daemonRequest(port, 'POST', '/workspace', { path: repo })).status, 401,
      'the test daemon must actually reject unauthenticated init mutations');

    const clientSource = `
      const cli = require(${JSON.stringify(CLI_PATH)});
      (async () => {
        const repo = await cli.registerWorkspace(process.env.CLIENT_REPO);
        const onboarding = repo ? await cli.startWorkspaceOnboarding(repo) : null;
        console.log('CLI_INIT_RESULT ' + JSON.stringify({ repo, onboarding }));
        if (!repo || !onboarding || !onboarding.ok) process.exitCode = 1;
      })().catch((err) => { console.error(err); process.exitCode = 1; });
    `;
    const clientStartedAt = Date.now();
    const client = spawnSync(process.execPath, ['-e', clientSource], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        ORCH_PORT: String(port),
        ORCH_TOKEN: '',
        CLIENT_REPO: repo,
      },
    });
    assert.equal(client.status, 0, client.stderr || client.stdout);
    assert.ok(Date.now() - clientStartedAt < 3000, 'CLI init must not wait for repository mining');
    const resultLine = String(client.stdout || '').split(/\r?\n/).find((line) => line.startsWith('CLI_INIT_RESULT '));
    assert.ok(resultLine, `missing CLI init result in output:\n${client.stdout}`);
    const result = JSON.parse(resultLine.slice('CLI_INIT_RESULT '.length));
    assert.equal(result.repo, repo);
    assert.equal(result.onboarding.ok, true);

    const workspaces = await daemonRequest(port, 'GET', '/workspaces', undefined, token);
    assert.equal(workspaces.status, 200);
    assert.match(JSON.stringify(workspaces.payload), new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const healthStartedAt = Date.now();
    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.ok(Date.now() - healthStartedAt < 1000, 'daemon health must stay responsive while onboarding runs');
    await waitFor(() => fs.existsSync(path.join(result.onboarding.outDir, 'onboard-queue.json')));
    const prepared = JSON.parse(fs.readFileSync(path.join(result.onboarding.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(prepared.preparationState, 'ready');
  } finally {
    await stopDaemon(port);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('daemon boot resumes a persisted preparation request created before the daemon existed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-onboard-restart-data-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-onboard-restart-repo-'));
  const port = await testPort();
  let response = null;
  try {
    const handler = onboardRoute({
      readBody: async () => ({ repo }),
      send: (_res, status, payload) => { response = { status, payload }; },
      notifyChange: () => {},
      registeredWorkspaces: () => new Set([repo]),
    });
    await handler('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.equal(response.status, 200);
    const outDir = response.payload.outDir;
    assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8')).preparationState, 'pending');
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-queue.json')), false);

    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '10',
        HEADLESS_DRAIN_CONTINUOUS_DELAY_MS: '50',
      },
    }), true);
    assert.equal((await daemonRequest(port, 'POST', '/workspace', { path: repo })).status, 200);
    await waitFor(() => fs.existsSync(path.join(outDir, 'onboard-queue.json')));
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.preparationState, 'ready');
    const queue = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8'));
    assert.deepEqual(
      { total: queue.total, cursor: queue.cursor, kept: queue.kept, rejected: queue.rejected, pending: queue.pending },
      { total: 0, cursor: 0, kept: [], rejected: [], pending: [] }
    );
    assert.match(queue.generation, /^onboard-[a-f0-9]+$/);
  } finally {
    await stopDaemon(port);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('Git miner treats unborn history as empty but reports corrupted Git metadata', () => {
  const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-git-miner-unborn-'));
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-git-miner-broken-'));
  try {
    git(unborn, ['init']);
    const unbornOut = path.join(unborn, 'runtime');
    const unbornRun = spawnSync(process.execPath, [GIT_MINER_PATH, '--repo', unborn, '--out', unbornOut], { encoding: 'utf8' });
    assert.equal(unbornRun.status, 0, unbornRun.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(unbornOut, 'git-notes.json'), 'utf8')), []);

    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: missing-git-directory\n');
    const brokenOut = path.join(broken, 'runtime');
    const brokenRun = spawnSync(process.execPath, [GIT_MINER_PATH, '--repo', broken, '--out', brokenOut], { encoding: 'utf8' });
    assert.notEqual(brokenRun.status, 0, 'broken Git metadata must not be reported as a successful empty history');
    assert.match(brokenRun.stderr, /git rev-parse .* failed/i);
    assert.equal(fs.existsSync(path.join(brokenOut, 'git-notes.json')), false);
  } finally {
    fs.rmSync(unborn, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});
