#!/usr/bin/env node
// Verifies /overlay/reembed and /overlay/backfill-embeddings embed full note text
// (title + category + tags + summary) via noteEmbedText, not title-only.
// Run: node test/overlay-reembed.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const { noteEmbedText, noteFieldTexts } = require('../lib/node-tags');

const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-reembed-'));
graphStore.forWorkspace(TMP_WS);

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const DIMS = 384;
const FAKE_VEC = Array.from({ length: DIMS }, (_, i) => i / DIMS);

const NOTE = {
  id: 'abc123',
  title: 'Embedding source field',
  category: 'Decision',
  tags: ['embed', 'note'],
  summary: 'Reembed routes must use the full note body for vectors.',
  knowledge: [
    'Pooled vec stays the gate/dedup vector.',
    'Field vectors land in note.vecs for corpus scoring.',
  ],
};

const EXPECTED_TEXT = noteEmbedText({
  title: NOTE.title,
  category: NOTE.category,
  tags: NOTE.tags,
  summary: NOTE.summary,
});

// Field-level texts (title + summary + each knowledge[] entry) — one vector each in note.vecs.
const EXPECTED_FIELD_TEXTS = noteFieldTexts({
  title: NOTE.title,
  summary: NOTE.summary,
  knowledge: NOTE.knowledge,
});
// title + summary + 2 knowledge entries = 4 field texts.
const EXPECTED_FIELD_COUNT = EXPECTED_FIELD_TEXTS.length;

function makeCtx(overlay, embedFn) {
  let lastSent = null;
  const embedCalls = [];
  const gs = graphStore.open(path.join(TMP_WS, '.graph'));
  const ctx = {
    get state() {
      return {
        overlay,
        workspace: TMP_WS,
        graphStore: gs,
      };
    },
    send(res, status, body) { lastSent = { status, body }; },
    sendOp(res, b, status, body) { lastSent = { status, body }; },
    readBody: async () => ({}),
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ov: overlay, ws: TMP_WS, save: () => {} }),
    opReplay: () => false,
    cosine: () => 0,
    embed: async (text) => {
      embedCalls.push(text);
      return embedFn ? embedFn(text) : FAKE_VEC;
    },
    knowledgeText: () => '',
    snapshotNative: () => {},
    now: () => new Date().toISOString(),
    suggestToks: () => new Set(),
    scoreNodeAgainstTokens: () => ({ score: 0 }),
    SUGGEST_DUP_THRESHOLD: 0.6,
    DIMS,
    ALL_STATUSES: ['not_ready', 'ready', 'in_progress', 'tested', 'done', 'failed', 'canceled'],
    followups: { validate: () => null, apply: () => [] },
    verdicts: { validate: () => null, apply: () => [], sweepStaleHolds: () => ({ released: [], flagged: [] }), lintProse: () => null },
    agentsArr: () => [],
    saveAgents: () => {},
    cache: { agg: new Map(), aggAt: new Map() },
    touchAgent: () => {},
    writeTaskStatus: () => {},
    harness: { scheduler: { writeScheduledTask: () => ({}) } },
    git: { currentBranch: () => null },
  };
  return { ctx, getLastSent: () => lastSent, embedCalls };
}

