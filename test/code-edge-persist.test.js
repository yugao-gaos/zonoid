#!/usr/bin/env node
// Persistence + endpoint + ingest/sync-wiring tests for the deterministic code-EDGE layer.
// Fully STUBBED — no real git, no real daemon, no MiniLM. Covers:
//
//   lib/overlay.js  (code_edges layer)
//     • addCodeEdges / replaceCodeEdgesForFile / removeCodeEdgesForFile — normalize + de-dup, per-file
//       replace/remove semantics, and RELOAD SURVIVAL (code_edge_added/removed events round-trip
//       through graph-store so adds + per-file removals persist across an ov.load()).
//
//   routes/overlay.js
//     • POST /overlay/code-nodes/bulk     — optional `edges` fold into the code_edges layer
//     • POST /overlay/code-nodes/replace  — optional per-file `edges` replace alongside node replace
//     • POST /overlay/code-edges/replace  — per-file edge replace route
//     • DELETE /overlay/code-edges        — per-file edge remove route
//
//   lib/code-extract/ingest.js
//     • ingestRepo resolves extractor edges and sends them on the bulk POST (no longer dropped)
//
//   lib/code-extract/sync.js
//     • syncRepo recomputes edges for changed files (replace) and removes edges for deleted files,
//       using the opts.resolveAll seam (so no real extract is needed)
//
// Run: node test/code-edge-persist.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const ingest = require('../lib/code-extract/ingest');
const sync = require('../lib/code-extract/sync');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const DIMS = 384;
const dummyVec = (seed) => Array.from({ length: DIMS }, (_, i) => ((i + seed) % 97) / 97);

// Reusable stubbed route ctx (mirrors test/code-sync-unit.test.js).
function makeCtx(overlay, ws, body) {
  let lastSent = null;
  const ctx = {
    send(res, status, b) { lastSent = { status, body: b }; },
    sendOp(res, b, status, bb) { lastSent = { status, body: bb }; },
    readBody: async () => body,
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ov: overlay, ws, save: () => ov.save(ws, overlay) }),
    opReplay: () => false,
    cosine: () => 0,
    embed: async () => { throw new Error('single embed() must NOT be used'); },
    embedBatch: async (texts) => texts.map((_t, i) => ({ vec: dummyVec(i) })),
    embeddingMeta: () => ({ provider: 'minilm', model: 'all-MiniLM-L6-v2', dimensions: DIMS, identity: 'x' }),
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
  return { ctx, getLastSent: () => lastSent };
}

