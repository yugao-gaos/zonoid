#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { checkDaemon, startWorkspaceOnboarding } = require('../packages/cli/bin/zonoid');
const onboardRoute = require('../routes/onboard');

const DAEMON_PATH = path.join(__dirname, '..', 'daemon.js');
const CLI_PATH = path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js');

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
  return { status: response.status, payload };
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

function routePost(calls) {
  return async (route, body) => {
    const call = { route, body };
    calls.push(call);
    let response = null;
    const handler = onboardRoute({
      readBody: async () => body,
      send: (_res, status, payload) => { response = { status, payload }; },
      notifyChange: () => {},
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

    const result = await startWorkspaceOnboarding(repo, {
      post: routePost(calls),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.route), ['/onboard/enqueue', '/onboard/drain-queue']);
    assert.deepEqual(calls[0].body, { repo });
    assert.equal(calls[1].body.repo, repo);
    assert.equal(calls[1].body.autoInject, true);
    assert.equal(calls[1].body.liveInject, true);
    const queue = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-queue.json'), 'utf8'));
    const status = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.ok(queue.total > 0, 'existing project content must be mined before any dashboard opens');
    assert.equal(status.repo, repo);
    assert.equal(status.autoInject, true);
    assert.equal(fs.readFileSync(source, 'utf8'), sourceBody);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(repo, ['diff', '--', 'src/feature.js']), '');

    const cliSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js'), 'utf8');
    const registerAt = cliSource.indexOf('const registeredRepo = await registerWorkspace(cwd, opts.workspace);');
    const onboardAt = cliSource.indexOf('if (registeredRepo) await startWorkspaceOnboarding(registeredRepo);');
    assert.ok(registerAt >= 0 && onboardAt > registerAt, 'init must arm onboarding immediately after registration');
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
      const calls = [];
      const result = await startWorkspaceOnboarding(repoCase.path, {
        post: routePost(calls),
      });

      assert.equal(result.ok, true, `${repoCase.label} should onboard without an HTTP 500`);
      assert.deepEqual(calls.map((call) => call.route), ['/onboard/enqueue', '/onboard/drain-queue']);
      const queue = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-queue.json'), 'utf8'));
      assert.equal(calls[1].response.status, 200);
      assert.equal(calls[1].response.payload.status.error, null);
      if (repoCase.empty) {
        assert.deepEqual(queue, { total: 0, cursor: 0, kept: [], rejected: [], pending: [] });
        assert.equal(calls[1].response.payload.status.done, true);
        assert.equal(calls[1].response.payload.status.noCandidates, true);
      } else {
        assert.ok(queue.total > 0, 'non-git miners must retain useful zero-commit project evidence');
        assert.equal(calls[1].response.payload.status.done, false);
        assert.equal(calls[1].response.payload.status.noCandidates, false);
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
    assert.ok(Date.now() - startedAt < 15000, 'cold startup must return instead of waiting on the detached daemon process');
  } finally {
    await stopDaemon(port);
    fs.rmSync(dataDir, { recursive: true, force: true });
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
        HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
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
    const resultLine = String(client.stdout || '').split(/\r?\n/).find((line) => line.startsWith('CLI_INIT_RESULT '));
    assert.ok(resultLine, `missing CLI init result in output:\n${client.stdout}`);
    const result = JSON.parse(resultLine.slice('CLI_INIT_RESULT '.length));
    assert.equal(result.repo, repo);
    assert.equal(result.onboarding.ok, true);

    const workspaces = await daemonRequest(port, 'GET', '/workspaces', undefined, token);
    assert.equal(workspaces.status, 200);
    assert.match(JSON.stringify(workspaces.payload), new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(fs.existsSync(path.join(result.onboarding.outDir, 'onboard-queue.json')));
  } finally {
    await stopDaemon(port);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
