#!/usr/bin/env node
// Verifies the dedicated code-index bulk write path (Phase 2 of the native onboarder):
//
//   routes/overlay.js  POST /overlay/code-nodes/bulk — embeds N symbols via embedBatch in chunks (NOT
//       N single embeds), SKIPS any near-duplicate guard, bumps the epoch EXACTLY ONCE, and writes into
//       the SEPARATE overlay.code_nodes map (NOT note_nodes) via upsertCodeNode.
//
// Mirrors test/bulk-ingest.test.js. Fully STUBBED — no real MiniLM, no live sidecar/daemon.
// Run: node test/code-node-bulk.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const { codeNodeEmbedText } = require('../lib/node-tags');

const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'code-node-bulk-'));
graphStore.forWorkspace(TMP_WS);

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const DIMS = 384;
const dummyVec = (seed) => Array.from({ length: DIMS }, (_, i) => ((i + seed) % 97) / 97);

function makeCtx(overlay) {
  let lastSent = null;
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
    cosine: () => { cosineCalls++; return 0; }, // a dup-guard would call this; bulk must NOT
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
  const overlayRoute = require('../routes/overlay');

  // ============================================================================================
  // POST /overlay/code-nodes/bulk — N symbols, batched, separate map, one epoch, no dup-guard
  // ============================================================================================
  {
    const o = ov.EMPTY();
    const N = 200; // multi-chunk batching (CHUNK=48 → 5 chunks)
    const nodes = Array.from({ length: N }, (_, i) => ({
      name: `fn_${i}`,
      kind: i % 2 ? 'function' : 'method',
      file: `lib/mod_${i % 7}.js`,
      start_line: i * 3 + 1,
      end_line: i * 3 + 9,
      signature: `fn_${i}(a, b)`,
      exported: i % 3 === 0,
    }));

    const { ctx, getLastSent, embedBatchCalls, getCosineCalls } = makeCtx(o);
    ctx.readBody = async () => ({ nodes, workspace: TMP_WS });
    const epochBefore = o.epoch;
    const route = overlayRoute(ctx);
    await route('/overlay/code-nodes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);

    const result = getLastSent();
    const createdNodes = Object.values(o.code_nodes);

    ok('bulk returns 200', result && result.status === 200);
    ok('bulk response ok:true', result && result.body && result.body.ok === true);
    ok(`bulk created all ${N} code nodes (response.created)`, result && result.body && result.body.created === N);
    ok(`bulk created ${N} code nodes in overlay.code_nodes`, createdNodes.length === N);
    ok('bulk returns a key per created node', result && Array.isArray(result.body.keys) && result.body.keys.length === N);
    ok('keys are code:<file>#<name>', result.body.keys[0] === `code:lib/mod_0.js#fn_0`);

    // SEPARATE MAP: nothing leaked into note_nodes or knowledge_nodes.
    ok('bulk wrote NOTHING into note_nodes', Object.keys(o.note_nodes).length === 0);
    ok('bulk wrote NOTHING into knowledge_nodes', Object.keys(o.knowledge_nodes).length === 0);

    // BATCHED, not N singles.
    ok('bulk used embedBatch (batched embedding)', embedBatchCalls.length >= 1);
    ok('every embedBatch call received an ARRAY', embedBatchCalls.every((a) => Array.isArray(a)));
    ok('bulk made far fewer embed CALLS than nodes (chunked)', embedBatchCalls.length < N);
    const totalEmbedded = embedBatchCalls.reduce((s, a) => s + a.length, 0);
    ok(`embedBatch covered all ${N} node texts exactly once`, totalEmbedded === N);
    ok('each embedBatch chunk is bounded (<= 48)', embedBatchCalls.every((a) => a.length <= 48));

    // The pooled text fed to the batch must be codeNodeEmbedText (name — signature in file).
    const firstSent = embedBatchCalls[0][0];
    ok('bulk embeds codeNodeEmbedText (name — signature in file), not name-only',
      firstSent === codeNodeEmbedText({ name: nodes[0].name, signature: nodes[0].signature, file: nodes[0].file })
      && firstSent !== nodes[0].name);

    // Pooled vec + meta assigned to each node from the batch.
    ok('every created node has a 384-dim pooled vec', createdNodes.every((n) => Array.isArray(n.vec) && n.vec.length === DIMS));
    ok('created nodes carry vecMeta', createdNodes.every((n) => n.vecMeta && n.vecMeta.dimensions === DIMS));
    // Salient fields preserved.
    const sample = o.code_nodes['code:lib/mod_0.js#fn_0'];
    ok('node preserves kind/file/lines/signature/exported',
      sample && sample.kind === 'method' && sample.file === 'lib/mod_0.js'
      && sample.start_line === 1 && sample.end_line === 9 && sample.signature === 'fn_0(a, b)' && sample.exported === true);

    // EPOCH bumped EXACTLY ONCE for the whole batch.
    ok('bulk bumped epoch exactly once for the whole batch', o.epoch === epochBefore + 1);

    // DUP-GUARD skipped: no cosine scan on the bulk path.
    ok('bulk did NOT invoke any near-duplicate cosine guard', getCosineCalls() === 0);
  }

  // ---- idempotent upsert: re-ingesting the same key overwrites in place (no duplicate node) --------
  {
    const o = ov.EMPTY();
    const { ctx } = makeCtx(o);
    ctx.readBody = async () => ({ nodes: [{ name: 'foo', kind: 'function', file: 'a.js', signature: 'foo()' }], workspace: TMP_WS });
    const route = overlayRoute(ctx);
    await route('/overlay/code-nodes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const createdAt1 = o.code_nodes['code:a.js#foo'].created_at;
    // re-ingest same symbol with a changed signature
    const { ctx: ctx2 } = makeCtx(o);
    ctx2.readBody = async () => ({ nodes: [{ name: 'foo', kind: 'function', file: 'a.js', signature: 'foo(x)' }], workspace: TMP_WS });
    await overlayRoute(ctx2)('/overlay/code-nodes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    ok('re-ingest keeps ONE node for the same key', Object.keys(o.code_nodes).length === 1);
    ok('re-ingest overwrites signature in place', o.code_nodes['code:a.js#foo'].signature === 'foo(x)');
    ok('re-ingest preserves created_at', o.code_nodes['code:a.js#foo'].created_at === createdAt1);
  }

  // ---- validation: empty nodes[] and missing name/kind ------------------------------------------
  {
    {
      const o = ov.EMPTY();
      const { ctx, getLastSent } = makeCtx(o);
      ctx.readBody = async () => ({ nodes: [], workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-nodes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('bulk rejects empty nodes[] with 400', r && r.status === 400 && r.body.ok === false);
    }
    {
      const o = ov.EMPTY();
      const { ctx, getLastSent } = makeCtx(o);
      ctx.readBody = async () => ({ nodes: [{ name: 'ok', kind: 'function' }, { name: 'no kind' }], workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-nodes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('bulk rejects a node missing kind with 400', r && r.status === 400 && r.body.ok === false);
      ok('bulk creates NOTHING when a node is invalid', Object.keys(o.code_nodes).length === 0);
    }
  }

  // ---- ADDITIVE check: the dup-judge/note-learner iterate note_nodes, which code_nodes never touch -
  {
    const o = ov.EMPTY();
    o.note_nodes['note-x'] = { id: 'note-x', title: 'a note', summary: 's', tags: [], knowledge: [] };
    const before = JSON.stringify(o.note_nodes);
    const { ctx } = makeCtx(o);
    ctx.readBody = async () => ({ nodes: [{ name: 'g', kind: 'function', file: 'b.js', signature: 'g()' }], workspace: TMP_WS });
    await overlayRoute(ctx)('/overlay/code-nodes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    ok('code bulk left existing note_nodes byte-identical', JSON.stringify(o.note_nodes) === before);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
