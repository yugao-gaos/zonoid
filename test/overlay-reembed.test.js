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
const { noteEmbedText } = require('../lib/node-tags');

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
};

const EXPECTED_TEXT = noteEmbedText({
  title: NOTE.title,
  category: NOTE.category,
  tags: NOTE.tags,
  summary: NOTE.summary,
});

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

  // backfill-embeddings uses noteEmbedText for notes missing vec
  {
    const o = ov.EMPTY();
    o.note_nodes = { [NOTE.id]: { ...NOTE } };
    const { ctx, getLastSent, embedCalls } = makeCtx(o);
    const route = overlayRoute(ctx);
    await route('/overlay/backfill-embeddings', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    ok('backfill returns 200', result && result.status === 200);
    ok('backfill embeds one note', result && result.body && result.body.notes && result.body.notes.embedded === 1);
    ok('backfill calls embed with full note text', embedCalls.length === 1 && embedCalls[0] === EXPECTED_TEXT);
    ok('backfill text is not title-only', embedCalls[0] !== NOTE.title);
  }

  // reembed (force) re-embeds even when vec already present
  {
    const o = ov.EMPTY();
    o.note_nodes = { [NOTE.id]: { ...NOTE, vec: FAKE_VEC } };
    const { ctx, getLastSent, embedCalls } = makeCtx(o);
    ctx.readBody = async () => ({ force: true });
    const route = overlayRoute(ctx);
    await route('/overlay/reembed', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    ok('reembed returns 200', result && result.status === 200);
    ok('reembed embeds one note', result && result.body && result.body.embedded === 1);
    ok('reembed calls embed with full note text', embedCalls.length === 1 && embedCalls[0] === EXPECTED_TEXT);
    ok('reembed text is not title-only', embedCalls[0] !== NOTE.title);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
