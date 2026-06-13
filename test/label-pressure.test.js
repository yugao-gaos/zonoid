#!/usr/bin/env node
// Tests for GET /label/pressure — gradable backlog depth and capacity-gated nudge.
// Run: node test/label-pressure.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const labelRoute = require('../routes/label');
const { DEFAULT_MAX_RUNNING } = require('../lib/pressure-nudge');
const { rowKey, journalPath, labeledPath } = require('../scripts/gate-label');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

function makeTempWs() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-label-pressure-ws-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function writeJournal(ws, rows) {
  fs.writeFileSync(journalPath(ws), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function writeLabeled(ws, rows) {
  fs.writeFileSync(labeledPath(ws), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function makeRow(i, taskKey) {
  return { ts: `2026-06-12T00:00:${String(i).padStart(2, '0')}Z`, task_key: taskKey, query: `q${i}`, decision: 'abstain' };
}

function makeMockCtx(overlay, ws, terminalTaskIds, extraTasks) {
  let lastSent = null;
  const tasks = (terminalTaskIds || []).map((id) => ({ id, status: 'done', label: id }));
  if (extraTasks) tasks.push(...extraTasks);
  const ctx = {
    get state() { return { overlay, workspace: ws }; },
    send(res, status, body) { lastSent = { status, body }; },
    readBody: async () => ({}),
    notifyChange: () => {},
    buildGraph: () => ({ tasks }),
    targetOverlay: () => ({ ov: overlay, ws: null, save: () => {} }),
  };
  function getLastSent() { return lastSent; }
  return { ctx, getLastSent };
}

async function callPressure(ctx) {
  const route = labelRoute(ctx);
  const mockReq = { method: 'GET' };
  const mockRes = {};
  const mockU = { pathname: '/label/pressure', searchParams: { get: () => null } };
  return route('/label/pressure', 'GET', mockReq, mockRes, mockU, null);
}

(async () => {
  // ── 1: empty backlog → nudge:false ────────────────────────────────────────────
  {
    const ws = makeTempWs();
    const overlay = ov.EMPTY();
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, []);
    const handled = await callPressure(ctx);
    const result = getLastSent();
    ok('empty-backlog: handled returns true', handled === true);
    ok('empty-backlog: status 200', result && result.status === 200);
    ok('empty-backlog: nudge:false', result && result.body.nudge === false);
    ok('empty-backlog: depth == 0', result && result.body.depth === 0);
    ok('empty-backlog: harness_task_key correct', result && result.body.harness_task_key === labelRoute.HARNESS_LABEL_DRAIN_KEY);
  }

  // ── 2: below threshold (9 rows) → nudge:false ────────────────────────────────
  {
    const ws = makeTempWs();
    const rows = Array.from({ length: 9 }, (_, i) => makeRow(i, `task-${i}`));
    writeJournal(ws, rows);
    const terminalIds = rows.map((r) => r.task_key);
    const overlay = ov.EMPTY();
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds);
    await callPressure(ctx);
    const result = getLastSent();
    ok('below-threshold: nudge:false', result && result.body.nudge === false);
    ok('below-threshold: depth == 9', result && result.body.depth === 9);
  }

  // ── 3: at threshold (10 rows) → nudge:true ───────────────────────────────────
  {
    const ws = makeTempWs();
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i, `task-${i}`));
    writeJournal(ws, rows);
    const terminalIds = rows.map((r) => r.task_key);
    const overlay = ov.EMPTY();
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds);
    const handled = await callPressure(ctx);
    const result = getLastSent();
    ok('at-threshold: handled:true', handled === true);
    ok('at-threshold: nudge:true', result && result.body.nudge === true);
    ok('at-threshold: depth == 10', result && result.body.depth === 10);
    ok('at-threshold: harness_task_key correct', result && result.body.harness_task_key === 'followup/harness-label-drain');
  }

  // ── 4: immediate repeat → nudge:true (no debounce) ──────────────────────────
  {
    const ws = makeTempWs();
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i, `task-${i}`));
    writeJournal(ws, rows);
    const terminalIds = rows.map((r) => r.task_key);
    const overlay = ov.EMPTY();
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds);
    await callPressure(ctx);
    await callPressure(ctx);
    const result = getLastSent();
    ok('immediate repeat: nudge:true', result && result.body.nudge === true);
    ok('immediate repeat: depth still reported', result && result.body.depth >= 10);
  }

  // ── 5: at capacity → nudge:false ─────────────────────────────────────────────
  {
    const ws = makeTempWs();
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i, `task-${i}`));
    writeJournal(ws, rows);
    const terminalIds = rows.map((r) => r.task_key);
    const overlay = ov.EMPTY();
    const extra = Array.from({ length: DEFAULT_MAX_RUNNING }, (_, i) => ({ id: `task/r${i}`, status: 'in_progress' }));
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds, extra);
    await callPressure(ctx);
    const result = getLastSent();
    ok('at capacity: nudge:false', result && result.body.nudge === false);
    ok('at capacity: capacity_ok false', result && result.body.capacity_ok === false);
  }

  // ── 6: harness drain in_progress → nudge:false ──────────────────────────────
  {
    const ws = makeTempWs();
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i, `task-${i}`));
    writeJournal(ws, rows);
    const terminalIds = rows.map((r) => r.task_key);
    const overlay = ov.EMPTY();
    overlay.status[labelRoute.HARNESS_LABEL_DRAIN_KEY] = 'in_progress';
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds);
    await callPressure(ctx);
    const result = getLastSent();
    ok('harness in_progress: nudge:false', result && result.body.nudge === false);
    ok('harness in_progress: drain_in_progress true', result && result.body.drain_in_progress === true);
  }

  // ── 7: already-labeled rows excluded from depth ───────────────────────────────
  {
    const ws = makeTempWs();
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i, `task-${i}`));
    writeJournal(ws, rows);
    const labeledEntries = rows.slice(0, 5).map((r) => ({ ...r, _key: rowKey(r), label: 0, quadrant: 'TN' }));
    writeLabeled(ws, labeledEntries);
    const terminalIds = rows.map((r) => r.task_key);
    const overlay = ov.EMPTY();
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds);
    await callPressure(ctx);
    const result = getLastSent();
    ok('dedup: depth excludes already-labeled rows', result && result.body.depth === 5);
    ok('dedup: nudge:false (5 < threshold 10)', result && result.body.nudge === false);
  }

  // ── 8: non-terminal tasks excluded from depth ─────────────────────────────────
  {
    const ws = makeTempWs();
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(i, `task-${i}`));
    writeJournal(ws, rows);
    const terminalIds = rows.slice(0, 5).map((r) => r.task_key);
    const overlay = ov.EMPTY();
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds);
    await callPressure(ctx);
    const result = getLastSent();
    ok('non-terminal: depth only counts terminal rows', result && result.body.depth === 5);
    ok('non-terminal: nudge:false (5 < threshold 10)', result && result.body.nudge === false);
  }

  // ── 9: rows with null task_key excluded ──────────────────────────────────────
  {
    const ws = makeTempWs();
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => makeRow(i, `task-${i}`)),
      { ts: '2026-06-12T00:01:00Z', task_key: null, query: 'null-row', decision: 'abstain' },
    ];
    writeJournal(ws, rows);
    const terminalIds = rows.filter((r) => r.task_key).map((r) => r.task_key);
    const overlay = ov.EMPTY();
    const { ctx, getLastSent } = makeMockCtx(overlay, ws, terminalIds);
    await callPressure(ctx);
    const result = getLastSent();
    ok('null-task_key: null rows excluded from depth', result && result.body.depth === 10);
    ok('null-task_key: nudge:true (10 >= threshold)', result && result.body.nudge === true);
  }

  // ── 10: ensureHarnessLabelDrainTask creates node idempotently ─────────────────
  {
    const overlay = ov.EMPTY();
    const save = () => {};
    const key = labelRoute.HARNESS_LABEL_DRAIN_KEY;
    ok('ensure: node absent before call', !overlay.snapshots || !overlay.snapshots[key]);
    labelRoute.ensureHarnessLabelDrainTask(overlay, save);
    ok('ensure: node present after first call', overlay.snapshots && !!overlay.snapshots[key]);
    const snap1 = JSON.stringify(overlay.snapshots[key]);
    labelRoute.ensureHarnessLabelDrainTask(overlay, save);
    ok('ensure: node unchanged after second call (idempotent)', JSON.stringify(overlay.snapshots[key]) === snap1);
    ok('ensure: subject is harness label drain', overlay.snapshots[key].subject === 'harness: label drain');
    ok('ensure: not in unwired quarantine', !overlay.unwired || !overlay.unwired[key]);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
