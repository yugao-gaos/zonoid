#!/usr/bin/env node
// Regression test for task #31: a KEEP verdict on a LEGACY already-judged context edge that is
// currently flagged for rejudge must CLEAR the flag (+ journal + count), even though judge.keepEdge()
// returns falsy for it (keepEdge only promotes weight-0 / judged===false autowire edges).
//
// Before the fix, the keep block was gated SOLELY on `judge.keepEdge(...)` returning truthy, so a
// legacy edge (judged===true, weight>0) marked needs_rejudge would have the whole if-block skipped —
// clearEdgeRejudge never fired, the flag stayed set, and /judge/next re-served it forever (silent
// no-op). The prune path worked only because its clear lives in the prune block.
//
// Drives the REAL route handler (routes/judge.js makeRoute) with a minimal mock ctx — no port bind —
// so it tests the actual production code path, not a re-mirror that could drift.
// Run: timeout 90 node test/judge-keep-legacy-rejudge.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const makeRoute = require('../routes/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log('PASS  ' + label); pass++; } else { console.log('FAIL  ' + label); fail++; } };

// Workspace dir so appendVerdict (journal) + T.save() have somewhere to write.
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'judge31-'));
fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });

// Build an overlay with a LEGACY KEPT context edge (judged===true, real weight).
const overlay = ov.EMPTY();
const FROM = 'note:legacy', TO = 's/anchor';
overlay.edges = [{ from: FROM, to: TO, kind: 'context', judged: true, weight: 0.7, by: 'judge' }];

// Minimal ctx mock mirroring the daemon's wiring of the route.
let lastSend = null;
const ctx = {
  state: { overlay },
  targetOverlay: () => ({ ov: overlay, ws, save: () => {} }),
  buildGraph: () => ({ tasks: [{ id: FROM }, { id: TO }] }),
  readBody: async (b) => b,                         // body is passed directly as req in this driver
  send: (res, code, payload) => { lastSend = { code, payload }; },
  notifyChange: () => {},
  noteRagCandidates: () => [],
};
const route = makeRoute(ctx);
const journalPath = path.join(ws, '.graph', 'judge-journal.jsonl');
const readJournal = () => (fs.existsSync(journalPath)
  ? fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

(async () => {
  // 1. Flag the legacy edge for rejudge (overlay primitive, same as POST /judge/rejudge-edges).
  ov.markForRejudge(overlay, FROM);  // marks every context edge FROM this node
  const sig = FROM + '>>' + TO;
  ok('precondition: rejudge flag set', overlay.edgeRejudge[sig] === true);

  // 2. /judge/next surfaces it with needs_rejudge:true.
  const q0 = judge.buildQueue(overlay);
  const surfaced0 = q0.filter((it) => it.kind === 'edge' && it.id === sig);
  ok('precondition: /judge/next surfaces the rejudge edge', surfaced0.length === 1 && surfaced0[0].needs_rejudge === true);

  // 3. POST a KEEP verdict on the legacy edge.
  await route('/judge/verdict', 'POST', { keepEdge: { from: FROM, to: TO } }, {}, null, null);
  ok('verdict handler responded 200', lastSend && lastSend.code === 200);
  ok('applied.kept incremented', lastSend && lastSend.payload.applied.kept === 1);

  // 4a. Flag cleared — edge no longer surfaced by /judge/next.
  ok('rejudge flag cleared after keep', !(overlay.edgeRejudge && overlay.edgeRejudge[sig]));
  const q1 = judge.buildQueue(overlay);
  const surfaced1 = q1.filter((it) => it.kind === 'edge' && it.id === sig);
  ok('edge no longer surfaced by /judge/next', surfaced1.length === 0);

  // 4b. Edge still exists, judged===true, weight UNCHANGED (no double-promotion).
  const e = overlay.edges.find((x) => x.from === FROM && x.to === TO && x.kind === 'context');
  ok('edge still exists', !!e);
  ok('edge still judged===true', e && e.judged === true);
  ok('edge weight unchanged (no double-promote)', e && e.weight === 0.7);

  // 4c. Keep verdict was journaled.
  const journal = readJournal();
  const keepRows = journal.filter((r) => r.verdict === 'keep' && r.from === FROM && r.to === TO);
  ok('keep verdict journaled', keepRows.length === 1);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' (' + pass + '/' + (pass + fail) + ')');
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
