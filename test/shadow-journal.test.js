#!/usr/bin/env node
// Plain Node test for lib/shadow-journal.js — the learned-model shadow journal.
// Run: node test/shadow-journal.test.js
//
// Properties tested:
//   - appendShadow writes a valid JSON line to <ws>/.graph/shadow-journal.jsonl
//   - Shadow row has all expected schema fields
//   - appendShadow is best-effort: never throws on I/O error or missing directory
//   - Multiple rows accumulate (one line per call)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendShadow } = require('../lib/shadow-journal');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// Create a temporary workspace with a .graph directory.
function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-journal-'));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

// Read all rows from the shadow journal; returns [] if missing.
function readShadow(ws) {
  const file = path.join(ws, '.graph', 'shadow-journal.jsonl');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// --- appendShadow writes a valid JSON line to the output file -------------------------------------
{
  const ws = tmpWs();
  const row = {
    ts: Date.now(),
    from: 'note:abc',
    to: 'task:xyz',
    verdict: 'keep',
    shadow_verdict: 'prune',
    shadow_conf: 0.62,
    cosine: 0.45,
    model_version: 'v1',
  };
  appendShadow(ws, row);

  const file = path.join(ws, '.graph', 'shadow-journal.jsonl');
  ok('shadow-journal.jsonl exists after appendShadow', fs.existsSync(file));

  const raw = fs.readFileSync(file, 'utf8');
  ok('file content is a single newline-terminated line', raw.endsWith('\n') && raw.trim().split('\n').length === 1);

  let parsed;
  try { parsed = JSON.parse(raw.trim()); } catch { parsed = null; }
  ok('written line is valid JSON', parsed !== null);

  fs.rmSync(ws, { recursive: true, force: true });
}

// --- shadow row has all expected schema fields ----------------------------------------------------
{
  const ws = tmpWs();
  const now = Date.now();
  const row = {
    ts: now,
    from: 'note:a',
    to: 'note:b',
    verdict: 'prune',
    shadow_verdict: 'keep',
    shadow_conf: 0.78,
    cosine: 0.37,
    model_version: 'v1',
  };
  appendShadow(ws, row);
  const rows = readShadow(ws);

  ok('exactly one row written', rows.length === 1);

  const r = rows[0];
  ok('ts field present and numeric', typeof r.ts === 'number');
  ok('ts value matches input', r.ts === now);
  ok('from field correct', r.from === 'note:a');
  ok('to field correct', r.to === 'note:b');
  ok('verdict field correct (Sonnet verdict)', r.verdict === 'prune');
  ok('shadow_verdict field correct', r.shadow_verdict === 'keep');
  ok('shadow_conf is a number', typeof r.shadow_conf === 'number');
  ok('shadow_conf value matches', Math.abs(r.shadow_conf - 0.78) < 1e-9);
  ok('cosine field correct', r.cosine === 0.37);
  ok('model_version is v1', r.model_version === 'v1');

  fs.rmSync(ws, { recursive: true, force: true });
}

// --- multiple rows accumulate correctly ----------------------------------------------------------
{
  const ws = tmpWs();
  appendShadow(ws, { ts: 1, from: 'note:a', to: 'note:b', verdict: 'keep', shadow_verdict: 'keep', shadow_conf: 0.9, cosine: 0.5, model_version: 'v1' });
  appendShadow(ws, { ts: 2, from: 'note:c', to: 'task:d', verdict: 'prune', shadow_verdict: 'prune', shadow_conf: 0.3, cosine: 0.28, model_version: 'v1' });

  const rows = readShadow(ws);
  ok('two rows accumulate', rows.length === 2);
  ok('first row has ts=1', rows[0].ts === 1);
  ok('second row has ts=2', rows[1].ts === 2);
  ok('rows are independent', rows[0].from === 'note:a' && rows[1].from === 'note:c');

  fs.rmSync(ws, { recursive: true, force: true });
}

// --- appendShadow is best-effort: never throws when .graph dir is missing ------------------------
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-journal-nodotgraph-'));
  // Intentionally DO NOT create .graph/ — appendShadow must absorb the ENOENT.
  let threw = false;
  try {
    appendShadow(ws, { ts: Date.now(), from: 'a', to: 'b', verdict: 'keep', shadow_verdict: 'keep', shadow_conf: 0.5, cosine: 0.4, model_version: 'v1' });
  } catch { threw = true; }
  ok('appendShadow does not throw when .graph dir is missing', !threw);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- appendShadow is best-effort: never throws on non-string ws ----------------------------------
{
  let threw = false;
  try { appendShadow(null, { ts: 1 }); } catch { threw = true; }
  ok('appendShadow does not throw on null workspace', !threw);
}

// --- verdict values: keep and prune are the only meaningful shadow_verdict strings ---------------
{
  const ws = tmpWs();
  appendShadow(ws, { ts: 1, from: 'note:x', to: 'note:y', verdict: 'keep', shadow_verdict: 'prune', shadow_conf: 0.2, cosine: 0.32, model_version: 'v1' });
  const rows = readShadow(ws);
  ok('shadow_verdict can be prune even when Sonnet kept', rows[0].shadow_verdict === 'prune' && rows[0].verdict === 'keep');
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- schema: model_version is always v1 (contract for this release) -----------------------------
{
  const ws = tmpWs();
  appendShadow(ws, { ts: Date.now(), from: 'a', to: 'b', verdict: 'prune', shadow_verdict: 'prune', shadow_conf: 0.55, cosine: 0.4, model_version: 'v1' });
  const rows = readShadow(ws);
  ok('model_version is stored as written (v1)', rows[0].model_version === 'v1');
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
