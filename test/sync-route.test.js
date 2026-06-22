#!/usr/bin/env node
// Integration test for POST /sync — the explicit pull trigger for file-drop task adoption
// (multi-harness plan Phase 2, deliverable 2).
//
// Covers:
//   (A) response shape: { ok, adopted: [task_key...], suggestions: { <task_key>: [...] } }
//   (B) idempotency: a second /sync with no new files returns adopted: []
//   (C) incremental adoption: only files dropped SINCE the last sync are adopted; link
//       suggestions reuse the /task/suggest machinery (same scored shape) and the
//       cross-stub dependency edge appears in the graph
//   (D) non-current-workspace targeting ({ workspace } body, targetOverlay pattern) stays
//       idempotent too (the route's own timestamp stamping path)
//
// Sandboxed-daemon convention: private port + tmp CLAUDE_PLUGIN_DATA (see app-restart.test.js).
// Run: node test/sync-route.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sync-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX; // before the require — module reads env at load
const filedrop = require('../lib/filedrop-tasks');

const PORT = 20400 + Math.floor(Math.random() * 100);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sync-ws-')));
const WS2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sync-ws2-')));

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
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function dropStub(ws, harness, id, extra = {}) {
  const dir = path.join(filedrop.dirFor(ws), harness);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, subject: `payment gateway ${id}`, ...extra }, null, 2));
  fs.renameSync(tmp, file);
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ZONOID_EMBED_PROVIDER: 'voyage', VOYAGE_API_KEY: '' },
    stdio: 'ignore',
  });

  try {
    ok('daemon came up', await waitForPing());
    await req('POST', '/workspace', { path: WS });

    // ------------------------------------------------------------------
    // (A) first sync adopts the dropped stub, with suggestions per adoptee
    // ------------------------------------------------------------------
    dropStub(WS, 'cursor', 'one', { description: 'refactor the payment gateway module' });
    const s1 = await req('POST', '/sync', { workspace: WS });
    ok('(A) /sync returns 200 ok', s1.status === 200 && s1.body.ok === true);
    ok('(A) adopted lists the new stub key', Array.isArray(s1.body.adopted) && s1.body.adopted.includes('cursor/one'));
    ok('(A) suggestions keyed per adopted task', s1.body.suggestions && Array.isArray(s1.body.suggestions['cursor/one']));

    // ------------------------------------------------------------------
    // (B) idempotency: nothing new -> adopted: []
    // ------------------------------------------------------------------
    const s2 = await req('POST', '/sync', { workspace: WS });
    ok('(B) second sync adopts nothing', s2.status === 200 && Array.isArray(s2.body.adopted) && s2.body.adopted.length === 0);
    ok('(B) second sync has empty suggestions map', s2.body.suggestions && Object.keys(s2.body.suggestions).length === 0);

    // ------------------------------------------------------------------
    // (C) incremental adoption + /task/suggest machinery reuse + dep edge
    // ------------------------------------------------------------------
    dropStub(WS, 'cursor', 'two', { blockedBy: ['one'] });
    dropStub(WS, 'codex', 'three', { description: 'unlinked but related payment gateway work' });
    const s3 = await req('POST', '/sync', { workspace: WS });
    ok('(C) only the NEW stubs are adopted', s3.body.adopted.length === 2 && s3.body.adopted.includes('cursor/two') && s3.body.adopted.includes('codex/three'));
    const sug = (s3.body.suggestions['codex/three'] || []);
    ok('(C) related unlinked stub is suggested', sug.some((c) => (c.key === 'cursor/one' || c.key === 'cursor/two') && c.score > 0));
    ok('(C) already-linked dep is NOT re-suggested', !(s3.body.suggestions['cursor/two'] || []).some((c) => c.key === 'cursor/one'));
    ok('(C) suggestion entries carry the /task/suggest shape', sug.every((c) => 'key' in c && 'label' in c && 'status' in c && 'score' in c && 'suggest_kind' in c));
    const viaRoute = (await req('GET', `/task/suggest?workspace=${encodeURIComponent(WS)}&key=${encodeURIComponent('codex/three')}`)).body;
    ok('(C) /sync suggestions match GET /task/suggest (shared helper)', JSON.stringify(viaRoute.suggestions) === JSON.stringify(sug));
    const g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const two = g.tasks.find((t) => t.id === 'cursor/two');
    ok('(C) dependency edge present in the graph', two && two.deps.includes('cursor/one'));
    const s4 = await req('POST', '/sync', { workspace: WS });
    ok('(C) follow-up sync is idempotent again', s4.body.adopted.length === 0);

    // ------------------------------------------------------------------
    // (D) non-current workspace targeting stays idempotent
    // ------------------------------------------------------------------
    dropStub(WS2, 'codex', 'z9', { description: 'standalone task in another workspace' });
    const o1 = await req('POST', '/sync', { workspace: WS2 });
    ok('(D) sync of a non-current workspace adopts its stub', o1.body.adopted.includes('codex/z9'));
    const o2 = await req('POST', '/sync', { workspace: WS2 });
    ok('(D) second sync of the non-current workspace adopts nothing', o2.body.adopted.length === 0);
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS2, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
