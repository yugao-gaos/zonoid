#!/usr/bin/env node
// Seam-gating test for request_guidance (routes/session.js POST /guidance). Proves the ask-vs-predict
// gate (lib/ask-gate.js via lib/ask-gate-recall.js) is ENFORCED in front of every escalation, making
// request_guidance a genuine last resort. No port binding, no live model — drives the real session
// route handler with a fake ctx (synthetic embed + buildGraph + in-memory overlay).
//
// Covers:
//   (a) a confident project-local preference note → /guidance AUTO-RESOLVES (predicted:true) without
//       touching the pending guidance queue and without pausing the loop.
//   (b) no match → escalates normally (pending guidance item added, loop paused).
//   (c) hard-override (irreversible/outward/...) → ALWAYS escalates even with a perfect match.
//
// Run: node test/guidance-seam-gate.test.js — exits non-zero on any failed assertion.
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const overlayStore = require('../lib/overlay');
const sessionRoute = require('../routes/session');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Sandbox workspace so runAskGate's journal append (.graph/ask-journal.jsonl) has somewhere to land.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-seam-'));
fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });

// Synthetic preference note. note.vec[0] is the literal cosine the fake embed/cosine produce — so we
// dial confidence per-test. Empirical signature + project-local cues + shares the question vocabulary.
const PREF_NOTE = {
  id: 'note-pref1', kind: 'note', label: 'merge style preference',
  summary: 'chose squash-merge over merge-commit for orch attempt branches because the linear history halved the bisect time (measured 12/12 attempts on real data with mergeAttempt); always squash the attempt branch on merge',
  category: 'preference', tags: [],
};

// A 2D unit vector whose cosine against QVEC=[1,0] is exactly `c` (so the test dials confidence):
//   QVEC·[c, sqrt(1-c^2)] = c, both unit-length ⇒ cosine = c.
const QVEC = [1, 0];
const unitFor = (c) => [c, Math.sqrt(Math.max(0, 1 - c * c))];

// Fake ctx: deterministic embed/buildGraph, in-memory overlay, captured send + loop state.
function makeCtx(noteVec) {
  const ov = overlayStore.EMPTY();
  const loops = new Map([['L1', { active: true }]]);
  let saved = false, notified = false;
  let lastSend = null;
  // node carries a 2D unit vec so the REAL cosine(QVEC, vec) === noteVec; embed returns QVEC.
  const note = { ...PREF_NOTE, vec: unitFor(noteVec) };
  const ctx = {
    state: { workspace: WS, overlay: ov },
    loops,
    saveLoops: () => { saved = true; },
    notifyChange: () => { notified = true; },
    send: (res, code, body) => { lastSend = { code, body }; },
    readBody: async (req) => req._body,
    buildGraph: () => ({ tasks: [note] }),
    targetOverlay: () => ({ ws: WS, ov, save: () => { saved = true; } }),
    embed: async () => QVEC,         // non-null ⇒ semantic; cosine(QVEC, note.vec) === noteVec
    EMBED_MODEL: 'fake-minilm',
    // unused-by-/guidance ctx fields the destructure pulls — provide harmless stubs:
    stopSignalFor: () => null, agentsArr: () => [],
    ESCALATION_DEFAULTS: () => ({}), OPTIMIZE_DEFAULTS: () => ({}),
  };
  return { ctx, ov, loops, getLast: () => lastSend, wasNotified: () => notified };
}

const handler = (ctx) => sessionRoute(ctx);
function req(body) { return { _body: body, method: 'POST' }; }
const res = {};
const u = new URL(`http://localhost/guidance`);

const QUESTION = 'should I squash-merge or merge-commit this orch attempt branch when merging it back';

(async () => {
  // ---- (a) confident preference match → AUTO-RESOLVE, no queue, no pause ------------------------
  {
    const { ctx, ov, loops, getLast, wasNotified } = makeCtx(0.85); // high cosine ⇒ predict
    const route = handler(ctx);
    await route('/guidance', 'POST', req({ question: QUESTION }), res, u);
    const r = getLast();
    ok('a.1: gate predicted (response predicted:true)', r && r.code === 200 && r.body.predicted === true);
    ok('a.2: predicted answer carries provenance note', r.body.appliedNote && r.body.appliedNote.key === 'note-pref1');
    const pending = overlayStore.pendingGuidance(ov);
    ok('a.3: NOTHING in the pending guidance queue', pending.length === 0);
    const item = ov.guidance.find((g) => g.id === r.body.id);
    ok('a.4: guidance item recorded as resolved + predicted', item && item.resolved === true && item.predicted === true);
    ok('a.5: loop NOT paused (still active)', loops.get('L1').active === true);
    ok('a.6: change notified', wasNotified());
  }

  // ---- (b) no confident match → ESCALATE normally ----------------------------------------------
  {
    const { ctx, ov, loops, getLast } = makeCtx(0.20); // low cosine ⇒ ask
    const route = handler(ctx);
    await route('/guidance', 'POST', req({ question: QUESTION }), res, u);
    const r = getLast();
    ok('b.1: gate did NOT predict (no predicted flag)', r && r.code === 200 && !r.body.predicted);
    const pending = overlayStore.pendingGuidance(ov);
    ok('b.2: one pending guidance item queued', pending.length === 1 && pending[0].question === QUESTION);
    ok('b.3: blocking loop paused', loops.get('L1').active === false);
  }

  // ---- (c) hard-override → ALWAYS escalate even with a perfect match ----------------------------
  {
    const { ctx, ov, loops, getLast } = makeCtx(0.99); // perfect cosine, but override forces ask
    const route = handler(ctx);
    // flag form: irreversible:true asserts the override regardless of the question text.
    await route('/guidance', 'POST', req({ question: QUESTION, irreversible: true }), res, u);
    const r = getLast();
    ok('c.1: hard-override did NOT predict', r && !r.body.predicted);
    ok('c.2: hard-override escalated to the pending queue', overlayStore.pendingGuidance(ov).length === 1);
    ok('c.3: hard-override paused the loop', loops.get('L1').active === false);
  }

  // ---- (c2) hard-override via keyword on the question text (no flag) ----------------------------
  {
    const { ctx, ov, getLast } = makeCtx(0.99);
    const route = handler(ctx);
    await route('/guidance', 'POST', req({ question: 'should I force-push and delete the remote branch to fix this' }), res, u);
    const r = getLast();
    ok('c2.1: keyword override (force-push/delete) did NOT predict', r && !r.body.predicted);
    ok('c2.2: keyword override escalated', overlayStore.pendingGuidance(ov).length === 1);
  }

  // ---- journal: every verdict appended (predict + ask) -----------------------------------------
  {
    const jp = path.join(WS, '.graph', 'ask-journal.jsonl');
    const lines = fs.existsSync(jp) ? fs.readFileSync(jp, 'utf8').trim().split('\n').filter(Boolean) : [];
    ok('j.1: ask-journal has a row per gate verdict (>=4)', lines.length >= 4);
    const row = JSON.parse(lines[0]);
    ok('j.2: journal row tagged with the guidance seam', row.seam === 'guidance' && typeof row.decision === 'string');
  }

  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