(async () => {
  const overlayRoute = require('../routes/overlay');

  // backfill-embeddings uses noteEmbedText for the pooled .vec AND noteFieldTexts for the .vecs set
  {
    const o = ov.EMPTY();
    o.note_nodes = { [NOTE.id]: { ...NOTE } };
    const { ctx, getLastSent, embedCalls } = makeCtx(o);
    const route = overlayRoute(ctx);
    await route('/overlay/backfill-embeddings', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    const n = o.note_nodes[NOTE.id];
    ok('backfill returns 200', result && result.status === 200);
    ok('backfill embeds one note', result && result.body && result.body.notes && result.body.notes.embedded === 1);
    ok('backfill calls embed with full pooled note text', embedCalls.includes(EXPECTED_TEXT));
    ok('backfill pooled text is not title-only', embedCalls[0] !== NOTE.title);
    // POOLED vec stays present (gate/dedup vector).
    ok('backfill sets pooled note.vec', Array.isArray(n.vec) && n.vec.length === DIMS);
    // FIELD-LEVEL set: one vector per non-empty field (title + summary + each knowledge[] entry).
    ok('backfill populates note.vecs', Array.isArray(n.vecs) && n.vecs.length === EXPECTED_FIELD_COUNT);
    ok('backfill .vecs INCLUDES a vector per knowledge[] entry',
      n.vecs.length >= NOTE.knowledge.length + 2 && EXPECTED_FIELD_COUNT === NOTE.knowledge.length + 2);
    ok('backfill embeds every field text (incl. knowledge entries)',
      EXPECTED_FIELD_TEXTS.every((t) => embedCalls.includes(t)));
    ok('backfill embeds each knowledge[] entry text',
      NOTE.knowledge.every((k) => embedCalls.includes(k)));
  }

  // reembed (force) re-embeds even when vec already present — pooled .vec + field-level .vecs
  {
    const o = ov.EMPTY();
    o.note_nodes = { [NOTE.id]: { ...NOTE, vec: FAKE_VEC } };
    const { ctx, getLastSent, embedCalls } = makeCtx(o);
    ctx.readBody = async () => ({ force: true });
    const route = overlayRoute(ctx);
    await route('/overlay/reembed', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    const n = o.note_nodes[NOTE.id];
    ok('reembed returns 200', result && result.status === 200);
    ok('reembed embeds one note', result && result.body && result.body.embedded === 1);
    ok('reembed calls embed with full pooled note text', embedCalls.includes(EXPECTED_TEXT));
    ok('reembed pooled text is not title-only', embedCalls[0] !== NOTE.title);
    ok('reembed sets pooled note.vec', Array.isArray(n.vec) && n.vec.length === DIMS);
    ok('reembed populates note.vecs', Array.isArray(n.vecs) && n.vecs.length === EXPECTED_FIELD_COUNT);
    ok('reembed .vecs INCLUDES a vector per knowledge[] entry',
      n.vecs.length >= NOTE.knowledge.length + 2 && EXPECTED_FIELD_COUNT === NOTE.knowledge.length + 2);
    ok('reembed embeds each knowledge[] entry text',
      NOTE.knowledge.every((k) => embedCalls.includes(k)));
  }

  // reembed (no force) UPGRADES an existing single-.vec note to multivec (.vecs)
  {
    const o = ov.EMPTY();
    o.note_nodes = { [NOTE.id]: { ...NOTE, vec: FAKE_VEC } }; // has .vec, missing .vecs
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({}); // no force
    const route = overlayRoute(ctx);
    await route('/overlay/reembed', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    const n = o.note_nodes[NOTE.id];
    ok('reembed(no force) returns 200', result && result.status === 200);
    ok('reembed(no force) upgrades single-vec note (counts as embedded)', result && result.body && result.body.embedded === 1);
    ok('reembed(no force) populates note.vecs on the existing note', Array.isArray(n.vecs) && n.vecs.length === EXPECTED_FIELD_COUNT);
  }

  // reembed (no force) SKIPS a note that already has BOTH .vec and .vecs
  {
    const o = ov.EMPTY();
    o.note_nodes = { [NOTE.id]: { ...NOTE, vec: FAKE_VEC, vecs: EXPECTED_FIELD_TEXTS.map(() => FAKE_VEC) } };
    const { ctx, getLastSent, embedCalls } = makeCtx(o);
    ctx.readBody = async () => ({}); // no force
    const route = overlayRoute(ctx);
    await route('/overlay/reembed', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    ok('reembed(no force) skips a fully-embedded note', result && result.body && result.body.skipped === 1 && result.body.embedded === 0);
    ok('reembed(no force) does not call embed for a skipped note', embedCalls.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
