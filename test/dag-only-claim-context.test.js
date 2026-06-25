#!/usr/bin/env node
// Test for DAG-ONLY auto-injected claim context (Judge E), GET /search?task_key=...
// (routes/graph.js). Two layers, matching test/judging-gate.test.js's split:
//
//   HTTP LAYER (end-to-end, deterministic): spawns the real daemon on a private port with a
//     sandboxed CLAUDE_PLUGIN_DATA (style of test/context-gate-route.test.js). Uses the LEXICAL
//     scoring path (no query/note vectors) so it never needs MiniLM weights and never SKIPs. Covers
//     the two behaviours that survive a graph-store reload — a FULLY-JUDGED task's claim context is
//     DAG-only, and an explicit (no-task_key) lookup is unchanged.
//   PURE LAYER (substrate): the route's DAG-only decision is exactly `dagOnly = !node.provisional`
//     and `results = dagOnly ? dagNotes : [...dagNotes, ...ragFill]`. We assert that predicate
//     directly. WHY NOT HTTP for the provisional case: a provisional node requires an UNJUDGED
//     (judged:false) edge, and graph-store's edge serialization (lib/graph-store.js addEdge) keeps
//     only from/to/kind/weight — `judged` does NOT survive the daemon's disk reload in a spawned
//     sandbox. test/judging-gate.test.js hit the same wall and made the same pure-substrate choice.
//
// Run: node test/dag-only-claim-context.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// ====================================================================================
// PURE LAYER — the exact decision the /search route makes for the claim consult.
// Mirrors routes/graph.js: dagOnly is true iff a task_key resolved to a NON-provisional
// node; the returned bundle is DAG-only when dagOnly, else DAG + RAG-fill.
// ====================================================================================
function assembleResults(taskNode, dagNotes, ragResults, k) {
  // dagOnly: fully-judged claim consult ⇒ DAG-only; no task / provisional ⇒ keep RAG-fill.
  const dagOnly = !!taskNode && !taskNode.provisional;
  return dagOnly ? [...dagNotes] : [...dagNotes, ...ragResults].slice(0, k + dagNotes.length);
}
{
  const dagNotes = [{ key: 'note:dag', tier: 'dag' }];
  const ragResults = [{ key: 'note:rag', tier: 'rag' }];
  // (a) fully-judged task ⇒ DAG-only (RAG-fill dropped).
  const judged = assembleResults({ id: 't', provisional: false }, dagNotes, ragResults, 5);
  ok('pure: fully-judged ⇒ DAG-only (no rag tier)', judged.length === 1 && !judged.some((r) => r.tier === 'rag'));
  // (b) PROVISIONAL task (D's timeout fallback, DAG not guaranteed complete) ⇒ RAG-fill KEPT.
  const prov = assembleResults({ id: 't', provisional: true }, dagNotes, ragResults, 5);
  ok('pure: provisional ⇒ RAG-fill kept (fallback, not DAG-only-blind)', prov.some((r) => r.tier === 'rag'));
  // (c) no task_key (explicit lookup) ⇒ DAG + RAG as before (taskNode null).
  const explicit = assembleResults(null, [], ragResults, 5);
  ok('pure: no task_key ⇒ RAG returned (search_knowledge unchanged)', explicit.some((r) => r.tier === 'rag'));
  // (d) fully-judged task with NO judged neighbors ⇒ empty auto-context (correct: claim it deliberately).
  const empty = assembleResults({ id: 't', provisional: false }, [], ragResults, 5);
  ok('pure: fully-judged + no DAG neighbors ⇒ empty auto-context', empty.length === 0);
}

// ====================================================================================
// HTTP LAYER — fully-judged DAG-only + explicit-lookup over the live route.
// ====================================================================================
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dagonly-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlayStore = require('../lib/overlay');   // BASE read at require-time → sandbox
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dagonly-ws-')));

// filedrop stub task: <SANDBOX>/tasks/<workspace-key>/<harness>/<id>.json (lib/filedrop-tasks).
function workspaceKey(ws) {
  const h = crypto.createHash('sha1').update(String(ws)).digest('hex').slice(0, 16);
  const base = (path.basename(ws) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}-${h}`;
}
const stubDir = path.join(SANDBOX, 'tasks', workspaceKey(WS), 'local');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'judged.json'),
  JSON.stringify({ id: 'judged', subject: 'implement the locale decimal sum parser', status: 'in_progress' }));

// overlay: a JUDGED context edge (weight survives reload) to noteDag + an unwired RAG note.
// The 'judged' task carries NO unjudged edges ⇒ projection provisional:false ⇒ DAG-only path.
{
  const ov = overlayStore.load(WS);
  ov.note_nodes = {
    noteDag: { id: 'noteDag', title: 'judged DAG neighbor note', summary: 'the judged context dependency for the claim', created_at: new Date().toISOString() },
    noteRag: { id: 'noteRag', title: 'locale decimal sum parsing gotcha', summary: 'parse locale decimal sums carefully — grouping separators differ by locale', created_at: new Date().toISOString() },
  };
  ov.edges = [{ from: 'note:noteDag', to: 'local/judged', kind: 'context', weight: 0.5, judged: true, by: 'manual' }];
  overlayStore.save(WS, ov);
}

const PORT = 19180 + Math.floor(Math.random() * 200);
function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.end();
  });
}
async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.status === 200) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const wsq = encodeURIComponent(WS);
const q = encodeURIComponent('locale decimal sum parsing');
const keys = (results) => (results || []).map((r) => r.key);

(async () => {
  const daemon = spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    if (!(await waitForPing())) { console.log('FAIL  daemon did not come up'); process.exit(1); }

    // sanity: without a task_key, noteRag IS a lexical RAG match for the query.
    const base = await get(`/search?workspace=${wsq}&q=${q}&k=5`);
    ok('http sanity: HTTP 200', base.status === 200);
    ok('http sanity: noteRag is a RAG candidate', keys(base.body.results).includes('note:noteRag'));

    // 1. fully-judged task + task_key → DAG-ONLY (RAG-fill dropped).
    const judged = await get(`/search?workspace=${wsq}&q=${q}&k=5&task_key=${encodeURIComponent('local/judged')}`);
    ok('http judged: HTTP 200', judged.status === 200);
    ok('http judged: DAG note present (tier=dag)', (judged.body.results || []).some((r) => r.key === 'note:noteDag' && r.tier === 'dag'));
    ok('http judged: NO rag-tier entries (DAG-only)', !(judged.body.results || []).some((r) => r.tier === 'rag'));
    ok('http judged: noteRag (RAG candidate) NOT injected', !keys(judged.body.results).includes('note:noteRag'));
    ok('http judged: continue=false (no rag plateau signal)', judged.body.continue === false);

    // 2. explicit lookup (no task_key) → search_knowledge unchanged, RAG returned, no DAG tier.
    const explicit = await get(`/search?workspace=${wsq}&q=${q}&k=5`);
    ok('http explicit: RAG returned (search_knowledge unchanged)', (explicit.body.results || []).some((r) => r.key === 'note:noteRag' && r.tier === 'rag'));
    ok('http explicit: no DAG tier without a task_key', !(explicit.body.results || []).some((r) => r.tier === 'dag'));
  } finally {
    daemon.kill('SIGKILL');
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
