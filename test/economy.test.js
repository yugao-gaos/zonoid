#!/usr/bin/env node
// Plain Node test for lib/economy.js
// Run: node test/economy.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { callsAvoided, estimatedSavings, SONNET_COST_PER_CALL_USD } = require('../lib/economy');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-test-'));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function writeLabeledRows(ws, rows) {
  const file = path.join(ws, '.graph', 'gate-labeled.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// --- callsAvoided: missing file → zeros -------------------------------------------
{
  const ws = tmpWs();
  // gate-labeled.jsonl is NOT created
  const result = callsAvoided(ws);
  ok('callsAvoided: missing file → avoided=0', result.avoided === 0);
  ok('callsAvoided: missing file → total_verdicts=0', result.total_verdicts === 0);
  ok('callsAvoided: missing file → fraction=0', result.fraction === 0);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- callsAvoided: all 'judge' rows → avoided=0 ----------------------------------
{
  const ws = tmpWs();
  writeLabeledRows(ws, [
    { by: 'judge', verdict: 'keep' },
    { by: 'judge', verdict: 'prune' },
    { by: 'judge', verdict: 'keep' },
  ]);
  const result = callsAvoided(ws);
  ok('callsAvoided: all judge rows → avoided=0', result.avoided === 0);
  ok('callsAvoided: all judge rows → total_verdicts=3', result.total_verdicts === 3);
  ok('callsAvoided: all judge rows → fraction=0', result.fraction === 0);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- callsAvoided: mixed rows → correct count ------------------------------------
{
  const ws = tmpWs();
  writeLabeledRows(ws, [
    { by: 'judge', verdict: 'keep' },
    { by: 'model', verdict: 'keep' },
    { by: 'judge', verdict: 'prune' },
    { by: 'model', verdict: 'prune' },
    { by: 'model', verdict: 'keep' },
  ]);
  const result = callsAvoided(ws);
  ok('callsAvoided: mixed → avoided=3', result.avoided === 3);
  ok('callsAvoided: mixed → total_verdicts=5', result.total_verdicts === 5);
  ok('callsAvoided: mixed → fraction=0.6', Math.abs(result.fraction - 0.6) < 1e-9);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- callsAvoided: all 'model' rows → avoided=count ------------------------------
{
  const ws = tmpWs();
  writeLabeledRows(ws, [
    { by: 'model', verdict: 'keep' },
    { by: 'model', verdict: 'prune' },
  ]);
  const result = callsAvoided(ws);
  ok('callsAvoided: all model rows → avoided=2', result.avoided === 2);
  ok('callsAvoided: all model rows → total_verdicts=2', result.total_verdicts === 2);
  ok('callsAvoided: all model rows → fraction=1', result.fraction === 1);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- callsAvoided: skips malformed JSON lines -----------------------------------
{
  const ws = tmpWs();
  const file = path.join(ws, '.graph', 'gate-labeled.jsonl');
  fs.writeFileSync(file, '{"by":"model","verdict":"keep"}\nnot-json\n{"by":"judge","verdict":"prune"}\n');
  const result = callsAvoided(ws);
  ok('callsAvoided: skips malformed → avoided=1', result.avoided === 1);
  ok('callsAvoided: skips malformed → total_verdicts=2', result.total_verdicts === 2);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- callsAvoided: empty file → zeros -------------------------------------------
{
  const ws = tmpWs();
  fs.writeFileSync(path.join(ws, '.graph', 'gate-labeled.jsonl'), '');
  const result = callsAvoided(ws);
  ok('callsAvoided: empty file → avoided=0', result.avoided === 0);
  ok('callsAvoided: empty file → total_verdicts=0', result.total_verdicts === 0);
  ok('callsAvoided: empty file → fraction=0', result.fraction === 0);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- callsAvoided: never throws on null ws --------------------------------------
{
  let threw = false;
  let result;
  try { result = callsAvoided(null); } catch { threw = true; }
  ok('callsAvoided: does not throw on null workspace', !threw);
  ok('callsAvoided: returns zeros on null workspace', result && result.avoided === 0);
}

// --- estimatedSavings: returns cost fields --------------------------------------
{
  const ws = tmpWs();
  writeLabeledRows(ws, [
    { by: 'model', verdict: 'keep' },
    { by: 'model', verdict: 'prune' },
    { by: 'judge', verdict: 'keep' },
  ]);
  const result = estimatedSavings(ws);
  ok('estimatedSavings: avoided=2', result.avoided === 2);
  ok('estimatedSavings: total_verdicts=3', result.total_verdicts === 3);
  ok('estimatedSavings: has estimated_cost_usd', typeof result.estimated_cost_usd === 'number');
  ok('estimatedSavings: estimated_cost_usd = avoided * SONNET_COST_PER_CALL_USD', Math.abs(result.estimated_cost_usd - 2 * SONNET_COST_PER_CALL_USD) < 1e-12);
  ok('estimatedSavings: has cost_per_call_usd', result.cost_per_call_usd === SONNET_COST_PER_CALL_USD);
  ok('estimatedSavings: note = "estimated"', result.note === 'estimated');
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- estimatedSavings: 0 avoided → cost_usd=0 ----------------------------------
{
  const ws = tmpWs();
  writeLabeledRows(ws, [
    { by: 'judge', verdict: 'keep' },
    { by: 'judge', verdict: 'prune' },
  ]);
  const result = estimatedSavings(ws);
  ok('estimatedSavings: 0 avoided → estimated_cost_usd=0', result.estimated_cost_usd === 0);
  ok('estimatedSavings: 0 avoided → avoided=0', result.avoided === 0);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- estimatedSavings: missing file → all zeros, note=estimated ----------------
{
  const ws = tmpWs();
  const result = estimatedSavings(ws);
  ok('estimatedSavings: missing file → avoided=0', result.avoided === 0);
  ok('estimatedSavings: missing file → estimated_cost_usd=0', result.estimated_cost_usd === 0);
  ok('estimatedSavings: missing file → note=estimated', result.note === 'estimated');
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- SONNET_COST_PER_CALL_USD is 0.011 ----------------------------------------
{
  ok('SONNET_COST_PER_CALL_USD is 0.011', SONNET_COST_PER_CALL_USD === 0.011);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
