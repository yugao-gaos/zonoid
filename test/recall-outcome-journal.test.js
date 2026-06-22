#!/usr/bin/env node
// Tests that the recall→outcome attribution seam works end-to-end:
//
//   1. A /search?task_key= call writes a 'pending' row to recall-outcome-journal.jsonl
//      capturing which note keys were in the assembled context bundle.
//   2. A terminal status write (POST /overlay/status with done/tested/failed/canceled)
//      appends a resolved outcome row joining by task_key.
//   3. Readers (readRows / latestByTask) parse the rows correctly.
//   4. Journal-write failure does NOT break the search or status response (fail-open).
//
// Mirrors gate-journal.test.js: sandboxed daemon on a private port, temp workspace.
//
// Run: node test/recall-outcome-journal.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');

// ── Sandbox: private CLAUDE_PLUGIN_DATA + private workspace ────────────────
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recall-journal-')));
const WS      = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recall-journal-ws-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;

const PORT    = 18950 + Math.floor(Math.random() * 200);
const JOURNAL = path.join(WS, '.graph', 'recall-outcome-journal.jsonl');
const encodeWorkspace = (p) => String(p).replace(/[/.\\:]/g, '-');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const WEIGHT_SID = crypto.randomUUID();
const WEIGHT_TASK_KEY = `${WEIGHT_SID}/1`;

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};
const skipped = (label, why) => { console.log(`SKIP  ${label} (${why})`); skip++; };

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(p, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function readJournal(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Load the pure-reader module directly (no daemon needed for unit tests).
const recallJournal = require('../lib/recall-outcome-journal');
const retrievalWeights = require('../lib/search/retrieval-weights');
const filedrop = require('../lib/filedrop-tasks');

function dropStub(harness, id) {
  const dir = path.join(filedrop.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, subject: `${harness} task ${id}`, status: 'pending' }, null, 2));
}

