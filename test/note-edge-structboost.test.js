#!/usr/bin/env node
// Plain Node test (no framework; matches test/autowire-weight0-promotion.test.js style). Run:
//   node test/note-edge-structboost.test.js — exits non-zero on any failed assertion.
//
// Contract under test (task 9195...-26 / CL-2d): a judge-KEPT note->note context edge must DRIVE
// structBoost retrieval. Two daemon bugs broke this:
//   (1) buildGraph hardcoded a note's context_deps:[], and the /search structBoost reranker reads
//       context_deps for its adjacency — so a kept note->note edge never boosted its neighbor.
//   (2) overlayStore.save (emitDiff) emitted edge_added only for NEW edges; keepEdge's IN-PLACE
//       promotion (weight 0->score, judged false->true) changed no edge_added sig, so it was never
//       persisted. On a non-live reload the original weight-0/unjudged edge_added won and the kept
//       edge stayed retrieval-invisible.
//
// Layer A (in-process, deterministic): buildGraph note context_deps population (judged-kept ONLY) +
//   save/replay persistence of an in-place keepEdge promotion across a fresh load().
// Layer B (live throwaway daemon on a PRIVATE port, NEVER 8787): end-to-end /search proof that a
//   kept note->note edge boosts its neighbor's rank (structBoost present) and a weight-0 candidate
//   edge does NOT.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const graphStore = require('../lib/graph-store');
const daemon = require('../daemon');
const { buildGraph } = daemon;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// ───────────────────────── Layer A: in-process units ─────────────────────────

// A1. buildGraph populates a note's context_deps from JUDGED-KEPT context edges only.
{
  const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nesb-a1-')));
  try {
    graphStore.open(path.join(WS, '.graph'));
    const overlay = ov.EMPTY();
    overlay.note_nodes['nA'] = { id: 'nA', title: 'note A', summary: 'alpha', vec: null, created_at: new Date().toISOString() };
    overlay.note_nodes['nB'] = { id: 'nB', title: 'note B', summary: 'beta',  vec: null, created_at: new Date().toISOString() };
    overlay.note_nodes['nC'] = { id: 'nC', title: 'note C', summary: 'gamma', vec: null, created_at: new Date().toISOString() };
    // KEPT edge: note:nA -> note:nB (provider nA feeds receiver nB), promoted weight > 0.
    ov.addEdge(overlay, 'note:nA', 'note:nB', null, 'context', 0.42, { by: 'judge', judged: true });
    // CANDIDATE edge: note:nA -> note:nC, unjudged autowire, weight 0 (retrieval-invisible).
    ov.addEdge(overlay, 'note:nA', 'note:nC', null, 'context', 0, { by: 'autowire', judged: false, score: 0.3 });
    ov.save(WS, overlay, { deferred: true });

    // buildGraph reads the daemon's own workspace via state; for a non-current ws it loads fresh.
    // Pin this ws as the daemon's workspace so buildGraph reads our in-memory overlay directly.
    daemon.__setWorkspaceForTest(WS);
    daemon.__setOverlayForTest(overlay);
    const g = buildGraph(WS);
    const nB = g.tasks.find((t) => t.id === 'note:nB');
    const nC = g.tasks.find((t) => t.id === 'note:nC');
    ok('A1 receiver note (kept edge) gets the provider in context_deps', !!nB && nB.context_deps.includes('note:nA'));
    ok('A1 candidate-edge receiver note context_deps stays empty (weight-0 excluded)', !!nC && nC.context_deps.length === 0);
    // The provider note itself has no INCOMING kept edge -> empty (direction matches task depRefs).
    const nA = g.tasks.find((t) => t.id === 'note:nA');
    ok('A1 provider note has no inbound kept edge -> empty context_deps', !!nA && nA.context_deps.length === 0);
  } finally { fs.rmSync(WS, { recursive: true, force: true }); }
}

// A2. keepEdge's in-place promotion survives a fresh (non-live) reload via the edge_promoted event.
{
  const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nesb-a2-')));
  try {
    graphStore.open(path.join(WS, '.graph'));
    fs.writeFileSync(path.join(WS, '.graph', '.gitkeep'), '');
    const overlay = ov.EMPTY();
    overlay.note_nodes['pA'] = { id: 'pA', title: 'provider', summary: 'x', vec: null, created_at: new Date().toISOString() };
    overlay.note_nodes['pB'] = { id: 'pB', title: 'receiver', summary: 'y', vec: null, created_at: new Date().toISOString() };
    // Seed a weight-0, judged:false candidate, then persist (writes edge_added at weight 0).
    ov.addEdge(overlay, 'note:pA', 'note:pB', null, 'context', 0, { by: 'autowire', judged: false, score: 0.55 });
    ov.save(WS, overlay);

    // Sanity: a fresh load BEFORE keep shows the candidate at weight 0 (retrieval-invisible).
    const before = ov.load(WS);
    const eBefore = before.edges.find((e) => e.from === 'note:pA' && e.to === 'note:pB');
    ok('A2 pre-keep reload: candidate edge weight 0', !!eBefore && ov.edgeWeight(eBefore) === 0 && eBefore.judged === false);

    // JUDGE keeps it IN PLACE on the live overlay, then persist again.
    const promoted = judge.keepEdge(overlay, 'note:pA', 'note:pB');
    ok('A2 keepEdge promoted the in-memory edge', promoted === true && ov.edgeWeight(overlay.edges[0]) > 0);
    ov.save(WS, overlay);

    // Fresh, non-live reload: replay edge_added (w0) + edge_promoted -> promotion must win.
    const after = ov.load(WS);
    const eAfter = after.edges.find((e) => e.from === 'note:pA' && e.to === 'note:pB');
    ok('A2 post-keep reload: promotion persisted (weight > 0)', !!eAfter && ov.edgeWeight(eAfter) > 0);
    ok('A2 post-keep reload: judged:true persisted', !!eAfter && eAfter.judged === true);
    ok('A2 post-keep reload: weight seeded from recall score (0.55)', !!eAfter && Math.abs(ov.edgeWeight(eAfter) - 0.55) < 1e-9);
    ok('A2 post-keep reload: exactly one edge (no duplicate from re-emit)', after.edges.filter((e) => e.from === 'note:pA' && e.to === 'note:pB').length === 1);
  } finally { fs.rmSync(WS, { recursive: true, force: true }); }
}

