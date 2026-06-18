#!/usr/bin/env node
// Plain Node test for lib/promotion-gate.js
// Run: node test/promotion-gate.test.js
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

function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-gate-'));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function writeRows(ws, rows) {
  for (const r of rows) appendShadow(ws, r);
}

function makeRow(verdict, shadowVerdict) {
  return { ts: Date.now(), from: 'note:a', to: 'note:b', verdict, shadow_verdict: shadowVerdict, shadow_conf: 0.9, cosine: 0.5, model_version: 'v1' };
}

// Each test gets a fresh require of promotion-gate to avoid module cache issues with env vars.
// We require fresh each time via a delete of the require cache.
function freshModule() {
  const key = require.resolve('../lib/promotion-gate');
  delete require.cache[key];
  return require('../lib/promotion-gate');
}

// --- getPromotionState: missing file returns {promoted: false} ----------------------
{
  const ws = tmpWs();
  const { getPromotionState } = freshModule();
  const result = getPromotionState(ws);
  ok('getPromotionState returns {promoted:false} when file missing', result && result.promoted === false);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- getPromotionState: reads existing state file -----------------------------------
{
  const ws = tmpWs();
  const state = { promoted: true, promotedAt: 12345, rate: 0.91, total: 60 };
  fs.writeFileSync(path.join(ws, '.graph', 'promotion-state.json'), JSON.stringify(state), 'utf8');
  const { getPromotionState } = freshModule();
  const result = getPromotionState(ws);
  ok('getPromotionState reads existing file', result && result.promoted === true && result.rate === 0.91);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- checkAndPromote: below threshold → {promoted: false} --------------------------
{
  const ws = tmpWs();
  // 60 rows at 0.70 agreement (below 0.85 threshold)
  for (let i = 0; i < 60; i++) writeRows(ws, [makeRow('keep', i < 42 ? 'keep' : 'prune')]);
  const { checkAndPromote } = freshModule();
  const result = checkAndPromote(ws);
  ok('checkAndPromote returns {promoted:false} when rate below threshold', result && result.promoted === false);
  ok('promotion-state.json not written when below threshold', !fs.existsSync(path.join(ws, '.graph', 'promotion-state.json')));
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- checkAndPromote: below minRows → {promoted: false} ----------------------------
{
  const ws = tmpWs();
  // Only 20 rows, all agreeing (above rate threshold, but below minRows=50)
  for (let i = 0; i < 20; i++) writeRows(ws, [makeRow('keep', 'keep')]);
  const { checkAndPromote } = freshModule();
  const result = checkAndPromote(ws);
  ok('checkAndPromote returns {promoted:false} when total below minRows', result && result.promoted === false);
  ok('promotion-state.json not written when below minRows', !fs.existsSync(path.join(ws, '.graph', 'promotion-state.json')));
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- checkAndPromote: above threshold + minRows → {promoted:true, justPromoted:true}, writes file --
{
  const ws = tmpWs();
  // 60 rows at 100% agreement (well above 0.85 threshold and 50 minRows)
  for (let i = 0; i < 60; i++) writeRows(ws, [makeRow('keep', 'keep')]);
  const { checkAndPromote } = freshModule();
  const result = checkAndPromote(ws);
  ok('checkAndPromote returns {promoted:true} above threshold+minRows', result && result.promoted === true);
  ok('checkAndPromote returns justPromoted:true on first promotion', result && result.justPromoted === true);
  const stateFile = path.join(ws, '.graph', 'promotion-state.json');
  ok('promotion-state.json written', fs.existsSync(stateFile));
  const written = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ok('written state has promoted:true', written.promoted === true);
  ok('written state has rate field', typeof written.rate === 'number');
  ok('written state has total field', typeof written.total === 'number' && written.total >= 50);
  ok('written state has promotedAt timestamp', typeof written.promotedAt === 'number');
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- checkAndPromote: already promoted → {promoted:true} without re-writing file ---
{
  const ws = tmpWs();
  const originalState = { promoted: true, promotedAt: 99999, rate: 0.88, total: 55 };
  fs.writeFileSync(path.join(ws, '.graph', 'promotion-state.json'), JSON.stringify(originalState), 'utf8');
  const { checkAndPromote } = freshModule();
  const result = checkAndPromote(ws);
  ok('checkAndPromote returns {promoted:true} when already promoted', result && result.promoted === true);
  ok('checkAndPromote does not set justPromoted when already promoted', !result.justPromoted);
  // File should not have been re-written (promotedAt should be unchanged)
  const written = JSON.parse(fs.readFileSync(path.join(ws, '.graph', 'promotion-state.json'), 'utf8'));
  ok('promotion-state.json not re-written when already promoted', written.promotedAt === 99999);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- PROMOTION_THRESHOLD and PROMOTION_MIN_ROWS exported --------------------------
{
  const { PROMOTION_THRESHOLD, PROMOTION_MIN_ROWS } = freshModule();
  ok('PROMOTION_THRESHOLD exported and is a number', typeof PROMOTION_THRESHOLD === 'number');
  ok('PROMOTION_MIN_ROWS exported and is a number', typeof PROMOTION_MIN_ROWS === 'number');
  ok('PROMOTION_THRESHOLD default is 0.85', PROMOTION_THRESHOLD === 0.85);
  ok('PROMOTION_MIN_ROWS default is 50', PROMOTION_MIN_ROWS === 50);
}

// --- checkAndPromote: no shadow data → {promoted: false} ---------------------------
{
  const ws = tmpWs();
  // No shadow-journal.jsonl at all
  const { checkAndPromote } = freshModule();
  const result = checkAndPromote(ws);
  ok('checkAndPromote returns {promoted:false} when no shadow data', result && result.promoted === false);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
