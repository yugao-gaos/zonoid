#!/usr/bin/env node
// Verifies the batched bulk-ingest path that lets the daemon take concurrent inject load:
//
//   (C) routes/overlay.js  POST /overlay/notes/bulk — embeds N notes via embedBatch in chunks (NOT
//       N single embeds), SKIPS the O(n) near-duplicate cosine guard, bumps the epoch EXACTLY ONCE.
//   (A) lib/embed-server.js  embedBatch / POST /embed-batch — feeds the WHOLE array to the extractor
//       in ONE inference and splits the flat [N*DIMS] output into N DIMS-length vectors.
//
// Fully STUBBED — no real MiniLM, no live sidecar/daemon. Run: node test/bulk-ingest.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const { noteEmbedText } = require('../lib/node-tags');

const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-ingest-'));
graphStore.forWorkspace(TMP_WS);

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const DIMS = 384;
const dummyVec = (seed) => Array.from({ length: DIMS }, (_, i) => ((i + seed) % 97) / 97);

// ---- ctx mock mirroring test/overlay-reembed.test.js, plus a batch-embed spy --------------------
function makeCtx(overlay) {
  let lastSent = null;
  const gs = graphStore.open(path.join(TMP_WS, '.graph'));
  // embedBatch SPY: records each call's argument so we can assert it was called with ARRAYS (batched)
  // rather than the route falling back to N single embed() calls. Returns [{ vec }] like the real client.
  const embedBatchCalls = [];
  let cosineCalls = 0;
  const ctx = {
    send(res, status, body) { lastSent = { status, body }; },
    sendOp(res, b, status, body) { lastSent = { status, body }; },
    readBody: async () => ({}),
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ov: overlay, ws: TMP_WS, save: () => {} }),
    opReplay: () => false,
    cosine: () => { cosineCalls++; return 0; }, // dup-guard would call this; bulk must NOT
    embed: async () => { throw new Error('single embed() must NOT be used by the bulk path'); },
    embedBatch: async (texts) => {
      embedBatchCalls.push(texts);
      return texts.map((_t, i) => ({ vec: dummyVec(i) }));
    },
    embeddingMeta: () => ({ provider: 'minilm', model: 'all-MiniLM-L6-v2', dimensions: DIMS, identity: 'minilm:all-MiniLM-L6-v2:384' }),
    knowledgeText: () => '',
    snapshotNative: () => {},
    now: () => new Date().toISOString(),
    suggestToks: () => new Set(),
    scoreNodeAgainstTokens: () => ({ score: 0 }),
    SUGGEST_DUP_THRESHOLD: 0.6,
    DIMS,
    cache: { agg: new Map(), aggAt: new Map() },
    git: { currentBranch: () => null },
  };
  return { ctx, getLastSent: () => lastSent, embedBatchCalls, getCosineCalls: () => cosineCalls };
}

