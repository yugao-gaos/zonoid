/**
 * End-to-end test for the bi-temporal supersede round-trip.
 * Spawns a SANDBOXED daemon on a private port (never the live one at 8787): each run
 * used to write two tagged notes into the live KB permanently, and the accumulated
 * near-identical notes eventually crowded the k=10 search window and broke the test.
 * Run: node test/supersede-roundtrip.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-supersede-base-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-supersede-ws-')));
// Reuse the already-downloaded embedding weights if present, so /overlay/note doesn't try a
// network download from the sandboxed (empty) model cache. Absent ⇒ embed() degrades to null.
try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback is fine */ }

const PORT = 19700 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

async function post(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(p) {
  const res = await fetch(`${BASE}${p}`);
  return res.json();
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r && r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Use a unique tag so we can reliably find just our notes in search results.
const TAG = `supersede-test-${Date.now()}`;

test('supersede round-trip', async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
  assert.ok(await waitForPing(), 'sandboxed daemon came up');
  await post('/workspace', { path: WS });

  // ── 1. Create the OLD note ──────────────────────────────────────────────
  const oldTitle = `${TAG} deploy target: fly.io`;
  const oldSummary = `${TAG} we deploy the daemon to fly.io`;

  const r1 = await post('/overlay/note', { title: oldTitle, summary: oldSummary });
  assert.equal(r1.ok, true, 'record old note: ok');
  const oldKey = r1.key;   // 'note:<id>'
  assert.ok(oldKey.startsWith('note:'), `old key looks right: ${oldKey}`);

  // Record the timestamp BETWEEN the two creates so we can query as-of it later.
  const betweenInstant = new Date().toISOString();
  // Give a small temporal gap so betweenInstant < new note's validFrom.
  await new Promise(r => setTimeout(r, 20));

  // ── 2. Create the NEW note, superseding the old ────────────────────────
  const newTitle = `${TAG} deploy target: render.com`;
  const newSummary = `${TAG} we moved the daemon to render.com`;

  const r2 = await post('/overlay/note', {
    title: newTitle,
    summary: newSummary,
    supersedes: oldKey,
  });
  assert.equal(r2.ok, true, 'record new note (with supersedes): ok');
  const newKey = r2.key;
  assert.ok(newKey.startsWith('note:'), `new key looks right: ${newKey}`);
  assert.ok(r2.superseded, 'response carries .superseded metadata');
  assert.equal(r2.superseded.old_key, oldKey, 'superseded.old_key matches old note');

  // ── 3. Verify the old note is stamped with validTo (retired) ──────────
  // search with history:true so we can see both notes.
  const historyResp = await get(`/search?q=${encodeURIComponent(TAG)}&k=10&history=1`);
  const all = historyResp.results || [];

  const oldHit = all.find(r => r.key === oldKey);
  assert.ok(oldHit, 'old note still visible in history search');
  assert.ok(oldHit.validTo, `old note has validTo stamped (got: ${oldHit.validTo})`);
  assert.equal(oldHit.current, false, 'old note is NOT current');

  const newHit = all.find(r => r.key === newKey);
  assert.ok(newHit, 'new note visible in history search');
  assert.equal(newHit.current, true, 'new note IS current');
  assert.ok(!newHit.validTo, 'new note has no validTo (open)');

  // ── 4. Verify search_knowledge (default = current only) returns NEW ────
  const currentResp = await get(`/search?q=${encodeURIComponent(TAG)}&k=10`);
  const currentResults = currentResp.results || [];

  const currentOldHit = currentResults.find(r => r.key === oldKey);
  assert.ok(!currentOldHit, 'old (superseded) note NOT returned by default search');

  const currentNewHit = currentResults.find(r => r.key === newKey);
  assert.ok(currentNewHit, 'new note IS returned by default search');

  // ── 5. Verify as_of=<betweenInstant> returns the OLD note ─────────────
  const asOfResp = await get(
    `/search?q=${encodeURIComponent(TAG)}&k=10&asOf=${encodeURIComponent(betweenInstant)}`
  );
  const asOfResults = asOfResp.results || [];

  const asOfOldHit = asOfResults.find(r => r.key === oldKey);
  assert.ok(asOfOldHit, 'old note IS returned by as-of query (was current then)');

  const asOfNewHit = asOfResults.find(r => r.key === newKey);
  assert.ok(!asOfNewHit, 'new note NOT returned by as-of query (did not exist yet then)');
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    for (const d of [SANDBOX, WS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
});