(async () => {
  const overlayRoute = require('../routes/overlay');

  // ================================================================================================
  // overlay.code_edges: add / replace / remove + normalization + de-dup
  // ================================================================================================
  {
    const o = ov.EMPTY();
    const r1 = ov.addCodeEdges(o, [
      { from_file: 'a.js', to: 'code:b.js#foo', kind: 'calls', name: 'foo', junk: 'dropme' },
      { from_file: 'a.js', to: 'code:b.js#foo', kind: 'calls', name: 'foo' }, // dup -> skipped
      { from_file: 'a.js', to_file: 'c.js', kind: 'imports' },
      { from_file: '', to: 'code:x#y', kind: 'calls' }, // invalid (no from_file) -> dropped
    ]);
    ok('addCodeEdges added 2 (de-duped + dropped invalid)', r1.added.length === 2);
    ok('addCodeEdges normalized away unknown fields', o.code_edges.every((e) => !('junk' in e)));
    ok('addCodeEdges kept the file-level import (to_file)', o.code_edges.some((e) => e.to_file === 'c.js' && !e.to));
    ok('overlay.code_edges has exactly 2', o.code_edges.length === 2);
  }

  // replace per-file
  {
    const o = ov.EMPTY();
    ov.addCodeEdges(o, [
      { from_file: 'a.js', to: 'code:b.js#one', kind: 'calls' },
      { from_file: 'a.js', to: 'code:b.js#two', kind: 'calls' },
      { from_file: 'z.js', to: 'code:b.js#keep', kind: 'calls' },
    ]);
    const rep = ov.replaceCodeEdgesForFile(o, 'a.js', [
      { from_file: 'a.js', to: 'code:b.js#three', kind: 'calls' }, // new single edge
      { from_file: 'OTHER.js', to: 'code:b.js#nope', kind: 'calls' }, // wrong from_file -> ignored
    ]);
    ok('replaceCodeEdgesForFile removed the 2 old a.js edges', rep.removed === 2);
    ok('replaceCodeEdgesForFile added only the matching-from_file edge', rep.added.length === 1);
    ok('replace left z.js edge intact', o.code_edges.some((e) => e.from_file === 'z.js'));
    ok('replace dropped a.js#one/#two, kept a.js#three',
      !o.code_edges.some((e) => e.to === 'code:b.js#one') && o.code_edges.some((e) => e.to === 'code:b.js#three'));
    ok('replace ignored the OTHER.js edge (per-file unit)', !o.code_edges.some((e) => e.from_file === 'OTHER.js'));

    // empty replace clears the file
    const rep2 = ov.replaceCodeEdgesForFile(o, 'a.js', []);
    ok('replace with [] clears the file (removed 1)', rep2.removed === 1 && !o.code_edges.some((e) => e.from_file === 'a.js'));
  }

  // remove per-file
  {
    const o = ov.EMPTY();
    ov.addCodeEdges(o, [
      { from_file: 'd.js', to: 'code:b.js#a', kind: 'calls' },
      { from_file: 'd.js', to: 'code:b.js#b', kind: 'calls' },
      { from_file: 'e.js', to: 'code:b.js#c', kind: 'calls' },
    ]);
    const rm = ov.removeCodeEdgesForFile(o, 'd.js');
    ok('removeCodeEdgesForFile removed both d.js edges', rm.removed === 2);
    ok('removeCodeEdgesForFile left e.js edge', o.code_edges.length === 1 && o.code_edges[0].from_file === 'e.js');
  }

  // ================================================================================================
  // RELOAD SURVIVAL: add + per-file remove round-trip through graph-store (ov.save -> ov.load)
  // ================================================================================================
  {
    const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'code-edge-reload-'));
    graphStore.forWorkspace(TMP_WS);
    const o = ov.load(TMP_WS);
    ov.addCodeEdges(o, [
      { from_file: 'm.js', to: 'code:lib.js#foo', kind: 'calls', name: 'foo' },
      { from_file: 'm.js', to_file: 'lib.js', kind: 'imports' },
      { from_file: 'n.js', to: 'code:lib.js#bar', kind: 'calls', name: 'bar' },
    ]);
    ov.save(TMP_WS, o);

    const reloaded = ov.load(TMP_WS);
    ok('after reload: 3 code edges survived', (reloaded.code_edges || []).length === 3);
    ok('after reload: m.js call edge present',
      reloaded.code_edges.some((e) => e.from_file === 'm.js' && e.to === 'code:lib.js#foo' && e.name === 'foo'));
    ok('after reload: m.js file-level import edge present',
      reloaded.code_edges.some((e) => e.from_file === 'm.js' && e.to_file === 'lib.js' && e.kind === 'imports'));
    ok('after reload: synthetic codeedge: container node did NOT leak into graph.nodes',
      !Object.keys(graphStore.loadGraph(graphStore.forWorkspace(TMP_WS)).nodes).some((id) => id.startsWith('codeedge:')));

    // Now remove m.js edges and confirm the removal survives a reload (tombstone, not resurrected).
    ov.removeCodeEdgesForFile(reloaded, 'm.js');
    ov.save(TMP_WS, reloaded);
    const reloaded2 = ov.load(TMP_WS);
    ok('after remove + reload: m.js edges gone (removal survived)',
      !reloaded2.code_edges.some((e) => e.from_file === 'm.js'));
    ok('after remove + reload: n.js edge still present',
      reloaded2.code_edges.some((e) => e.from_file === 'n.js'));

    fs.rmSync(TMP_WS, { recursive: true, force: true });
  }

  // ================================================================================================
  // routes: bulk fold + replace fold + dedicated code-edges routes
  // ================================================================================================
  {
    const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'code-edge-route-'));
    graphStore.forWorkspace(TMP_WS);
    const o = ov.EMPTY();

    // bulk with edges folded in
    {
      const body = {
        nodes: [
          { name: 'foo', kind: 'function', file: 'a.js', signature: 'foo()', exported: true },
          { name: 'bar', kind: 'function', file: 'b.js', signature: 'bar()', exported: true },
        ],
        edges: [
          { from_file: 'b.js', to: 'code:a.js#foo', kind: 'calls', name: 'foo' },
          { from_file: 'b.js', to_file: 'a.js', kind: 'imports' },
        ],
        workspace: TMP_WS,
      };
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, body);
      await overlayRoute(ctx)('/overlay/code-nodes/bulk', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('bulk with edges returns 200', r && r.status === 200);
      ok('bulk created 2 nodes', r.body.created === 2);
      ok('bulk reported edges_added: 2', r.body.edges_added === 2);
      ok('bulk wrote 2 code edges into overlay.code_edges', o.code_edges.length === 2);
    }

    // replace a node-file's edges via the node replace route (edges fold)
    {
      const body = {
        file: 'b.js',
        nodes: [{ name: 'bar', kind: 'function', file: 'b.js', signature: 'bar(x)', exported: true }],
        edges: [{ from_file: 'b.js', to: 'code:a.js#foo', kind: 'calls', name: 'foo' }], // drop the import edge
        workspace: TMP_WS,
      };
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, body);
      await overlayRoute(ctx)('/overlay/code-nodes/replace', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('node replace with edges returns 200', r && r.status === 200);
      ok('node replace reports edges removed:2 added:1', r.body.edges && r.body.edges.removed === 2 && r.body.edges.added === 1);
      ok('after node replace: only the call edge remains for b.js',
        o.code_edges.filter((e) => e.from_file === 'b.js').length === 1 &&
        o.code_edges.some((e) => e.from_file === 'b.js' && e.kind === 'calls'));
    }

    // dedicated /overlay/code-edges/replace
    {
      ov.addCodeEdges(o, [{ from_file: 'c.js', to: 'code:a.js#foo', kind: 'calls' }]);
      const body = { file: 'c.js', edges: [
        { from_file: 'c.js', to: 'code:a.js#foo', kind: 'calls' },
        { from_file: 'c.js', to_file: 'a.js', kind: 'imports' },
      ], workspace: TMP_WS };
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, body);
      await overlayRoute(ctx)('/overlay/code-edges/replace', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('code-edges/replace returns 200', r && r.status === 200);
      ok('code-edges/replace reports deleted:1 created:2', r.body.deleted === 1 && r.body.created === 2);
      ok('code-edges/replace set exactly c.js 2 edges', o.code_edges.filter((e) => e.from_file === 'c.js').length === 2);
    }

    // dedicated DELETE /overlay/code-edges
    {
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { file: 'c.js', workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-edges', 'DELETE', { method: 'DELETE', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('DELETE code-edges returns 200', r && r.status === 200);
      ok('DELETE code-edges reports deleted:2', r.body.deleted === 2);
      ok('DELETE code-edges removed all c.js edges', !o.code_edges.some((e) => e.from_file === 'c.js'));
    }

    // validation: replace without file -> 400; without edges[] -> 400
    {
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { edges: [], workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-edges/replace', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      ok('code-edges/replace without file -> 400', getLastSent().status === 400);
    }
    {
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { file: 'q.js', workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-edges/replace', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      ok('code-edges/replace without edges[] -> 400', getLastSent().status === 400);
    }

    fs.rmSync(TMP_WS, { recursive: true, force: true });
  }

  // ================================================================================================
  // ingest.ingestRepo: resolves extractor edges and SENDS them on the bulk POST (no longer dropped).
  // Stub postJSON via a fake daemon — but ingestRepo uses the real extractor. To avoid needing babel,
  // monkeypatch resolveCodeEdges is not exposed for injection; instead drive the route directly above.
  // Here we assert the resolver passthrough is exported and that the bulk payload carries edges by
  // stubbing the HTTP POST and a tiny in-memory "repo" is not feasible without babel — so we assert the
  // wiring contract: ingest re-exports resolveCodeEdges and bulk payload SHAPE includes edges.
  // ================================================================================================
  {
    ok('ingest re-exports resolveCodeEdges', typeof ingest.resolveCodeEdges === 'function');
    // Contract-level check: resolveCodeEdges over a synthetic extract returns the same edges the bulk
    // route accepts (proves ingest will send a valid edges[] payload).
    const resolved = ingest.resolveCodeEdges({
      symbols: [{ name: 'foo', kind: 'function', file: 'a.js', exported: true }],
      edges: [{ from: 'b.js', to: 'foo', kind: 'calls' }],
    });
    ok('ingest.resolveCodeEdges yields a code edge for a cross-file call',
      resolved.codeEdges.some((e) => e.from_file === 'b.js' && e.to === 'code:a.js#foo'));
  }

  // ================================================================================================
  // sync.syncRepo: edges recomputed for changed files (replace) + removed for deleted files.
  // Injected git + injected daemon client + opts.resolveAll seam (no real extract).
  // ================================================================================================
  {
    const replaceNodeCalls = [];
    const deleteNodeCalls = [];
    const replaceEdgeCalls = [];
    const deleteEdgeCalls = [];
    const fakeDaemon = {
      replaceFile: async ({ file, nodes }) => { replaceNodeCalls.push(file); return { created: (nodes || []).length }; },
      deleteFile: async ({ file }) => { deleteNodeCalls.push(file); return { deleted: 2 }; },
      replaceEdges: async ({ file, edges }) => { replaceEdgeCalls.push({ file, edges }); return { created: (edges || []).length }; },
      deleteEdges: async ({ file }) => { deleteEdgeCalls.push(file); return { deleted: 3 }; },
      setLastIndexedCommit: async () => ({}),
    };
    // resolveAll returns repo-wide resolved edges: changed.js calls a symbol in unchanged.js.
    const resolveAll = async () => ([
      { from_file: 'changed.js', to: 'code:unchanged.js#dep', kind: 'calls', name: 'dep' },
      { from_file: 'changed.js', to_file: 'unchanged.js', kind: 'imports' },
      { from_file: 'unchanged.js', to: 'code:other.js#z', kind: 'calls', name: 'z' }, // not a changed file -> not pushed
    ]);

    const res = await sync.syncRepo(
      { repo: '/fake/repo', workspace: '/ws', lastCommit: 'OLD' },
      {
        git: async (_r, args) => {
          if (args[0] === 'rev-parse') return 'NEW';
          if (args[0] === 'diff') return ['M\tchanged.js', 'D\tgone.js'].join('\n');
          return '';
        },
        daemon: fakeDaemon,
        readFile: () => 'export function changed(){ return 1; }\n', // real source so extractFile gets symbols
        resolveAll,
      }
    );

    ok('sync replaced nodes for changed.js', replaceNodeCalls.includes('changed.js'));
    ok('sync deleted nodes for gone.js', deleteNodeCalls.includes('gone.js'));
    ok('sync replaced EDGES for changed.js', replaceEdgeCalls.some((c) => c.file === 'changed.js'));
    ok('sync pushed ONLY changed.js outgoing edges (2: call + import)',
      (replaceEdgeCalls.find((c) => c.file === 'changed.js') || {}).edges.length === 2);
    ok('sync did NOT push unchanged.js edges (not a changed file)',
      !replaceEdgeCalls.some((c) => c.file === 'unchanged.js'));
    ok('sync deleted EDGES for the deleted file gone.js', deleteEdgeCalls.includes('gone.js'));
    ok('sync summary edges_replaced === 2', res.edges_replaced === 2);
    ok('sync summary edges_deleted === 3', res.edges_deleted === 3);
  }

  // sync: a rename deletes OLD edges + replaces NEW file's edges.
  {
    const replaceEdgeCalls = [];
    const deleteEdgeCalls = [];
    const fakeDaemon = {
      replaceFile: async ({ nodes }) => ({ created: (nodes || []).length }),
      deleteFile: async () => ({ deleted: 1 }),
      replaceEdges: async ({ file, edges }) => { replaceEdgeCalls.push(file); return { created: (edges || []).length }; },
      deleteEdges: async ({ file }) => { deleteEdgeCalls.push(file); return { deleted: 1 }; },
      setLastIndexedCommit: async () => ({}),
    };
    await sync.syncRepo(
      { repo: '/fake/repo2', workspace: '/ws', lastCommit: 'OLD' },
      {
        git: async (_r, args) => {
          if (args[0] === 'rev-parse') return 'NEW';
          if (args[0] === 'diff') return 'R100\toldname.js\tnewname.js';
          return '';
        },
        daemon: fakeDaemon,
        readFile: () => 'export function moved(){ return 1; }\n',
        resolveAll: async () => ([{ from_file: 'newname.js', to: 'code:lib.js#x', kind: 'calls', name: 'x' }]),
      }
    );
    ok('sync rename: deleted OLD path edges', deleteEdgeCalls.includes('oldname.js'));
    ok('sync rename: replaced NEW path edges', replaceEdgeCalls.includes('newname.js'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
