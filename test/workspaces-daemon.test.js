#!/usr/bin/env node
// Integration test for GET /workspaces — asserts the union list, current flag, and basename name.
// P3 (deprecate-global-workspace): there is NO daemon-global current pointer. The `current` flag
// reflects the OPTIONAL ?workspace= the caller passes; /state without a workspace 400s; and
// multiple workspaces stay isolated (each ?workspace= read targets exactly that workspace).
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
// Each gets a .graph sub-dir so the existence+.graph filter in GET /workspaces lets them through.
const WS1 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslist-ws1-')));
fs.mkdirSync(path.join(WS1, '.graph'), { recursive: true });
const WS2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslist-ws2-')));
fs.mkdirSync(path.join(WS2, '.graph'), { recursive: true });

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

    // (B) Register WS1. P3: there is NO daemon-global current pointer — the `current` flag on
    // /workspaces reflects the OPTIONAL ?workspace= the CALLER passes, not a server-side default.
    await req('POST', '/workspace', { path: WS1 });

    {
      const r = await req('GET', `/workspaces?workspace=${encodeURIComponent(WS1)}`);
      ok('(B) /workspaces ok after registering WS1', r.status === 200 && r.body.ok === true);
      const list = r.body.workspaces || [];
      const ws1Entry = list.find((w) => w.path === WS1);
      ok('(B) WS1 appears in list', !!ws1Entry);
      ok('(B) WS1 has current:true when ?workspace=WS1', ws1Entry && ws1Entry.current === true);
      ok('(B) WS1 name is basename', ws1Entry && ws1Entry.name === path.basename(WS1));
      ok('(B) current field echoes the ?workspace= param (WS1)', r.body.current === WS1);
    }

    {
      // No ?workspace= ⇒ no current (P3: no global default to seed it).
      const r = await req('GET', '/workspaces');
      ok('(B) /workspaces without ?workspace= has current:null', r.body.current === null);
      const ws1Entry = (r.body.workspaces || []).find((w) => w.path === WS1);
      ok('(B) WS1 still listed but current:false without ?workspace=', ws1Entry && ws1Entry.current === false);
    }

    // (C) Register WS2 — both appear; `current` follows whichever ?workspace= the caller asks for.
    await req('POST', '/workspace', { path: WS2, force: true });

    {
      const r = await req('GET', `/workspaces?workspace=${encodeURIComponent(WS2)}`);
      ok('(C) /workspaces ok after registering WS2', r.status === 200 && r.body.ok === true);
      const list = r.body.workspaces || [];
      const ws1Entry = list.find((w) => w.path === WS1);
      const ws2Entry = list.find((w) => w.path === WS2);
      ok('(C) WS1 still in list', !!ws1Entry);
      ok('(C) WS2 in list', !!ws2Entry);
      ok('(C) WS1 current:false when ?workspace=WS2', ws1Entry && ws1Entry.current === false);
      ok('(C) WS2 current:true when ?workspace=WS2', ws2Entry && ws2Entry.current === true);
      ok('(C) WS2 name is basename', ws2Entry && ws2Entry.name === path.basename(WS2));
      ok('(C) current field echoes ?workspace= (WS2)', r.body.current === WS2);
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

    // (E) P3: GET /state without ?workspace= 400s (no daemon-global default to fall back onto).
    {
      const r = await req('GET', '/state');
      ok('(E) /state without ?workspace= returns 400 (no global default)', r.status === 400 && r.body.ok === false);
    }

    // (F) GET /state?workspace=WSn targets exactly that workspace (per-request binding, isolated).
    {
      const r1 = await req('GET', `/state?workspace=${encodeURIComponent(WS1)}`);
      ok('(F) /state?workspace=WS1 returns WS1', r1.status === 200 && r1.body.workspace === WS1);
      const r2 = await req('GET', `/state?workspace=${encodeURIComponent(WS2)}`);
      ok('(F) /state?workspace=WS2 returns WS2 (no global pointer to clobber)', r2.status === 200 && r2.body.workspace === WS2);
    }

    // (G) Ghost path: a path that never existed on disk is dropped from /workspaces.
    // Inject a nonexistent path directly into the registry file; the daemon reads it fresh.
    {
      const GHOST = path.join(os.tmpdir(), 'orch-wslist-ghost-never-existed-' + Date.now());
      const wsFile = path.join(SANDBOX, 'workspaces.json');
      let known = [];
      try { known = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch { /* */ }
      if (!Array.isArray(known)) known = [];
      if (!known.includes(GHOST)) { known.push(GHOST); fs.writeFileSync(wsFile, JSON.stringify(known)); }

      const r = await req('GET', '/workspaces');
      ok('(G) /workspaces ok with ghost in registry', r.status === 200 && r.body.ok === true);
      const list = r.body.workspaces || [];
      ok('(G) ghost nonexistent path is absent from list', !list.some((w) => w.path === GHOST));
      // Real workspaces are still present
      ok('(G) WS2 still in list despite ghost', list.some((w) => w.path === WS2));
    }

    // (H) Removed-dir workspace disappears: delete WS1 from disk; it should drop out of the list.
    // WS1 is currently in the registry (added during (B)/(C)) but its dir is now removed.
    {
      try { fs.rmSync(WS1, { recursive: true, force: true }); } catch { /* */ }
      const r = await req('GET', '/workspaces');
      ok('(H) /workspaces ok after WS1 removed', r.status === 200 && r.body.ok === true);
      const list = r.body.workspaces || [];
      ok('(H) removed WS1 dir no longer in list', !list.some((w) => w.path === WS1));
      ok('(H) WS2 still present after WS1 removed', list.some((w) => w.path === WS2));
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
