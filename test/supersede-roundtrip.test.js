/**
 * End-to-end test for the bi-temporal supersede round-trip.
 * Uses only HTTP calls to the running daemon at http://localhost:8787.
 * Run: node --test test/supersede-roundtrip.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'http://localhost:8787';

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

// Use a unique tag so we can reliably find just our notes in search results.
const TAG = `supersede-test-${Date.now()}`;

test('supersede round-trip', async (t) => {
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
});