(async () => {
  // ── Unit test: reader functions (no daemon required) ─────────────────────
  {
    const tmpWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recall-unit-')));
    const graphDir = path.join(tmpWs, '.graph');
    fs.mkdirSync(graphDir, { recursive: true });

    // appendRow writes parseable JSONL.
    recallJournal.appendRow(tmpWs, {
      task_key: 'task-A',
      recalled_note_keys: ['note:foo', 'note:bar'],
      recalled_context_edges: [{
        from: 'task-A',
        to: 'note:foo',
        relation: 'context',
        result_key: 'note:foo',
        result_kind: 'note',
        tier: 'dag',
        via: 'context',
        injected: true,
        structural: true,
        direct: true,
        weight: 0.9,
      }],
      outcome: 'pending',
      via: 'rag',
    });
    recallJournal.appendRow(tmpWs, { task_key: 'task-B', recalled_note_keys: ['note:baz'], outcome: 'pending', via: 'dag' });
    recallJournal.appendRow(tmpWs, { task_key: 'task-A', recalled_note_keys: ['note:foo', 'note:bar'], outcome: 'approve', via: 'rag' });

    const rows = recallJournal.readRows(tmpWs);
    ok('unit: readRows returns 3 rows', rows.length === 3);
    ok('unit: first row outcome is pending', rows[0].outcome === 'pending');
    ok('unit: first row task_key is task-A', rows[0].task_key === 'task-A');
    ok('unit: first row recalled_note_keys is array', Array.isArray(rows[0].recalled_note_keys));
    ok('unit: first row preserves recalled_context_edges', rows[0].recalled_context_edges && rows[0].recalled_context_edges[0].to === 'note:foo');
    ok('unit: first row preserves injected flag', rows[0].recalled_context_edges && rows[0].recalled_context_edges[0].injected === true);
    ok('unit: first row preserves structural flag', rows[0].recalled_context_edges && rows[0].recalled_context_edges[0].structural === true);
    ok('unit: first row ts is ISO string', typeof rows[0].ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(rows[0].ts));
    ok('unit: first row via is rag', rows[0].via === 'rag');
    ok('unit: second row via is dag', rows[1].via === 'dag');
    ok('unit: third row outcome is approve', rows[2].outcome === 'approve');

    // latestByTask: last-write-wins per task_key.
    const latest = recallJournal.latestByTask(tmpWs);
    ok('unit: latestByTask has 2 entries', latest.size === 2);
    ok('unit: latestByTask task-A is approve', latest.get('task-A').outcome === 'approve');
    ok('unit: latestByTask task-B is pending', latest.get('task-B').outcome === 'pending');

    recallJournal.appendRow(tmpWs, { task_key: 'task-C', recalled_note_keys: ['legacy'], outcome: 'approve', via: 'rag' });
    const stats = recallJournal.computeNoteStats(tmpWs);
    ok('unit: computeNoteStats accepts recalled_note_keys-only rows', stats.get('note:legacy').wins === 1);

    // Missing workspace → empty rows.
    ok('unit: readRows with missing ws returns []', recallJournal.readRows('/nonexistent-ws-xyz').length === 0);

    // appendRow with no task_key is a no-op.
    const countBefore = recallJournal.readRows(tmpWs).length;
    recallJournal.appendRow(tmpWs, { recalled_note_keys: [], outcome: 'pending', via: 'rag' });
    ok('unit: appendRow with no task_key is no-op', recallJournal.readRows(tmpWs).length === countBefore);

    try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // ── Integration tests: daemon ─────────────────────────────────────────────
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJECTS_DIR, `${WEIGHT_SID}.jsonl`), '');
  fs.mkdirSync(path.join(os.homedir(), '.claude', 'tasks', WEIGHT_SID), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.claude', 'tasks', WEIGHT_SID, '1.json'), JSON.stringify({ id: '1', subject: 'weight feedback task', status: 'pending' }));

  const daemon = spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });

  let exitCode = 0;
  try {
    if (!(await waitForPing(12000))) {
      console.log('FAIL  daemon did not come up within 12s');
      process.exit(1);
    }

    // Point daemon at temp workspace.
    await post('/workspace', { path: WS });

    // Create a stub task so the task_key is known to the overlay (not required for /search,
    // but lets us later call set_status against it).
    const TASK_KEY = 'recall/journal-1';
    dropStub('recall', 'journal-1');
    await post('/sync', { workspace: WS });

    // ── 1. /search?task_key= writes a pending recall row ─────────────────────
    const beforeSearch = readJournal(JOURNAL).length;
    const searchPath = `/search?q=${encodeURIComponent('journal attribution test note')}&task_key=${encodeURIComponent(TASK_KEY)}&workspace=${encodeURIComponent(WS)}`;
    const sr = await get(searchPath);
    ok('search with task_key: HTTP 200', sr.status === 200);

    const afterSearch = readJournal(JOURNAL);
    ok('search: recall journal created', fs.existsSync(JOURNAL));
    ok('search: at least one new row appended', afterSearch.length > beforeSearch);

    // Find the pending row for our task.
    const pendingRow = afterSearch.filter((r) => r.task_key === TASK_KEY && r.outcome === 'pending').pop();
    ok('search: pending row exists for task_key', pendingRow !== null && pendingRow !== undefined);
    ok('search: pending row ts is ISO string', pendingRow && typeof pendingRow.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(pendingRow.ts));
    ok('search: pending row workspace matches', pendingRow && pendingRow.workspace === WS);
    ok('search: pending row recalled_note_keys is array', pendingRow && Array.isArray(pendingRow.recalled_note_keys));
    ok('search: pending row via is rag or dag', pendingRow && (pendingRow.via === 'rag' || pendingRow.via === 'dag'));

    // ── 2. /search without task_key does NOT write a row ────────────────────
    const countNoKey = readJournal(JOURNAL).length;
    const noKeyPath = `/search?q=${encodeURIComponent('no task key query')}&workspace=${encodeURIComponent(WS)}`;
    await get(noKeyPath);
    ok('search without task_key: no new row', readJournal(JOURNAL).length === countNoKey);

    // ── 3. Terminal status write appends a resolved outcome row ──────────────
    // Use 'ready' → 'failed' transition (no worktree required for failed).
    await post('/overlay/status', { key: TASK_KEY, status: 'ready', workspace: WS });
    const countBeforeTerminal = readJournal(JOURNAL).length;
    const termResp = await post('/overlay/status', { key: TASK_KEY, status: 'failed', workspace: WS });
    ok('terminal status: HTTP 200', termResp.status === 200);

    const afterTerminal = readJournal(JOURNAL);
    ok('terminal status: new row appended', afterTerminal.length > countBeforeTerminal);

    const resolvedRow = afterTerminal.filter((r) => r.task_key === TASK_KEY && r.outcome !== 'pending').pop();
    ok('terminal status: resolved row exists', resolvedRow !== null && resolvedRow !== undefined);
    ok('terminal status: resolved row outcome is failed', resolvedRow && resolvedRow.outcome === 'failed');
    ok('terminal status: resolved row ts is ISO string', resolvedRow && typeof resolvedRow.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(resolvedRow.ts));
    ok('terminal status: resolved row workspace matches', resolvedRow && resolvedRow.workspace === WS);
    ok('terminal status: resolved row recalled_note_keys is array', resolvedRow && Array.isArray(resolvedRow.recalled_note_keys));

    // ── 4. 'done' maps to 'approve' outcome ──────────────────────────────────
    const TASK_KEY2 = 'recall/journal-2';
    dropStub('recall', 'journal-2');
    await post('/sync', { workspace: WS });
    await post('/overlay/status', { key: TASK_KEY2, status: 'ready', workspace: WS });
    await post('/overlay/status', { key: TASK_KEY2, status: 'done', workspace: WS, summary: 'all good' });

    const afterDone = readJournal(JOURNAL);
    const approveRow = afterDone.filter((r) => r.task_key === TASK_KEY2 && r.outcome !== 'pending').pop();
    ok('done status: resolved outcome is approve', approveRow && approveRow.outcome === 'approve');
    ok('terminal status without edge metadata: no retrieval-weight feedback', retrievalWeights.readRows(WS).length === 0);

    // ── 5. Terminal recall feedback updates learned retrievalWeight, not structural edge.weight ──
    const TASK_KEY4 = WEIGHT_TASK_KEY;
    await post('/overlay/status', { key: TASK_KEY4, status: 'not_ready', workspace: WS });
    const noteResp = await post('/overlay/note', { title: 'weight feedback note', summary: 'direct context for retrieval feedback', workspace: WS });
    const NOTE_KEY = noteResp.body.key;
    await post('/overlay/edge', { from: NOTE_KEY, to: TASK_KEY4, kind: 'context', weight: 0.7, workspace: WS });

    const ctxBefore = await get(`/task/context?key=${encodeURIComponent(TASK_KEY4)}&workspace=${encodeURIComponent(WS)}`);
    const beforeDep = (ctxBefore.body.dependencySummaries || []).find((entry) => entry.key === NOTE_KEY);
    ok('retrieval feedback: structural edge starts at weight 0.7', beforeDep && beforeDep.weight === 0.7);

    const weightRowsBefore = retrievalWeights.readRows(WS).length;
    const weightSearchPath = `/search?q=${encodeURIComponent('weight feedback')}&task_key=${encodeURIComponent(TASK_KEY4)}&workspace=${encodeURIComponent(WS)}&gated=1`;
    const weightSearch = await get(weightSearchPath);
    ok('retrieval feedback: search HTTP 200', weightSearch.status === 200);
    const weightPending = readJournal(JOURNAL).filter((r) => r.task_key === TASK_KEY4 && r.outcome === 'pending').pop();
    ok('retrieval feedback: pending row carries edge metadata', weightPending && Array.isArray(weightPending.recalled_context_edges) && weightPending.recalled_context_edges.some((edge) => edge.to === NOTE_KEY));

    await post('/overlay/status', { key: TASK_KEY4, status: 'ready', workspace: WS });
    const failedFeedback = await post('/overlay/status', { key: TASK_KEY4, status: 'failed', workspace: WS });
    ok('retrieval feedback: terminal failed HTTP 200', failedFeedback.status === 200);
    ok('retrieval feedback: retrieval-weights row appended', retrievalWeights.readRows(WS).length === weightRowsBefore + 1);
    ok('retrieval feedback: learned retrievalWeight downweighted', Math.round(retrievalWeights.getRetrievalWeight(WS, TASK_KEY4, NOTE_KEY, 'context') * 100) === 92);

    const ctxAfter = await get(`/task/context?key=${encodeURIComponent(TASK_KEY4)}&workspace=${encodeURIComponent(WS)}`);
    const afterDep = (ctxAfter.body.dependencySummaries || []).find((entry) => entry.key === NOTE_KEY);
    ok('retrieval feedback: structural edge.weight remains unchanged', afterDep && afterDep.weight === 0.7);

    // ── 6. Fail-open: journal write failure does not break search response ───
    {
      const graphDir = path.join(WS, '.graph');
      let chmodApplied = false;
      try { fs.chmodSync(graphDir, 0o555); chmodApplied = true; } catch { /* skip */ }
      if (!chmodApplied) {
        skipped('fail-open search: chmod not available', 'platform limitation');
      } else {
        let restored = false;
        try {
          const TASK_KEY3 = 'recall-test-task-3';
          const failSearchPath = `/search?q=failopen&task_key=${encodeURIComponent(TASK_KEY3)}&workspace=${encodeURIComponent(WS)}`;
          const failResp = await get(failSearchPath);
          try { fs.chmodSync(graphDir, 0o755); restored = true; } catch { /* best effort */ }
          ok('fail-open search: HTTP 200 even when journal write fails', failResp.status === 200);
          ok('fail-open search: results field present in response', Array.isArray(failResp.body.results));
        } finally {
          if (!restored) { try { fs.chmodSync(graphDir, 0o755); } catch { /* best effort */ } }
        }
      }
    }

  } finally {
    daemon.kill('SIGKILL');
    try { fs.rmSync(PROJECTS_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(path.join(os.homedir(), '.claude', 'tasks', WEIGHT_SID), { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(WS,      { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  if (fail > 0) exitCode = 1;
  process.exit(exitCode);
})().catch((e) => { console.error('ERROR:', e && (e.stack || e.message)); process.exit(1); });
