#!/usr/bin/env node
// Integration test for GET /workspaces — asserts the union list, current flag, and basename name.
// Pattern mirrors adopt-native-daemon.test.js: in-process http against a sandboxed spawned daemon.
// Run: node test/workspaces-daemon.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-list-d-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;

const PORT = 18960 + Math.floor(Math.random() * 100);

// Two distinct temp workspaces: WS1 (primary, set via /workspace) and WS2 (secondary).
const WS1 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslist-ws1-')));
const WS2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslist-ws2-')));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

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

function spawnDaemon() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
}

(async () => {
  let child = spawnDaemon();
  try {
    ok('daemon came up', await waitForPing());

    // (A) Initial state: no workspace set yet → /workspaces returns empty or single-entry list
    {
      const r = await req('GET', '/workspaces');
      ok('(A) /workspaces returns ok:true', r.status === 200 && r.body.ok === true);
      ok('(A) workspaces is an array', Array.isArray(r.body.workspaces));
    }

    // (B) Set WS1 as the primary workspace
    await req('POST', '/workspace', { path: WS1 });

    {
      const r = await req('GET', '/workspaces');
      ok('(B) /workspaces ok after setting WS1', r.status === 200 && r.body.ok === true);
      const list = r.body.workspaces || [];
      const ws1Entry = list.find((w) => w.path === WS1);
      ok('(B) WS1 appears in list', !!ws1Entry);
      ok('(B) WS1 has current:true', ws1Entry && ws1Entry.current === true);
      ok('(B) WS1 name is basename', ws1Entry && ws1Entry.name === path.basename(WS1));
      ok('(B) current field equals WS1', r.body.current === WS1);
    }

    // (C) Switch to WS2 — both should appear; WS2 is now current
    await req('POST', '/workspace', { path: WS2, force: true });

    {
      const r = await req('GET', '/workspaces');
      ok('(C) /workspaces ok after switching to WS2', r.status === 200 && r.body.ok === true);
      const list = r.body.workspaces || [];
      const ws1Entry = list.find((w) => w.path === WS1);
      const ws2Entry = list.find((w) => w.path === WS2);
      ok('(C) WS1 still in list after switch', !!ws1Entry);
      ok('(C) WS2 in list', !!ws2Entry);
      ok('(C) WS1 current:false after switch', ws1Entry && ws1Entry.current === false);
      ok('(C) WS2 current:true after switch', ws2Entry && ws2Entry.current === true);
      ok('(C) WS2 name is basename', ws2Entry && ws2Entry.name === path.basename(WS2));
      ok('(C) current field equals WS2', r.body.current === WS2);
      // All entries have non-empty path and name
      ok('(C) all entries have path and name', list.every((w) => w.path && w.name));
      // No duplicates
      const paths = list.map((w) => w.path);
      ok('(C) no duplicate paths', new Set(paths).size === paths.length);
    }

    // (D) workspaces.json registry was persisted — verify file on disk
    {
      let stored;
      try { stored = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'workspaces.json'), 'utf8')); } catch { stored = null; }
      ok('(D) workspaces.json written to disk', Array.isArray(stored));
      ok('(D) WS1 in registry file', Array.isArray(stored) && stored.includes(WS1));
      ok('(D) WS2 in registry file', Array.isArray(stored) && stored.includes(WS2));
    }

    // (E) Back-compat: GET /state without ?workspace= still returns current workspace (WS2)
    {
      const r = await req('GET', '/state');
      ok('(E) /state without ?workspace= returns WS2 (current)', r.status === 200 && r.body.workspace === WS2);
    }

    // (F) GET /state?workspace=WS1 targets WS1 without changing current
    {
      const r = await req('GET', `/state?workspace=${encodeURIComponent(WS1)}`);
      ok('(F) /state?workspace=WS1 returns WS1', r.status === 200 && r.body.workspace === WS1);
      // Current workspace is still WS2
      const ping = await req('GET', '/ping');
      ok('(F) current workspace unchanged after ?workspace= read', ping.body.workspace === WS2);
    }

  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS1, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS2, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
