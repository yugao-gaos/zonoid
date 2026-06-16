#!/usr/bin/env node
// Seam test for the ANSWERED-DOWNSTREAM pass (EL-2/D, fix Mode-1 over-escalation). Proves that when
// the preference ask-gate says ASK, a CONFIDENT decision/correction note that already answers the
// question AUTO-RESOLVES the escalation (predicted:true) instead of pausing the loop — and that
// hard-override questions still escalate even with a perfect match. Drives the real session route
// (routes/session.js POST /guidance) with a fake ctx; no port binding, no live model.
//
// Covers:
//   (a) a confident project-local DECISION note (NOT category:preference) → AUTO-RESOLVES a
//       non-override question via the answered-downstream pass.
//   (b) a hard-override question (irreversible flag) with the SAME confident note → STILL escalates.
//   (c) a diffuse / low-confidence note → still ASKS (escalates normally).
//
// Run: node test/guidance-answered-downstream.test.js — exits non-zero on any failed assertion.
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const overlayStore = require('../lib/overlay');
const sessionRoute = require('../routes/session');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Sandbox workspace so the journal append (.graph/ask-journal.jsonl) has somewhere to land.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-answered-'));
fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });

// A CORRECTION note (category:'correction') that already answers the blocker. The preference pass
// (runAskGate) pools only preference+decision notes, so a correction note FALLS THROUGH to the
// answered-downstream pass — exactly the corpus this task widens to. Empirical signature +
// project-local cues, and shares the question vocabulary so the gap test passes.
const DECISION_NOTE = {
  id: 'note-dec1', kind: 'note', label: 'FB-3 retry backoff correction',
  summary: 'chose exponential backoff capped at 30s for the FB-3 ingest retryBackoff loop because the flat 5s retry hammered the upstream service and tripped its rate limit (measured 14/14 staging runs); always cap the FB-3 ingest retryBackoff at 30 seconds',
  category: 'correction', tags: [],
};

// The 2D-unit-vector trick from guidance-seam-gate.test.js: QVEC=[1,0]; a note vec [c, sqrt(1-c^2)]
// has cosine exactly c against QVEC, so the test dials confidence per-case.
const QVEC = [1, 0];
const unitFor = (c) => [c, Math.sqrt(Math.max(0, 1 - c * c))];

function makeCtx(noteVec) {
  const ov = overlayStore.EMPTY();
  const loops = new Map([['L1', { active: true }]]);
  let notified = false;
  let lastSend = null;
  const note = { ...DECISION_NOTE, vec: unitFor(noteVec) };
  const ctx = {
    state: { workspace: WS, overlay: ov },
    loops,
    saveLoops: () => {},
    notifyChange: () => { notified = true; },
    send: (res, code, body) => { lastSend = { code, body }; },
    readBody: async (req) => req._body,
    buildGraph: () => ({ tasks: [note] }),
    targetOverlay: () => ({ ws: WS, ov, save: () => {} }),
    embed: async () => QVEC,
    EMBED_MODEL: 'fake-minilm',
    stopSignalFor: () => null, agentsArr: () => [],
    ESCALATION_DEFAULTS: () => ({}), OPTIMIZE_DEFAULTS: () => ({}),
  };
  return { ctx, ov, loops, getLast: () => lastSend, wasNotified: () => notified };
}

const handler = (ctx) => sessionRoute(ctx);
function req(body) { return { _body: body, method: 'POST' }; }
const res = {};
const u = new URL('http://localhost/guidance');

// A blocker question that shares the decision note's vocabulary (ingest retryBackoff, rate limit) — NO
// matching PREFERENCE note exists, so the preference pass says ASK and the answered-downstream pass
// decides. Deliberately free of hard-override keywords (publish/deploy/delete/...) so it CAN predict.
const QUESTION = 'what backoff should the FB-3 ingest retryBackoff loop use to avoid tripping the upstream rate limit';

(async () => {
  // ---- (a) confident DECISION note → answered-downstream AUTO-RESOLVES a non-override question ----
  {
    const { ctx, ov, loops, getLast, wasNotified } = makeCtx(0.90); // high cosine ⇒ predict
    const route = handler(ctx);
    await route('/guidance', 'POST', req({ question: QUESTION }), res, u);
    const r = getLast();
    ok('a.1: answered-downstream predicted (predicted:true)', r && r.code === 200 && r.body.predicted === true);
    ok('a.2: reason tagged answered-downstream', r.body.reason && /^answered-downstream:/.test(r.body.reason));
    ok('a.3: provenance points at the decision note', r.body.appliedNote && r.body.appliedNote.key === 'note-dec1');
    ok('a.4: NOTHING in the pending guidance queue', overlayStore.pendingGuidance(ov).length === 0);
    const item = ov.guidance.find((g) => g.id === r.body.id);
    ok('a.5: guidance item recorded resolved + predicted', item && item.resolved === true && item.predicted === true);
    ok('a.6: loop NOT paused', loops.get('L1').active === true);
    ok('a.7: change notified', wasNotified());
  }

  // ---- (b) hard-override + same confident note → STILL escalates --------------------------------
  {
    const { ctx, ov, loops, getLast } = makeCtx(0.99); // perfect cosine, but override forces escalate
    const route = handler(ctx);
    await route('/guidance', 'POST', req({ question: QUESTION, irreversible: true }), res, u);
    const r = getLast();
    ok('b.1: hard-override did NOT predict', r && !r.body.predicted);
    ok('b.2: hard-override escalated to the pending queue', overlayStore.pendingGuidance(ov).length === 1);
    ok('b.3: hard-override paused the loop', loops.get('L1').active === false);
  }

  // ---- (c) diffuse / low-confidence note → still ASKS ------------------------------------------
  {
    const { ctx, ov, loops, getLast } = makeCtx(0.20); // low cosine ⇒ below the strict cos floor ⇒ ask
    const route = handler(ctx);
    await route('/guidance', 'POST', req({ question: QUESTION }), res, u);
    const r = getLast();
    ok('c.1: low-confidence did NOT predict', r && !r.body.predicted);
    ok('c.2: one pending guidance item queued', overlayStore.pendingGuidance(ov).length === 1);
    ok('c.3: blocking loop paused', loops.get('L1').active === false);
  }

  // ---- journal: answered-downstream verdicts are appended with a distinct reason ---------------
  {
    const jp = path.join(WS, '.graph', 'ask-journal.jsonl');
    const lines = fs.existsSync(jp) ? fs.readFileSync(jp, 'utf8').trim().split('\n').filter(Boolean) : [];
    const dsRows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && typeof x.reason === 'string' && /^answered-downstream/.test(x.reason));
    ok('j.1: at least one answered-downstream verdict journaled', dsRows.length >= 1);
    ok('j.2: answered-downstream rows tagged with the guidance seam', dsRows.every((x) => x.seam === 'guidance'));
  }

  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
