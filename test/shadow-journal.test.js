#!/usr/bin/env node
// Plain Node test for lib/shadow-journal.js — the learned-model shadow journal.
// Run: node test/shadow-journal.test.js
//
// Properties tested (agreementRate tests added below the existing appendShadow suite):
//   - appendShadow writes a valid JSON line to <ws>/.graph/shadow-journal.jsonl
//   - Shadow row has all expected schema fields
//   - appendShadow is best-effort: never throws on I/O error or missing directory
//   - Multiple rows accumulate (one line per call)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendShadow, agreementRate } = require('../lib/shadow-journal');

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

// ═══════════════════════════════════════════════════════════════════════════
// agreementRate tests
// ═══════════════════════════════════════════════════════════════════════════

// --- agreementRate returns null on missing file ----------------------------------
{
  const ws = tmpWs();
  // shadow-journal.jsonl is NOT created
  const result = agreementRate(ws);
  ok('agreementRate returns null when file is missing', result === null);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- agreementRate returns null on null workspace --------------------------------
{
  let threw = false;
  let result;
  try { result = agreementRate(null); } catch { threw = true; }
  ok('agreementRate does not throw on null workspace', !threw);
  ok('agreementRate returns null on null workspace', result === null);
}

// --- agreementRate returns null when file has no valid rows ----------------------
{
  const ws = tmpWs();
  // Write a file with only blank lines / malformed JSON
  fs.writeFileSync(path.join(ws, '.graph', 'shadow-journal.jsonl'), '\n\nnot-json\n\n');
  const result = agreementRate(ws);
  ok('agreementRate returns null when no valid rows exist', result === null);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- agreementRate: rate is 1.0 when all rows agree ------------------------------
{
  const ws = tmpWs();
  appendShadow(ws, { ts: 1, from: 'a', to: 'b', verdict: 'keep',  shadow_verdict: 'keep',  shadow_conf: 0.9, cosine: 0.5, model_version: 'v1' });
  appendShadow(ws, { ts: 2, from: 'c', to: 'd', verdict: 'prune', shadow_verdict: 'prune', shadow_conf: 0.2, cosine: 0.1, model_version: 'v1' });
  appendShadow(ws, { ts: 3, from: 'e', to: 'f', verdict: 'keep',  shadow_verdict: 'keep',  shadow_conf: 0.8, cosine: 0.6, model_version: 'v1' });

  const result = agreementRate(ws);
  ok('agreementRate result is not null (3 agreeing rows)', result !== null);
  ok('agreementRate total = 3', result && result.total === 3);
  ok('agreementRate agreed = 3', result && result.agreed === 3);
  ok('agreementRate rate = 1.0 when all agree', result && result.rate === 1.0);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- agreementRate: rate is 0.0 when no rows agree ------------------------------
{
  const ws = tmpWs();
  appendShadow(ws, { ts: 1, from: 'a', to: 'b', verdict: 'keep',  shadow_verdict: 'prune', shadow_conf: 0.3, cosine: 0.4, model_version: 'v1' });
  appendShadow(ws, { ts: 2, from: 'c', to: 'd', verdict: 'prune', shadow_verdict: 'keep',  shadow_conf: 0.7, cosine: 0.6, model_version: 'v1' });

  const result = agreementRate(ws);
  ok('agreementRate total = 2 (disagreeing rows)', result && result.total === 2);
  ok('agreementRate agreed = 0 when none agree', result && result.agreed === 0);
  ok('agreementRate rate = 0.0 when none agree', result && result.rate === 0.0);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- agreementRate: correct partial rate ----------------------------------------
{
  const ws = tmpWs();
  // 3 agree, 1 disagrees → rate = 0.75
  appendShadow(ws, { ts: 1, from: 'a', to: 'b', verdict: 'keep',  shadow_verdict: 'keep',  shadow_conf: 0.9, cosine: 0.5, model_version: 'v1' });
  appendShadow(ws, { ts: 2, from: 'c', to: 'd', verdict: 'keep',  shadow_verdict: 'keep',  shadow_conf: 0.8, cosine: 0.6, model_version: 'v1' });
  appendShadow(ws, { ts: 3, from: 'e', to: 'f', verdict: 'prune', shadow_verdict: 'prune', shadow_conf: 0.2, cosine: 0.2, model_version: 'v1' });
  appendShadow(ws, { ts: 4, from: 'g', to: 'h', verdict: 'keep',  shadow_verdict: 'prune', shadow_conf: 0.3, cosine: 0.4, model_version: 'v1' });

  const result = agreementRate(ws);
  ok('agreementRate total = 4', result && result.total === 4);
  ok('agreementRate agreed = 3', result && result.agreed === 3);
  ok('agreementRate rate = 0.75', result && Math.abs(result.rate - 0.75) < 1e-9);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- agreementRate respects the window parameter (tail behaviour) ---------------
{
  const ws = tmpWs();
  // Write 5 rows: first 3 all DISAGREE, last 2 AGREE. window=2 should see only the last 2.
  appendShadow(ws, { ts: 1, from: 'a', to: 'b', verdict: 'keep',  shadow_verdict: 'prune', shadow_conf: 0.3, cosine: 0.4, model_version: 'v1' });
  appendShadow(ws, { ts: 2, from: 'c', to: 'd', verdict: 'keep',  shadow_verdict: 'prune', shadow_conf: 0.4, cosine: 0.3, model_version: 'v1' });
  appendShadow(ws, { ts: 3, from: 'e', to: 'f', verdict: 'prune', shadow_verdict: 'keep',  shadow_conf: 0.6, cosine: 0.5, model_version: 'v1' });
  appendShadow(ws, { ts: 4, from: 'g', to: 'h', verdict: 'keep',  shadow_verdict: 'keep',  shadow_conf: 0.8, cosine: 0.7, model_version: 'v1' });
  appendShadow(ws, { ts: 5, from: 'i', to: 'j', verdict: 'prune', shadow_verdict: 'prune', shadow_conf: 0.2, cosine: 0.1, model_version: 'v1' });

  const full   = agreementRate(ws, 200);  // sees all 5: 2 agree → rate 0.4
  const windowed = agreementRate(ws, 2);  // sees only rows 4+5: both agree → rate 1.0

  ok('agreementRate full window total = 5', full && full.total === 5);
  ok('agreementRate full window agreed = 2', full && full.agreed === 2);
  ok('agreementRate full window rate ≈ 0.4', full && Math.abs(full.rate - 0.4) < 1e-9);

  ok('agreementRate windowed total = 2', windowed && windowed.total === 2);
  ok('agreementRate windowed agreed = 2', windowed && windowed.agreed === 2);
  ok('agreementRate windowed rate = 1.0 (tail-2 rows both agree)', windowed && windowed.rate === 1.0);
  ok('agreementRate window_used = 2', windowed && windowed.window_used === 2);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- agreementRate returns { total, agreed, rate, window_used } shape ----------
{
  const ws = tmpWs();
  appendShadow(ws, { ts: 1, from: 'a', to: 'b', verdict: 'keep', shadow_verdict: 'keep', shadow_conf: 0.9, cosine: 0.5, model_version: 'v1' });
  const result = agreementRate(ws);
  ok('agreementRate result has total field', result && typeof result.total === 'number');
  ok('agreementRate result has agreed field', result && typeof result.agreed === 'number');
  ok('agreementRate result has rate field', result && typeof result.rate === 'number');
  ok('agreementRate result has window_used field', result && typeof result.window_used === 'number');
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
