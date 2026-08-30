#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auth-base-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-auth-ws-')));
const PORT = 19650 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';

async function req(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Boot deadline, not a latency budget: waitForPing returns the moment /ping answers, so a
// generous ceiling costs nothing on a fast boot and only decides how long a SLOW one is tolerated.
// 8s was under the real cold-start cost of a full daemon on Windows (fresh Node + AV scan of the
// runtime dir), so suites failed on "daemon came up" intermittently while the daemon was merely
// still starting. No test asserts that a daemon FAILS to boot, so nothing depends on a tight bound.

async function waitForPing(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await req('GET', '/ping');
      if (r.status === 200 && r.body.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('token-enabled daemon gates mutating and workspace-targeted routes', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_BIND_HOST: '0.0.0.0', ORCH_TOKEN: TOKEN, CLAUDE_CODE_SESSION_ID: '' },
    stdio: 'ignore',
  });
  try {
    assert.ok(await waitForPing(), 'daemon came up');

    assert.equal((await req('GET', '/ping')).status, 200, 'public health read stays open');
    const dashboard = await fetch(`${BASE}/graph?workspace=${encodeURIComponent(WS)}`);
    assert.equal(dashboard.status, 200, 'dashboard shell stays open so a fragment token can bootstrap auth');
    assert.match(dashboard.headers.get('content-type') || '', /text\/html/);
    assert.equal((await req('GET', '/state')).status, 401, 'LAN mode also gates unscoped data reads');
    const preflight = await fetch(`${BASE}/state`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Headers': 'authorization' },
    });
    assert.equal(preflight.status, 204, 'browser bearer preflight is accepted');
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/);

    for (const [method, route, body] of [
      ['POST', '/task/metric', { key: 'x/1', spec: { metric: 'm', direction: 'min', measure_command: 'echo 1' } }],
      ['POST', '/task/measure', { key: 'x/1' }],
      ['POST', '/classify', { prompt: 'fix a bug' }],
      ['POST', '/onboard/enqueue', { repo: WS }],
      ['POST', '/graph/init', { workspace: WS }],
      ['POST', '/judge/rejudge-edges', { sigs: ['a>>b'] }],
    ]) {
      const r = await req(method, route, body);
      assert.equal(r.status, 401, `${method} ${route} requires auth`);
    }

    assert.equal((await req('GET', `/search?workspace=${encodeURIComponent(WS)}&q=x`)).status, 401, 'workspace-targeted reads require auth');
    for (const route of [
      '/active-claim?session=s1',
      '/agents',
      '/events',
      '/next-action',
      '/session-info?session=s1',
      '/should-stop?agent_id=a1',
      '/task/detail?key=x/1',
      '/workspaces',
    ]) {
      assert.equal((await req('GET', route)).status, 401, `GET ${route} requires auth`);
    }
    const events = await fetch(`${BASE}/events?workspace=${encodeURIComponent(WS)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(events.status, 200, 'valid token opens the live dashboard event stream');
    await events.body.cancel();
    assert.equal((await req('POST', '/workspace', { path: WS }, TOKEN)).status, 200, 'valid token allows protected mutation');
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon refuses an unauthenticated LAN bind', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-lan-no-auth-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: {
      ...process.env,
      ORCH_DATA: dataDir,
      CLAUDE_PLUGIN_DATA: dataDir,
      ORCH_PORT: String(PORT + 1),
      ORCH_BIND_HOST: '0.0.0.0',
      ORCH_TOKEN: '',
      CLAUDE_CODE_SESSION_ID: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('unauthenticated LAN daemon did not exit')), 5000);
      child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /Refusing ORCH_BIND_HOST=0\.0\.0\.0 without ORCH_TOKEN/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dashboard keeps LAN bearer tokens out of API query strings', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  const dfetch = html.slice(html.indexOf('function dfetch('), html.indexOf('// flattenWorkspaceRepos:'));
  const daemonFetch = html.slice(html.indexOf('function daemonFetch('), html.indexOf('// dfetch:'));
  assert.match(html, /_HASH_PARAMS\.get\('token'\)/, 'fragment token is accepted');
  assert.match(html, /sessionStorage\.setItem\('zonoid-dashboard-token'/, 'token is scoped to the browser tab');
  assert.match(daemonFetch, /headers\.set\('Authorization', 'Bearer ' \+ _TOKEN\)/, 'API calls use the bearer header');
  assert.match(dfetch, /return daemonFetch\(url, init\)/, 'workspace-scoped requests share authenticated transport');
  assert.doesNotMatch(dfetch, /parts\.push\('token='/, 'API calls do not copy the token into URLs');
  assert.match(html, /dfetch\('\/events'/, 'authenticated live events use the bearer-capable fetch path');
});
