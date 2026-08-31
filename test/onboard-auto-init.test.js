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
const onboardInitTransaction = require('../lib/onboard-init-transaction');
const workspaceRegistry = require('../lib/workspace-registry');

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
      const deadline = Date.now() + 7000;
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

function runFullInit(repo, dataDir, homeDir, port, daemonDeps = {}, initOpts = {}) {
  const source = `
    const { init } = require(${JSON.stringify(CLI_PATH)});
    init({
      harnesses: ['cursor'],
      ...JSON.parse(process.env.INIT_OPTS),
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
    timeout: 60000,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_CODE_SESSION_ID: '',
      ORCH_PORT: String(port),
      ORCH_TOKEN: '',
      INIT_DAEMON_DEPS: JSON.stringify({ port, ...daemonDeps }),
      INIT_OPTS: JSON.stringify(initOpts),
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
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Existing project\n');
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'module.exports = () => 42;\n');
  git(repo, ['add', 'README.md', 'src/index.js']);
  git(repo, ['commit', '-m', 'existing project']);
  fs.writeFileSync(path.join(repo, 'work-in-progress.txt'), 'valuable uncommitted work\n');
  fs.mkdirSync(path.join(homeDir, '.config'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'user-preference'), 'preserve me\n');
  fs.writeFileSync(path.join(dataDir, 'existing-state.json'), '{"preserve":true}\n');
  return { fixtureDir, repo, dataDir, homeDir };
}

function snapshotTree(root) {
  const entries = {};
  const visit = (relative) => {
    const absolute = relative ? path.join(root, relative) : root;
    for (const name of fs.readdirSync(absolute).sort()) {
      const childRelative = relative ? path.join(relative, name) : name;
      const child = path.join(root, childRelative);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) {
        entries[childRelative] = { type: 'symlink', target: fs.readlinkSync(child) };
      } else if (stat.isDirectory()) {
        entries[childRelative] = { type: 'directory', mode: stat.mode & 0o777 };
        visit(childRelative);
      } else {
        entries[childRelative] = {
          type: 'file',
          mode: stat.mode & 0o777,
          content: fs.readFileSync(child).toString('base64'),
        };
      }
    }
  };
  visit('');
  return entries;
}

function snapshotInitFixture(fixture) {
  return {
    repoTree: snapshotTree(fixture.repo),
    homeTree: snapshotTree(fixture.homeDir),
    dataTree: snapshotTree(fixture.dataDir),
    head: git(fixture.repo, ['rev-parse', 'HEAD']),
    status: git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

function readOptionalBytes(file) {
  try { return fs.readFileSync(file).toString('base64'); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
}

function snapshotRealDaemonInit(fixture) {
  return {
    repoTree: snapshotTree(fixture.repo),
    homeTree: snapshotTree(fixture.homeDir),
    head: git(fixture.repo, ['rev-parse', 'HEAD']),
    status: git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    registry: readOptionalBytes(path.join(fixture.dataDir, 'workspaces.json')),
  };
}

function initOutput(client) {
  return `${client.stdout || ''}\n${client.stderr || ''}`;
}

function assertInitFailedWithoutMutation(client, before, fixture) {
  const output = initOutput(client);
  assert.notEqual(client.status, 0, output);
  assert.match(output, /FULL_INIT_FAILURE Initialization aborted:/);
  assert.doesNotMatch(output, /FULL_INIT_OK|✓ Done|\s✓\s/,
    `failed init must not print success markers:\n${output}`);
  assert.deepEqual(snapshotInitFixture(fixture), before,
    `failed init changed project, home config/skills, Git state, or daemon data:\n${output}`);
}

async function startInitProtocolServer(fixture, port, behavior = {}) {
  const serverPath = path.join(fixture.fixtureDir, 'init-protocol-server.js');
  const readyFile = path.join(fixture.fixtureDir, 'init-protocol-ready');
  const requestLog = path.join(fixture.fixtureDir, 'init-protocol-requests.jsonl');
  fs.writeFileSync(serverPath, `
    'use strict';
    const fs = require('node:fs');
    const http = require('node:http');
    const path = require('node:path');
    const behavior = JSON.parse(process.env.INIT_SERVER_BEHAVIOR);
    const expectedAuth = behavior.expectedToken ? 'Bearer ' + behavior.expectedToken : null;
    function responseFor(route) {
      if (route === '/onboard/init') return behavior.transaction || {};
      if (route === '/workspace') return behavior.registration || {};
      if (route === '/onboard/enqueue') return behavior.enqueue || {};
      if (route === '/onboard/drain-queue') return behavior.drain || {};
      return {};
    }
    function write(res, status, body, headers = {}) {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    }
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch {}
        fs.appendFileSync(process.env.INIT_SERVER_REQUEST_LOG, JSON.stringify({
          method: req.method,
          route: req.url,
          authorization: req.headers.authorization || null,
          localPort: req.socket.localPort,
          body,
        }) + '\\n');
        if (req.url === '/health') {
          write(res, 200, { ok: true, phase: 'ready' }, {
            'X-Zonoid-Health-Signature': 'zonoid-orchestrator-health-v1',
          });
          return;
        }
        if (req.url.startsWith('/search')) {
          write(res, 200, { ok: true, results: [] });
          return;
        }
        if (expectedAuth && req.headers.authorization !== expectedAuth) {
          write(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        const spec = responseFor(req.url);
        if (spec.hang) return;
        if (req.url === '/workspace' && !Object.prototype.hasOwnProperty.call(spec, 'body')) {
          write(res, spec.status || 200, { ok: true, graph_repo: body && body.path, workspace: body && body.path });
          return;
        }
        if (req.url === '/onboard/init' && !Object.prototype.hasOwnProperty.call(spec, 'body')) {
          write(res, spec.status || 200, {
            ok: true,
            accepted: true,
            registered: true,
            graph_repo: body && body.repo,
            outDir: path.join(body.repo, '.zonoid', 'onboard', 'test'),
            queued: true,
            preparationState: 'pending',
          });
          return;
        }
        if (req.url === '/onboard/enqueue' && !Object.prototype.hasOwnProperty.call(spec, 'body')) {
          write(res, spec.status || 200, {
            ok: true,
            outDir: path.join(body.repo, '.zonoid', 'onboard', 'test'),
            queued: true,
            preparationState: 'pending',
          });
          return;
        }
        if (req.url === '/onboard/drain-queue' && !Object.prototype.hasOwnProperty.call(spec, 'body')) {
          write(res, spec.status || 200, { ok: true, status: { preparationState: 'pending' } });
          return;
        }
        write(res, spec.status || 200, Object.prototype.hasOwnProperty.call(spec, 'body') ? spec.body : { ok: false });
      });
    });
    server.listen(Number(process.env.INIT_SERVER_PORT), '127.0.0.1', () => {
      fs.writeFileSync(process.env.INIT_SERVER_READY, 'ready');
    });
  `);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      INIT_SERVER_PORT: String(port),
      INIT_SERVER_READY: readyFile,
      INIT_SERVER_REQUEST_LOG: requestLog,
      INIT_SERVER_BEHAVIOR: JSON.stringify(behavior),
    },
    stdio: 'ignore',
  });
  await waitFor(() => fs.existsSync(readyFile), 2000);
  return { child, requestLog };
}

function readInitRequests(requestLog) {
  if (!fs.existsSync(requestLog)) return [];
  return fs.readFileSync(requestLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function runHeadlessPreparation(repo, outDir) {
  const savedLease = process.env.HEADLESS_DRAIN_GLOBAL_LEASE;
  const savedMaxIterations = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_GLOBAL_LEASE = '0';
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
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
    if (savedMaxIterations === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedMaxIterations;
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

    const savedMaxIterations = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '-1';
    try {
      await runHeadlessPreparation(repo, result.outDir);
      assert.equal(process.env.HEADLESS_DRAIN_MAX_ITERATIONS, '-1',
        'in-process preparation must restore hostile live drain tuning');
    } finally {
      if (savedMaxIterations === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
      else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedMaxIterations;
    }
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
    const transactionAt = cliSource.indexOf('const initialization = await startWorkspaceInitialization(cwd, opts.workspace, daemonDeps);');
    const localMutationAt = cliSource.indexOf('const runtimeMigration = runtimePaths.migrateLegacyRuntime();');
    const successOutputAt = cliSource.indexOf("ok(`Daemon verified (localhost:${daemonDeps.port || ORCH_PORT})`);");
    assert.ok(readyAt >= 0 && transactionAt > readyAt
      && localMutationAt > transactionAt && successOutputAt > transactionAt,
      'init must verify and atomically accept registration plus onboarding before local setup mutates or prints success');
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
        ZONOID_EMBED_PROVIDER: 'local',
        ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
      },
    });
    assert.equal(ready, true);
    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload && health.payload.phase, 'ready');
    assert.equal(health.headers.get('x-zonoid-health-signature'), 'zonoid-orchestrator-health-v1');
    const daemonHead = git(path.join(__dirname, '..'), ['rev-parse', 'HEAD']);
    assert.equal(health.payload.head, daemonHead);
    assert.equal(health.payload.build, `git:${daemonHead}`);
    assert.ok(Number.isInteger(health.payload.pid) && health.payload.pid > 0);
    const version = await daemonRequest(port, 'GET', '/version');
    assert.equal(version.payload.build, health.payload.build);
    assert.equal(version.payload.pid, health.payload.pid);
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
    const before = snapshotInitFixture(fixture);
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
    assertInitFailedWithoutMutation(client, before, fixture);
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
    const before = snapshotInitFixture(fixture);
    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      startupTimeoutMs: 250,
      healthTimeoutMs: 50,
      pollMs: 25,
    });
    assertInitFailedWithoutMutation(client, before, fixture);
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

test('full init aborts cleanly when a cold daemon executable is unavailable', async () => {
  const fixture = prepareInitRepo('zonoid-unavailable-daemon-init-');
  const port = await testPort();
  try {
    const before = snapshotInitFixture(fixture);
    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      daemonPath: path.join(fixture.fixtureDir, 'missing-daemon.js'),
      startupTimeoutMs: 250,
      healthTimeoutMs: 50,
      pollMs: 25,
      childCleanupGraceMs: 50,
    }, { service: true });
    assertInitFailedWithoutMutation(client, before, fixture);
    assert.match(initOutput(client), /no verified Zonoid daemon is ready/);
  } finally {
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('full init rejects daemon transaction errors without local mutation', async (t) => {
  const cases = [
    {
      name: 'registration auth 4xx',
      behavior: { expectedToken: 'different-token' },
      expectedLastRoute: '/onboard/init',
    },
    {
      name: 'registration 5xx',
      behavior: { expectedToken: 'transaction-token', transaction: { status: 503, body: { ok: false, error: 'transaction unavailable' } } },
      expectedLastRoute: '/onboard/init',
    },
    {
      name: 'registration timeout',
      behavior: { expectedToken: 'transaction-token', transaction: { hang: true } },
      deps: { transactionTimeoutMs: 100 },
      expectedLastRoute: '/onboard/init',
    },
    {
      name: 'registration non-accepted 2xx',
      behavior: { expectedToken: 'transaction-token', transaction: { status: 200, body: { ok: false } } },
      expectedLastRoute: '/onboard/init',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = prepareInitRepo(`zonoid-init-${scenario.name.replace(/[^a-z]+/g, '-')}-`);
      const port = await testPort();
      const server = await startInitProtocolServer(fixture, port, scenario.behavior);
      try {
        const before = snapshotInitFixture(fixture);
        const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
          token: 'transaction-token',
          registrationTimeoutMs: 500,
          onboardingTimeoutMs: 500,
          ...scenario.deps,
        });
        assertInitFailedWithoutMutation(client, before, fixture);

        const requests = readInitRequests(server.requestLog);
        const mutations = requests.filter((request) => request.method === 'POST');
        assert.ok(mutations.length > 0, JSON.stringify(requests));
        assert.equal(mutations.at(-1).route, scenario.expectedLastRoute, JSON.stringify(requests));
        assert.deepEqual(mutations.map((request) => request.route), ['/onboard/init']);
        for (const request of mutations) {
          assert.equal(request.authorization, 'Bearer transaction-token');
          assert.equal(request.localPort, port);
        }
      } finally {
        if (processIsAlive(server.child.pid)) server.child.kill('SIGKILL');
        await waitForProcessExit(server.child.pid);
        fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('full init forwards custom daemon dependencies and is repeatable after acceptance', async () => {
  const fixture = prepareInitRepo('zonoid-init-success-');
  const port = await testPort();
  const token = 'custom-port-token';
  const server = await startInitProtocolServer(fixture, port, { expectedToken: token });
  const before = snapshotInitFixture(fixture);
  try {
    const first = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      token,
      registrationTimeoutMs: 1000,
      onboardingTimeoutMs: 1000,
    });
    assert.equal(first.status, 0, initOutput(first));
    assert.match(initOutput(first), /FULL_INIT_OK/);
    assert.match(initOutput(first), /✓ Workspace registration and project onboarding accepted\./);

    const firstRequests = readInitRequests(server.requestLog);
    const firstMutations = firstRequests.filter((request) => request.method === 'POST');
    assert.deepEqual(firstMutations.map((request) => request.route), ['/onboard/init']);
    for (const request of firstMutations) {
      assert.equal(request.authorization, `Bearer ${token}`);
      assert.equal(request.localPort, port);
    }
    const canonicalRepo = fs.realpathSync(fixture.repo);
    assert.deepEqual(firstMutations[0].body, { repo: canonicalRepo });

    const afterFirst = snapshotInitFixture(fixture);
    assert.equal(afterFirst.head, before.head, 'successful init must not commit or rewrite project history');
    assert.equal(fs.readFileSync(path.join(fixture.repo, 'src', 'index.js'), 'utf8'), 'module.exports = () => 42;\n');
    assert.equal(fs.readFileSync(path.join(fixture.repo, 'work-in-progress.txt'), 'utf8'), 'valuable uncommitted work\n');
    assert.match(afterFirst.status, /work-in-progress\.txt/);

    const second = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      token,
      registrationTimeoutMs: 1000,
      onboardingTimeoutMs: 1000,
    });
    assert.equal(second.status, 0, initOutput(second));
    assert.match(initOutput(second), /FULL_INIT_OK/);
    assert.deepEqual(snapshotInitFixture(fixture), afterFirst,
      'repeat init must leave every project/config/skill/hook byte and Git state unchanged');

    const allRequests = readInitRequests(server.requestLog);
    const mutationRoutes = allRequests.filter((request) => request.method === 'POST').map((request) => request.route);
    assert.deepEqual(mutationRoutes, ['/onboard/init', '/onboard/init']);
    assert.ok(allRequests.every((request) => request.localPort === port), JSON.stringify(allRequests));
  } finally {
    if (processIsAlive(server.child.pid)) server.child.kill('SIGKILL');
    await waitForProcessExit(server.child.pid);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('full init starts a cold token-protected daemon on a custom port', async () => {
  const fixture = prepareInitRepo('zonoid-init-cold-auth-');
  const port = await testPort();
  const token = 'cold-init-token';
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  const beforeHead = git(fixture.repo, ['rev-parse', 'HEAD']);
  try {
    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      port,
      token,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      registrationTimeoutMs: 3000,
      onboardingTimeoutMs: 3000,
      env: {
        CLAUDE_PLUGIN_DATA: fixture.dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
        ZONOID_EMBED_PROVIDER: 'local',
        ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
      },
    });
    assert.equal(client.status, 0, initOutput(client));
    assert.match(initOutput(client), /FULL_INIT_OK/);
    assert.equal(git(fixture.repo, ['rev-parse', 'HEAD']), beforeHead);
    assert.equal(fs.readFileSync(path.join(fixture.repo, 'work-in-progress.txt'), 'utf8'), 'valuable uncommitted work\n');

    const workspaces = await daemonRequest(port, 'GET', '/workspaces', undefined, token);
    assert.equal(workspaces.status, 200);
    assert.match(JSON.stringify(workspaces.payload), new RegExp(fixture.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.existsSync(path.join(fixture.repo, '.zonoid', 'onboard')), true,
      'accepted cold init must persist its onboarding request');
    const outDir = path.join(fixture.repo, '.zonoid', 'onboard', path.basename(fixture.repo));
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.preparationState, 'pending');
    assert.equal(status.autoInject, true, 'durable acceptance must arm background injection before returning');
    assert.match(fs.readFileSync(path.join(fixture.repo, '.gitattributes'), 'utf8'), /^\.graph\/\*\* merge=ours$/m);
    assert.equal(git(fixture.repo, ['config', '--local', '--get', 'merge.ours.driver']), 'true');
    assert.match(fs.readFileSync(path.join(fixture.repo, '.git', 'info', 'exclude'), 'utf8'), /^\.zonoid\/$/m);
    const registry = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'workspaces.json'), 'utf8'));
    const repoRealpath = fs.realpathSync(fixture.repo);
    assert.ok(Object.values(registry.workspaces).some((entry) => entry.repos.some((repo) => fs.realpathSync(repo) === repoRealpath)));

    const acceptedSnapshot = snapshotRealDaemonInit(fixture);
    const repeated = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, {
      port,
      token,
      registrationTimeoutMs: 3000,
      onboardingTimeoutMs: 3000,
    });
    assert.equal(repeated.status, 0, initOutput(repeated));
    assert.deepEqual(snapshotRealDaemonInit(fixture), acceptedSnapshot,
      'repeat real-daemon init must be byte-idempotent across project, HOME, registry, and Git state');
  } finally {
    await stopDaemon(port);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('synchronized registry writers acknowledge only commits that preserve every repo', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-registry-rmw-'));
  const registryFile = path.join(fixtureDir, 'workspaces.json');
  const workerPath = path.join(fixtureDir, 'registry-worker.js');
  const workerCount = 8;
  fs.writeFileSync(workerPath, `
    'use strict';
    const registry = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'workspace-registry.js'))});
    process.send({ ready: true, index: process.env.WORKER_INDEX });
    process.once('message', (message) => {
      if (message !== 'commit') process.exit(2);
      try {
        const committed = registry.addRepo(process.env.REGISTRY_FILE, {
          workspace: 'shared',
          repo: process.env.WORKER_REPO,
        });
        const persisted = committed.workspaces.shared.repos.includes(process.env.WORKER_REPO);
        process.send({ status: persisted ? 200 : 500, repo: process.env.WORKER_REPO });
        process.exit(persisted ? 0 : 1);
      } catch (err) {
        process.send({ status: 500, error: String(err && err.message || err) });
        process.exit(1);
      }
    });
  `);

  const children = [];
  try {
    for (let i = 0; i < workerCount; i++) {
      const repo = path.join(fixtureDir, `repo-${i}`);
      const child = spawn(process.execPath, [workerPath], {
        env: {
          ...process.env,
          REGISTRY_FILE: registryFile,
          WORKER_INDEX: String(i),
          WORKER_REPO: repo,
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push({ child, repo, ready: false, response: null, stderr: '' });
      child.stderr.on('data', (chunk) => { children[i].stderr += chunk; });
      child.on('message', (message) => {
        if (message && message.ready) children[i].ready = true;
        if (message && message.status) children[i].response = message;
      });
    }

    await waitFor(() => children.every((entry) => entry.ready), 5000);
    for (const { child } of children) child.send('commit');
    await Promise.all(children.map(({ child }) => new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`registry worker exited ${code}`)));
    })));

    assert.ok(children.every((entry) => entry.response && entry.response.status === 200),
      JSON.stringify(children.map((entry) => ({ response: entry.response, stderr: entry.stderr }))));
    const persisted = workspaceRegistry.loadRegistry(registryFile);
    assert.deepEqual(new Set(persisted.workspaces.shared.repos), new Set(children.map((entry) => entry.repo)));
    assert.equal(fs.existsSync(`${registryFile}.lock`), false, 'successful writers must release the registry lock');
  } finally {
    for (const { child } of children) {
      if (processIsAlive(child.pid)) child.kill('SIGKILL');
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('daemon boot reconciles every hard-exit boundary of onboarding init', async (t) => {
  const boundaries = ['journal', 'status', 'registry', 'verified', 'exclude', 'journal_removed'];
  for (const boundary of boundaries) {
    await t.test(boundary, async () => {
      const fixture = prepareInitRepo(`zonoid-init-crash-${boundary}-`);
      const port = await testPort();
      const token = `crash-${boundary}-token`;
      const outDir = path.join(fixture.repo, '.zonoid', 'onboard', path.basename(fixture.repo));
      fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
      let crashedPid = null;
      try {
        assert.equal(await checkDaemon({
          port,
          daemonPath: DAEMON_PATH,
          startupTimeoutMs: 15000,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: fixture.dataDir,
            ORCH_TOKEN: '',
            CLAUDE_CODE_SESSION_ID: '',
            HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
            ZONOID_EMBED_PROVIDER: 'local',
            ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
            ZONOID_TEST_ONBOARD_INIT_CRASH_AFTER: boundary,
          },
        }), true);
        const version = await daemonRequest(port, 'GET', '/version');
        crashedPid = Number(version.payload && version.payload.pid);
        await assert.rejects(
          daemonRequest(port, 'POST', '/onboard/init', { repo: fixture.repo }, token),
          /fetch failed|terminated|socket|other side closed/i,
        );
        assert.equal(await waitForProcessExit(crashedPid, 5000), true, `daemon did not exit at ${boundary}`);

        assert.equal(await checkDaemon({
          port,
          daemonPath: DAEMON_PATH,
          startupTimeoutMs: 15000,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: fixture.dataDir,
            ORCH_TOKEN: '',
            CLAUDE_CODE_SESSION_ID: '',
            HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
            ZONOID_EMBED_PROVIDER: 'local',
            ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
            ZONOID_TEST_ONBOARD_INIT_CRASH_AFTER: '',
          },
        }), true);

        const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
        assert.equal(status.repo, fixture.repo);
        assert.equal(status.outDir, outDir);
        assert.equal(status.autoInject, true);
        assert.equal(status.preparationState, 'pending');
        const registry = workspaceRegistry.loadRegistry(path.join(fixture.dataDir, 'workspaces.json'));
        assert.ok(workspaceRegistry.allRepos(registry).includes(fixture.repo),
          `restart after ${boundary} left onboarding unregistered`);
        const journals = path.join(fixture.dataDir, 'onboard-init-transactions');
        assert.ok(!fs.existsSync(journals) || fs.readdirSync(journals).length === 0,
          `restart after ${boundary} left an unreconciled journal`);
        assert.match(fs.readFileSync(path.join(fixture.repo, '.git', 'info', 'exclude'), 'utf8'), /^\.zonoid\/$/m);
        const listed = await daemonRequest(port, 'GET', '/workspaces', undefined, token);
        assert.match(JSON.stringify(listed.payload), new RegExp(fixture.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      } finally {
        await stopDaemon(port);
        if (crashedPid && processIsAlive(crashedPid)) process.kill(crashedPid, 'SIGKILL');
        fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('daemon boot quarantines an invalid onboarding publication and stays ready', async () => {
  const fixture = prepareInitRepo('zonoid-publication-invalid-boot-');
  const port = await testPort();
  const token = 'publication-invalid-boot-token';
  const registryFile = path.join(fixture.dataDir, 'workspaces.json');
  const outDir = path.join(fixture.repo, '.zonoid', 'onboard', path.basename(fixture.repo));
  const journal = path.join(outDir, 'onboard-publication-intent.json');
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  workspaceRegistry.addRepo(registryFile, { workspace: 'invalid-publication', repo: fixture.repo });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
    generation: 'generation-untrusted-boot', total: 1, cursor: 0,
    kept: [], rejected: [], pending: [{ title: 'untrusted' }],
  }));
  fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
    repo: fixture.repo,
    outDir,
    autoInject: true,
    preparationState: 'running',
    preparationGeneration: 'generation-boot-reprepare',
    preparationOwner: 'dead-boot-owner',
    preparationPid: 999999,
    preparationLeaseExpiresAt: Date.now() - 1,
    queueGeneration: 'generation-before-boot',
    injectionGeneration: 'generation-before-boot',
  }));
  fs.writeFileSync(journal, JSON.stringify({ version: 1, generation: 'shallow-untrusted' }));

  try {
    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: fixture.dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
        ZONOID_EMBED_PROVIDER: 'local',
        ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
      },
    }), true);

    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.phase, 'ready');
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-queue.json')), false,
      'boot must not roll a queue forward from an invalid publication');
    assert.ok(fs.readdirSync(outDir).some((name) => name.startsWith('onboard-publication-intent.json.invalid-')));
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.preparationState, 'pending');
    assert.equal(status.preparationGeneration, 'generation-boot-reprepare');
    assert.equal(status.preparationOwner, null);

    const enqueued = await daemonRequest(port, 'POST', '/onboard/enqueue', {
      repo: fixture.repo,
      outDir,
    }, token);
    assert.equal(enqueued.status, 200);
    assert.equal(enqueued.payload.preparing, true);
    assert.equal(enqueued.payload.preparationState, 'pending');
  } finally {
    await stopDaemon(port);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('daemon boot ignores an unreadable invalid init journal and quarantines it on a later retry', async () => {
  const fixture = prepareInitRepo('zonoid-init-invalid-journal-boot-');
  const port = await testPort();
  const token = 'invalid-init-journal-boot-token';
  const registryFile = path.join(fixture.dataDir, 'workspaces.json');
  const journalDir = onboardInitTransaction.journalDir(registryFile);
  const id = '8'.repeat(32);
  const journal = onboardInitTransaction.journalFile(registryFile, id);
  const daemonOptions = {
    port,
    daemonPath: DAEMON_PATH,
    startupTimeoutMs: 15000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: fixture.dataDir,
      ORCH_TOKEN: '',
      CLAUDE_CODE_SESSION_ID: '',
      HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
      ZONOID_EMBED_PROVIDER: 'local',
      ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
    },
  };
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  fs.mkdirSync(journalDir);
  fs.writeFileSync(journal, '{invalid json');
  fs.chmodSync(journalDir, 0o500);
  try {
    assert.equal(await checkDaemon(daemonOptions), true,
      'quarantine failure must not block daemon loadState');
    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.phase, 'ready');
    assert.equal(fs.existsSync(journal), true,
      'failed quarantine must leave the journal unconsumed for a later retry');

    await stopDaemon(port);
    fs.chmodSync(journalDir, 0o700);
    assert.equal(await checkDaemon(daemonOptions), true);
    const retriedHealth = await daemonRequest(port, 'GET', '/health');
    assert.equal(retriedHealth.status, 200);
    assert.equal(retriedHealth.payload.phase, 'ready');
    assert.equal(fs.existsSync(journal), false);
    assert.ok(fs.readdirSync(journalDir).some((name) => name.startsWith(`${id}.json.invalid`)),
      'later boot must retry and quarantine the unchanged journal');
  } finally {
    await stopDaemon(port);
    try { fs.chmodSync(journalDir, 0o700); } catch { /* already removed */ }
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('daemon boot quarantines a valid legacy init intent instead of reading or replacing a FIFO status', async () => {
  const fixture = prepareInitRepo('zonoid-init-legacy-status-fifo-');
  const port = await testPort();
  const token = 'legacy-status-fifo-token';
  const registryFile = path.join(fixture.dataDir, 'workspaces.json');
  const outDir = path.join(fixture.repo, '.zonoid', 'onboard', path.basename(fixture.repo));
  const statusFile = path.join(outDir, 'onboard-drain-status.json');
  const desiredStatus = {
    repo: fixture.repo,
    outDir,
    autoInject: true,
    batchSize: 20,
    preparationState: 'pending',
    preparationGeneration: 'generation-legacy-fifo',
  };
  const intent = onboardInitTransaction.createIntent({
    repo: fixture.repo,
    outDir,
    workspaceId: path.basename(fixture.repo),
    beforeStatus: {},
    desiredStatus,
  });
  const legacy = { ...intent, version: 1 };
  delete legacy.desiredStatusDigest;
  delete legacy.intentDigest;
  const journalDir = onboardInitTransaction.journalDir(registryFile);
  const journal = onboardInitTransaction.journalFile(registryFile, legacy.id);
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(journalDir);
  fs.writeFileSync(journal, JSON.stringify(legacy));
  const fifo = spawnSync('mkfifo', [statusFile], { encoding: 'utf8', windowsHide: true });
  if (fifo.status !== 0) {
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
    return;
  }
  try {
    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: fixture.dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
        ZONOID_EMBED_PROVIDER: 'local',
        ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
      },
    }), true, 'legacy intent recovery must not hang on the canonical FIFO');
    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.phase, 'ready');
    assert.equal(fs.lstatSync(statusFile).isFIFO(), true,
      'recovery must not replace the unsafe status path');
    assert.equal(workspaceRegistry.allRepos(workspaceRegistry.loadRegistry(registryFile)).includes(fixture.repo), false,
      'unsafe legacy status must not publish workspace registration');
    assert.equal(fs.existsSync(journal), false);
    assert.ok(fs.readdirSync(journalDir).some((name) => name.startsWith(`${legacy.id}.json.invalid`)));
  } finally {
    await stopDaemon(port);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('daemon restart keeps an invalid journal fenced after status-temp publication crash', async () => {
  const fixture = prepareInitRepo('zonoid-publication-invalid-restart-');
  const port = await testPort();
  const token = 'publication-invalid-restart-token';
  const registryFile = path.join(fixture.dataDir, 'workspaces.json');
  const outDir = path.join(fixture.repo, '.zonoid', 'onboard', path.basename(fixture.repo));
  const queueFile = path.join(outDir, 'onboard-queue.json');
  const statusFile = path.join(outDir, 'onboard-drain-status.json');
  const journal = path.join(outDir, 'onboard-publication-intent.json');
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  workspaceRegistry.addRepo(registryFile, { workspace: 'invalid-publication-restart', repo: fixture.repo });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(queueFile, JSON.stringify({
    generation: 'generation-untrusted-restart', total: 1, cursor: 0,
    kept: [], rejected: [], pending: [{ title: 'untrusted' }],
  }));
  fs.writeFileSync(statusFile, JSON.stringify({
    repo: fixture.repo,
    outDir,
    autoInject: true,
    preparationState: 'running',
    preparationGeneration: 'generation-restart-reprepare',
    preparationOwner: 'dead-restart-owner',
    preparationPid: 999999,
    preparationLeaseExpiresAt: Date.now() - 1,
    queueGeneration: 'generation-before-restart',
    injectionGeneration: 'generation-before-restart',
  }));
  fs.writeFileSync(journal, JSON.stringify({ version: 1, generation: 'shallow-untrusted' }));
  const daemonEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: fixture.dataDir,
    ORCH_TOKEN: '',
    CLAUDE_CODE_SESSION_ID: '',
    HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
    ZONOID_EMBED_PROVIDER: 'local',
    ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
  };

  try {
    const crashed = spawnSync(process.execPath, [DAEMON_PATH], {
      cwd: fixture.repo,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: {
        ...daemonEnv,
        ORCH_PORT: String(port),
        ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER: 'invalid_status_commit',
      },
    });
    assert.equal(crashed.status, 87, crashed.stderr);
    assert.equal(fs.existsSync(queueFile), false);
    assert.equal(fs.existsSync(journal), true,
      'hard exit after the safe-status temp write must retain the canonical poison fence');
    assert.ok(fs.readdirSync(outDir).some((name) => (
      /^onboard-drain-status\.json\.invalid-\d+-[a-f0-9]+\.tmp$/.test(name)
    )));

    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: daemonEnv,
    }), true);
    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.phase, 'ready');
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(queueFile), false);
    assert.deepEqual(fs.readdirSync(outDir).filter((name) => (
      /^onboard-drain-status\.json\.invalid-\d+-[a-f0-9]+\.tmp$/.test(name)
    )), []);
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(status.preparationState, 'pending');
    assert.equal(status.preparationGeneration, 'generation-restart-reprepare');
  } finally {
    await stopDaemon(port);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('daemon loadState survives a settled init with read-only Git exclude and retries later', async () => {
  const fixture = prepareInitRepo('zonoid-init-exclude-readonly-');
  const port = await testPort();
  const token = 'exclude-readonly-token';
  const excludeFile = path.join(fixture.repo, '.git', 'info', 'exclude');
  const registryFile = path.join(fixture.dataDir, 'workspaces.json');
  const outDir = path.join(fixture.repo, '.zonoid', 'onboard', path.basename(fixture.repo));
  const statusFile = path.join(outDir, 'onboard-drain-status.json');
  const journalDir = path.join(fixture.dataDir, 'onboard-init-transactions');
  const daemonOptions = {
    port,
    daemonPath: DAEMON_PATH,
    startupTimeoutMs: 15000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: fixture.dataDir,
      ORCH_TOKEN: '',
      CLAUDE_CODE_SESSION_ID: '',
      HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
      ZONOID_EMBED_PROVIDER: 'local',
      ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
    },
  };
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  fs.writeFileSync(excludeFile, 'preserve-existing-rule\n');
  fs.chmodSync(excludeFile, 0o400);
  try {
    assert.equal(await checkDaemon(daemonOptions), true);
    const accepted = await daemonRequest(port, 'POST', '/onboard/init', { repo: fixture.repo }, token);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
    assert.equal(accepted.payload.accepted, true);
    assert.equal(fs.readFileSync(excludeFile, 'utf8'), 'preserve-existing-rule\n');
    assert.equal(!fs.existsSync(journalDir) || fs.readdirSync(journalDir).length === 0, true,
      'exclude EACCES must not retain the committed init journal');

    await stopDaemon(port);
    const committed = {
      status: fs.readFileSync(statusFile),
      registry: fs.readFileSync(registryFile),
      exclude: fs.readFileSync(excludeFile),
      head: git(fixture.repo, ['rev-parse', 'HEAD']),
      source: fs.readFileSync(path.join(fixture.repo, 'src', 'index.js')),
      work: fs.readFileSync(path.join(fixture.repo, 'work-in-progress.txt')),
      porcelain: git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    };

    assert.equal(await checkDaemon(daemonOptions), true,
      'advisory Git exclusion failure must not crash daemon loadState');
    const health = await daemonRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.phase, 'ready');
    await stopDaemon(port);
    assert.deepEqual(fs.readFileSync(statusFile), committed.status);
    assert.deepEqual(fs.readFileSync(registryFile), committed.registry);
    assert.deepEqual(fs.readFileSync(excludeFile), committed.exclude);
    assert.equal(git(fixture.repo, ['rev-parse', 'HEAD']), committed.head);
    assert.deepEqual(fs.readFileSync(path.join(fixture.repo, 'src', 'index.js')), committed.source);
    assert.deepEqual(fs.readFileSync(path.join(fixture.repo, 'work-in-progress.txt')), committed.work);
    assert.equal(git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all']), committed.porcelain);
    assert.equal(!fs.existsSync(journalDir) || fs.readdirSync(journalDir).length === 0, true);

    fs.chmodSync(excludeFile, 0o600);
    assert.equal(await checkDaemon(daemonOptions), true);
    assert.match(fs.readFileSync(excludeFile, 'utf8'), /^\.zonoid\/$/m,
      'a later writable maintenance pass must finish the advisory runtime ignore');
    assert.deepEqual(fs.readFileSync(statusFile), committed.status);
    assert.deepEqual(fs.readFileSync(registryFile), committed.registry);
    assert.equal(!fs.existsSync(journalDir) || fs.readdirSync(journalDir).length === 0, true);
  } finally {
    await stopDaemon(port);
    try { fs.chmodSync(excludeFile, 0o600); } catch { /* missing fixture */ }
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('real daemon rejects invalid onboarding paths before registration or project mutation', async () => {
  const fixture = prepareInitRepo('zonoid-init-real-reject-');
  const outside = path.join(fixture.fixtureDir, 'escaped-runtime');
  const port = await testPort();
  const token = 'real-reject-token';
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fixture.repo, '.zonoid'));
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  try {
    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: fixture.dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
        ZONOID_EMBED_PROVIDER: 'local',
        ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
      },
    }), true);
    const before = snapshotRealDaemonInit(fixture);
    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, { token });
    assert.notEqual(client.status, 0, initOutput(client));
    assert.match(initOutput(client), /onboarding output path must not contain symlinks/);
    assert.deepEqual(snapshotRealDaemonInit(fixture), before,
      'rejected real-daemon validation must not create graph, attributes, config, registry, hooks, or onboarding state');
    const workspaces = await daemonRequest(port, 'GET', '/workspaces', undefined, token);
    assert.doesNotMatch(JSON.stringify(workspaces.payload), new RegExp(fixture.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await stopDaemon(port);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('real daemon rolls back durable onboarding when registry commit fails', async () => {
  const fixture = prepareInitRepo('zonoid-init-real-rollback-');
  const port = await testPort();
  const token = 'real-rollback-token';
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  try {
    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: fixture.dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
        ZONOID_EMBED_PROVIDER: 'local',
        ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
      },
    }), true);
    fs.chmodSync(fixture.dataDir, 0o555);
    const before = snapshotRealDaemonInit(fixture);
    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, { token });
    assert.notEqual(client.status, 0, initOutput(client));
    assert.match(initOutput(client), /workspace registration and onboarding transaction failed/);
    assert.deepEqual(snapshotRealDaemonInit(fixture), before,
      'registry commit failure must roll back the newly persisted queue and every project/HOME/Git byte');
  } finally {
    fs.chmodSync(fixture.dataDir, 0o755);
    await stopDaemon(port);
    fs.rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('real daemon refuses retry-capped reused queues without false init success or new mutations', async () => {
  const fixture = prepareInitRepo('zonoid-init-real-capped-');
  const port = await testPort();
  const token = 'real-capped-token';
  const generation = 'onboard-capped-test';
  const outDir = path.join(fixture.repo, '.zonoid', 'onboard', path.basename(fixture.repo));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
    generation,
    total: 1,
    cursor: 1,
    pending: [],
    kept: [{ title: 'Existing note', summary: 'not injected' }],
    rejected: [],
    inflight: {},
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
    repo: fixture.repo,
    outDir,
    preparationState: 'ready',
    autoInject: true,
    injectionGeneration: generation,
    injectionState: 'failed',
    injectionAttempts: 3,
    injectionRetryCapped: true,
    injectionError: 'injection failed three times',
  }, null, 2));
  fs.writeFileSync(path.join(fixture.dataDir, 'token'), `${token}\n`);
  try {
    assert.equal(await checkDaemon({
      port,
      daemonPath: DAEMON_PATH,
      startupTimeoutMs: 15000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: fixture.dataDir,
        ORCH_TOKEN: '',
        CLAUDE_CODE_SESSION_ID: '',
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
        ZONOID_EMBED_PROVIDER: 'local',
        ZONOID_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:1',
      },
    }), true);
    const before = snapshotRealDaemonInit(fixture);
    const client = runFullInit(fixture.repo, fixture.dataDir, fixture.homeDir, port, { token });
    assert.notEqual(client.status, 0, initOutput(client));
    assert.match(initOutput(client), /injection-failed and retry-capped/);
    assert.doesNotMatch(initOutput(client), /FULL_INIT_OK|Workspace registration and project onboarding accepted/);
    assert.deepEqual(snapshotRealDaemonInit(fixture), before,
      'capped reused queue rejection must preserve exact queue, registry, project, HOME, HEAD, status, and Git config bytes');
  } finally {
    await stopDaemon(port);
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
    await waitFor(() => fs.existsSync(path.join(outDir, 'onboard-queue.json')), 60000);
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
