#!/usr/bin/env node
// Integration test for POST /sweep endpoint.
// Verifies response shape and idempotency (safe to call multiple times).
// Run: node --test test/sweep.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sweep-test-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sweep-ws-')));
const PORT = 19900 + Math.floor(Math.random() * 100);

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

async function waitForDaemon(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let child;

test('POST /sweep', { timeout: 15000 }, async (t) => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    assert.ok(await waitForDaemon(), 'daemon came up');
    await req('POST', '/workspace', { path: WS });

    await t.test('returns ok:true and released count (no stale claims)', async () => {
      const r = await req('POST', '/sweep', { workspace: WS });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.released, 'number');
      assert.equal(r.body.released, 0); // nothing to sweep on a fresh workspace
    });

    await t.test('is idempotent — second call returns same shape', async () => {
      const r = await req('POST', '/sweep', { workspace: WS });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.released, 'number');
    });

    await t.test('releases a stale in_progress claim with force:true', async () => {
      // Register a dead agent and place a claim via the overlay endpoint.
      await req('POST', '/agent/start', {
        agent_id: 'dead-agent-sweep', state: 'running', workspace: WS, session: 'dead-session',
      });
      await req('POST', '/overlay/status', {
        workspace: WS, key: 'sweep-test/1', status: 'in_progress', agent_id: 'dead-agent-sweep',
      });

      // stale_minutes:0 forces any claim to be immediately stale, force:true bypasses vouchedLive.
      const r = await req('POST', '/sweep', { workspace: WS, force: true, stale_minutes: 0 });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.released, 1);
    });
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true }); } catch { /* */ }
  }
});