(async () => {
  // ============================================================================================
  // (C) POST /overlay/notes/bulk
  // ============================================================================================
  {
    const overlayRoute = require('../routes/overlay');
    const o = ov.EMPTY();
    const N = 200; // enough to exercise multi-chunk batching (CHUNK=48 → 5 chunks) and show it scales
    const notes = Array.from({ length: N }, (_, i) => ({
      title: `symbol_${i}`,
      summary: `Code symbol number ${i} ingested in bulk for concurrency.`,
      category: 'system',
      tags: ['bulk', 'symbol'],
    }));

    const { ctx, getLastSent, embedBatchCalls, getCosineCalls } = makeCtx(o);
    ctx.readBody = async () => ({ notes, workspace: TMP_WS });
    const epochBefore = o.epoch;
    const route = overlayRoute(ctx);
    await route('/overlay/notes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);

    const result = getLastSent();
    const createdNodes = Object.values(o.note_nodes);

    ok('bulk returns 200', result && result.status === 200);
    ok('bulk response ok:true', result && result.body && result.body.ok === true);
    ok(`bulk created all ${N} notes (response.created)`, result && result.body && result.body.created === N);
    ok(`bulk created ${N} note nodes in overlay`, createdNodes.length === N);
    ok('bulk returns a key per created note', result && Array.isArray(result.body.keys) && result.body.keys.length === N);

    // BATCHED, not N singles: embedBatch was called with ARRAYS, and the total embedded == N.
    ok('bulk used embedBatch (batched embedding)', embedBatchCalls.length >= 1);
    ok('every embedBatch call received an ARRAY', embedBatchCalls.every((a) => Array.isArray(a)));
    ok('bulk made far fewer embed CALLS than notes (chunked, not per-note)', embedBatchCalls.length < N);
    const totalEmbedded = embedBatchCalls.reduce((s, a) => s + a.length, 0);
    ok(`embedBatch covered all ${N} note texts exactly once`, totalEmbedded === N);
    // Chunking: each call is bounded (~48), proving it isn't one giant array nor N singletons.
    ok('each embedBatch chunk is bounded (<= 48)', embedBatchCalls.every((a) => a.length <= 48));
    // The pooled text fed to the batch must be noteEmbedText (same as the single-note .vec path).
    const firstSent = embedBatchCalls[0][0];
    ok('bulk embeds noteEmbedText (title+category+tags+summary), not title-only',
      firstSent === noteEmbedText({ title: notes[0].title, category: notes[0].category, tags: notes[0].tags, summary: notes[0].summary })
      && firstSent !== notes[0].title);

    // Pooled vec assigned to each node from the batch.
    ok('every created node has a 384-dim pooled vec', createdNodes.every((n) => Array.isArray(n.vec) && n.vec.length === DIMS));
    ok('created nodes carry vecMeta', createdNodes.every((n) => n.vecMeta && n.vecMeta.dimensions === DIMS));

    // EPOCH bumped EXACTLY ONCE for the whole batch (not once per note).
    ok('bulk bumped epoch exactly once for the whole batch', o.epoch === epochBefore + 1);

    // DUP-GUARD skipped: the O(n) cosine scan must never run on the bulk path.
    ok('bulk did NOT invoke the near-duplicate cosine guard', getCosineCalls() === 0);
  }

  // ---- validation: empty notes[] and missing title/summary -------------------------------------
  {
    const overlayRoute = require('../routes/overlay');
    {
      const o = ov.EMPTY();
      const { ctx, getLastSent } = makeCtx(o);
      ctx.readBody = async () => ({ notes: [], workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/notes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('bulk rejects empty notes[] with 400', r && r.status === 400 && r.body.ok === false);
    }
    {
      const o = ov.EMPTY();
      const { ctx, getLastSent } = makeCtx(o);
      ctx.readBody = async () => ({ notes: [{ title: 'ok', summary: 'ok' }, { title: 'no summary' }], workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/notes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('bulk rejects a note missing summary with 400', r && r.status === 400 && r.body.ok === false);
      ok('bulk creates NOTHING when a note is invalid', Object.keys(o.note_nodes).length === 0);
    }
  }

  // ============================================================================================
  // (A) lib/embed-server.js embedBatch — ARRAY → ONE inference → split into N DIMS-vecs
  // ============================================================================================
  {
    // Requiring the module does NOT bind a socket or load MiniLM (guarded by require.main === module).
    const server = require('../lib/embed-server');
    ok('embed-server exports embedBatch + __setExtractor', typeof server.embedBatch === 'function' && typeof server.__setExtractor === 'function');

    // STUB extractor: assert it receives an ARRAY in a SINGLE call, and return a flat [N*DIMS]
    // Float32Array (exactly the tensor.data shape the real pipeline yields for array input).
    const extractorCalls = [];
    server.__setExtractor(async (input, opts) => {
      extractorCalls.push({ input, opts });
      const n = Array.isArray(input) ? input.length : 1;
      const flat = new Float32Array(n * DIMS);
      for (let r = 0; r < n; r++) for (let c = 0; c < DIMS; c++) flat[r * DIMS + c] = (r * 0.01 + c) / 1000;
      return { data: flat };
    });

    const texts = ['alpha symbol', 'beta symbol', 'gamma symbol', 'delta symbol'];
    const vecs = await server.embedBatch(texts);

    ok('embedBatch called the extractor exactly ONCE (one inference for the whole array)', extractorCalls.length === 1);
    ok('embedBatch passed an ARRAY to the extractor', Array.isArray(extractorCalls[0].input) && extractorCalls[0].input.length === texts.length);
    ok('embedBatch requested mean-pool + normalize', extractorCalls[0].opts && extractorCalls[0].opts.pooling === 'mean' && extractorCalls[0].opts.normalize === true);
    ok('embedBatch returns one entry per input text', Array.isArray(vecs) && vecs.length === texts.length);
    ok('embedBatch split the flat output into N DIMS-length vectors', vecs.every((v) => Array.isArray(v) && v.length === DIMS));
    // The split must align: vec[r][c] === flat[r*DIMS + c]. Check a couple of cells.
    ok('embedBatch slice alignment is correct (row 0, col 5)', Math.abs(vecs[0][5] - ((0 * 0.01 + 5) / 1000)) < 1e-9);
    ok('embedBatch slice alignment is correct (row 2, col 0)', Math.abs(vecs[2][0] - ((2 * 0.01 + 0) / 1000)) < 1e-9);

    // Blank entries: scattered back as null, and non-blank ones still embedded in one call.
    extractorCalls.length = 0;
    const mixed = await server.embedBatch(['real one', '', '   ', 'real two']);
    ok('embedBatch returns null for blank entries', mixed[1] === null && mixed[2] === null);
    ok('embedBatch embeds the non-blank entries', Array.isArray(mixed[0]) && mixed[0].length === DIMS && Array.isArray(mixed[3]) && mixed[3].length === DIMS);
    ok('embedBatch still only ONE inference for a mixed array', extractorCalls.length === 1 && extractorCalls[0].input.length === 2);

    // No extractor loaded → all-null (fail-soft, mirrors embed()).
    server.__setExtractor(null);
    const nulls = await server.embedBatch(['x', 'y']);
    ok('embedBatch fail-soft: all-null when extractor unavailable', Array.isArray(nulls) && nulls.length === 2 && nulls.every((v) => v === null));
    ok('embedBatch([]) returns []', (await server.embedBatch([])).length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
