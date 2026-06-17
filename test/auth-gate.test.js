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

async function waitForPing(ms = 10000) {
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
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: TOKEN, CLAUDE_CODE_SESSION_ID: '' },
    stdio: 'ignore',
  });
  try {
    assert.ok(await waitForPing(), 'daemon came up');

    assert.equal((await req('GET', '/ping')).status, 200, 'public health read stays open');

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
    assert.equal((await req('POST', '/workspace', { path: WS }, TOKEN)).status, 200, 'valid token allows protected mutation');
  } finally {
    child.kill('SIGKILL');
  }
});