// ───────────────────────── Layer B: live throwaway daemon (/search) ─────────────────────────
// PRIVATE port well away from the live daemon (8787). Asserted before boot.
const PORT = 18650 + Math.floor(Math.random() * 80);
if (PORT === 8787) { console.error('refusing to use the live port'); process.exit(1); }
const BASE = `http://127.0.0.1:${PORT}`;
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nesb-base-')));
const WSB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nesb-ws-')));

// P3: ops require an explicit workspace (no daemon-global default). Single-workspace layer ⇒
// default WSB into POST bodies and GET query strings (skip /workspace, /ping, or explicit ws).
async function post(p, body) {
  const payload = (p === '/workspace' || (body && body.workspace)) ? body : { ...(body || {}), workspace: WSB };
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}
function withWs(p) {
  if (p.startsWith('/ping') || p.includes('workspace=')) return p;
  return p + (p.includes('?') ? '&' : '?') + 'workspace=' + encodeURIComponent(WSB);
}
async function get(p) { const res = await fetch(`${BASE}${withWs(p)}`); return { status: res.status, body: await res.json() }; }
async function waitForPing(ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.body && r.body.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const rankOf = (results, key) => { const i = results.findIndex((r) => r.key === key); return i; };
const findRes = (results, key) => results.find((r) => r.key === key);

(async () => {
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_HTTPS_PORT: String(PORT + 1), ORCH_TOKEN: '' },
      stdio: 'ignore',
    });
    ok('B daemon came up on a private port (not 8787)', await waitForPing() && PORT !== 8787);
    ok('B workspace pinned', (await post('/workspace', { path: WSB })).body.ok === true);

    // Three notes sharing the query token so all score on the SAME footing under /search
    // (lexical fallback if embeddings are unavailable; semantic if the models are present).
    // QUERY = "telemetry". provider + boosted both mention it; control mentions it too so the
    // ONLY differentiator on the boosted note is the kept edge from provider.
    const mk = async (title, summary) => (await post('/overlay/note', { title, summary })).body.key;
    const provider = await mk('telemetry provider note', 'telemetry sampling provider context');
    const boosted  = await mk('telemetry boosted note',  'telemetry receiver downstream consumer');
    const control  = await mk('telemetry control note',   'telemetry receiver standalone unlinked');
    ok('B three notes created', !!provider && !!boosted && !!control);

    // BASELINE /search — no kept edge yet. Record the boosted note's rank/score.
    let s = await get(`/search?q=${encodeURIComponent('telemetry')}&k=10`);
    const base = s.body.results || [];
    const baseBoosted = findRes(base, boosted);
    const baseRankBoosted = rankOf(base, boosted);
    ok('B baseline: boosted note retrieved', !!baseBoosted);
    ok('B baseline: boosted note carries NO structBoost', !baseBoosted || !(baseBoosted.structBoost > 0));

    // KEEP a note->note edge provider -> boosted (judged-kept context edge, weight from createEdge).
    const kept = await post('/judge/verdict', { createEdge: { from: provider, to: boosted, weight: 0.9 } });
    ok('B createEdge applied (judged-kept note->note edge)', kept.body.ok === true && kept.body.applied.created === 1);

    // Seed a weight-0 CANDIDATE edge provider -> control (retrieval-invisible; must NOT boost).
    await post('/overlay/edge', { from: provider, to: control, kind: 'context', weight: 0 });

    // POST-KEEP /search — boosted note should now carry structBoost; control should not.
    s = await get(`/search?q=${encodeURIComponent('telemetry')}&k=10`);
    const after = s.body.results || [];
    const afterBoosted = findRes(after, boosted);
    const afterControl = findRes(after, control);
    const afterRankBoosted = rankOf(after, boosted);

    ok('B post-keep: boosted note carries structBoost > 0', !!afterBoosted && afterBoosted.structBoost > 0);
    ok('B post-keep: control note (weight-0 candidate) carries NO structBoost', !!afterControl && !(afterControl.structBoost > 0));
    ok('B post-keep: boosted note score increased vs baseline',
       !!afterBoosted && !!baseBoosted && afterBoosted.score >= baseBoosted.score);
    ok('B post-keep: boosted note rank did not regress (<= baseline rank index)',
       afterRankBoosted >= 0 && afterRankBoosted <= baseRankBoosted);

    console.log(`    [B scores] boosted baseline=${baseBoosted && baseBoosted.score} -> after=${afterBoosted && afterBoosted.score} (structBoost=${afterBoosted && afterBoosted.structBoost}); control structBoost=${afterControl && afterControl.structBoost}`);
    console.log(`    [B ranks ] boosted baseline#${baseRankBoosted} -> after#${afterRankBoosted}`);
  } catch (e) {
    ok(`B layer threw: ${e && e.message}`, false);
  } finally {
    try { child && child.kill(); } catch { /* gone */ }
    for (const d of [SANDBOX, WSB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
