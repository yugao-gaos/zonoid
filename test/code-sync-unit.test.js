#!/usr/bin/env node
// STUBBED unit tests for the incremental git-diff code sync (Phase 3 of the native onboarder).
// No real git, no real daemon, no MiniLM. Covers:
//
//   lib/code-extract/sync.js
//     • parseNameStatus  — A/M/D/R/C name-status parsing (incl. rename old->new, similarity codes)
//     • syncRepo         — injected git + injected daemon client; asserts that
//                          ADDED/MODIFIED code files REPLACE (delete-by-file + bulk-upsert),
//                          DELETED files are removed, RENAME deletes old + replaces new,
//                          non-code files are skipped, lastIndexedCommit advances to HEAD,
//                          a matching HEAD is a no-op, and a missing watermark ⇒ full_onboard_needed.
//
//   lib/overlay.js
//     • removeCodeNodesForFile — drops exactly the file's nodes; emits code_node_removed on save so the
//                                deletion survives a reload (verified by re-loading the overlay).
//     • get/setLastIndexedCommit — round-trips through overlay.config.
//
//   routes/overlay.js
//     • DELETE /overlay/code-nodes              — delete-by-file route
//     • POST   /overlay/code-nodes/replace      — delete-by-file + bulk-upsert route (stubbed embeds)
//
// Run: node test/code-sync-unit.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const sync = require('../lib/code-extract/sync');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const DIMS = 384;
const dummyVec = (seed) => Array.from({ length: DIMS }, (_, i) => ((i + seed) % 97) / 97);

// Reusable stubbed route ctx (mirrors test/code-node-bulk.test.js).
function makeCtx(overlay, ws, body) {
  let lastSent = null;
  const ctx = {
    send(res, status, b) { lastSent = { status, body: b }; },
    sendOp(res, b, status, bb) { lastSent = { status, body: bb }; },
    readBody: async () => body,
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ov: overlay, ws, save: () => {} }),
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
  // ================================================================================================
  // parseNameStatus
  // ================================================================================================
  {
    const out = [
      'M\tlib/foo.js',
      'A\tlib/bar.ts',
      'D\tlib/gone.js',
      'R096\tlib/old.js\tlib/new.js',
      'C075\tlib/src.js\tlib/copy.js',
    ].join('\n');
    const changes = sync.parseNameStatus(out);
    ok('parseNameStatus parses 5 changes', changes.length === 5);
    ok('M parsed', changes[0].status === 'M' && changes[0].file === 'lib/foo.js');
    ok('A parsed', changes[1].status === 'A' && changes[1].file === 'lib/bar.ts');
    ok('D parsed', changes[2].status === 'D' && changes[2].file === 'lib/gone.js');
    ok('R parsed with old+new path', changes[3].status === 'R' && changes[3].oldFile === 'lib/old.js' && changes[3].file === 'lib/new.js');
    ok('C parsed with old+new path', changes[4].status === 'C' && changes[4].oldFile === 'lib/src.js' && changes[4].file === 'lib/copy.js');
    ok('blank lines ignored', sync.parseNameStatus('\n\nM\ta.js\n\n').length === 1);
  }

  // isCodeFile
  ok('isCodeFile true for .js', sync.isCodeFile('lib/x.js') === true);
  ok('isCodeFile true for .py', sync.isCodeFile('app/y.py') === true);
  ok('isCodeFile false for .md', sync.isCodeFile('README.md') === false);
  ok('isCodeFile false for .json', sync.isCodeFile('pkg.json') === false);

  // ================================================================================================
  // syncRepo — injected git + injected daemon client (no HTTP, no real git)
  // ================================================================================================
  {
    const repo = path.resolve('/fake/repo');
    // A real on-disk fixture so extractFile reads actual source for the added/modified files.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-fixture-'));
    fs.writeFileSync(path.join(fixtureDir, 'added.js'), 'export function brandNew(a){ return a+1; }\nexport const arrowAdd = (b) => b*2;\n');
    fs.writeFileSync(path.join(fixtureDir, 'modified.js'), 'export function changed(){ return 42; }\n');
    fs.writeFileSync(path.join(fixtureDir, 'notes.md'), '# not code\n');

    // Injected git: HEAD differs from lastCommit; diff lists one A, one M, one D code file, one D non-code.
    const gitCalls = [];
    const fakeGit = async (repoAbs, args) => {
      gitCalls.push(args.join(' '));
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'HEADSHA';
      if (args[0] === 'diff') {
        return [
          'A\tadded.js',
          'M\tmodified.js',
          'D\tdeleted.js',
          'D\tnotes.md',     // non-code delete -> skipped
        ].join('\n');
      }
      return '';
    };

    // Injected daemon client records every call.
    const replaceCalls = [];
    const deleteCalls = [];
    let watermarkSet = null;
    const fakeDaemon = {
      replaceFile: async ({ file, nodes, workspace }) => { replaceCalls.push({ file, nodes, workspace }); return { ok: true, file, deleted: 0, created: nodes.length }; },
      deleteFile: async ({ file, workspace }) => { deleteCalls.push({ file, workspace }); return { ok: true, file, deleted: 3 }; },
      setLastIndexedCommit: async ({ key, commit, workspace }) => { watermarkSet = { key, commit, workspace }; return { ok: true }; },
    };

    const res = await sync.syncRepo(
      { repo, workspace: '/ws', lastCommit: 'OLDSHA' },
      { git: fakeGit, daemon: fakeDaemon, commitKey: repo,
        // read fixture files by basename so extractFile sees real source
        readFile: (abs) => { const base = path.basename(abs); try { return fs.readFileSync(path.join(fixtureDir, base), 'utf8'); } catch { return null; } } }
    );

    ok('syncRepo ran git diff OLDSHA..HEADSHA', gitCalls.some((c) => c === 'diff OLDSHA..HEADSHA --name-status'));
    ok('syncRepo replaced the ADDED file', replaceCalls.some((c) => c.file === 'added.js'));
    ok('syncRepo replaced the MODIFIED file', replaceCalls.some((c) => c.file === 'modified.js'));
    ok('syncRepo did NOT replace the deleted code file', !replaceCalls.some((c) => c.file === 'deleted.js'));
    ok('syncRepo deleted the DELETED code file', deleteCalls.some((c) => c.file === 'deleted.js'));
    ok('syncRepo SKIPPED the non-code delete (notes.md)', !deleteCalls.some((c) => c.file === 'notes.md'));
    ok('notes.md reported as skipped', res.skipped.includes('notes.md'));

    // The ADDED file extracted >=2 real symbols (brandNew + arrowAdd) -> nodes were sent.
    const addedCall = replaceCalls.find((c) => c.file === 'added.js');
    ok('added.js replace carried extracted symbols (>=2)', addedCall && addedCall.nodes.length >= 2);
    ok('replace nodes look like code_node payloads (name+kind+file)',
      addedCall && addedCall.nodes.every((n) => n.name && n.kind && n.file === 'added.js'));

    // Watermark advanced to HEAD.
    ok('syncRepo advanced lastIndexedCommit to HEAD', watermarkSet && watermarkSet.commit === 'HEADSHA' && watermarkSet.key === repo);

    // Summary counts.
    ok('summary upserted counts the added+modified symbols', res.upserted >= 3);
    ok('summary deleted counts the removed file symbols', res.deleted === 3);
    ok('summary files_replaced === 2', res.files_replaced === 2);
    ok('summary files_deleted === 1', res.files_deleted === 1);
    ok('summary from/head set', res.from === 'OLDSHA' && res.head === 'HEADSHA');

    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  // ---- syncRepo: no watermark ⇒ full_onboard_needed ----------------------------------------------
  {
    const res = await sync.syncRepo(
      { repo: '/fake/repo2', workspace: '/ws' },
      { git: async () => 'HEAD', daemon: { replaceFile: async () => ({}), deleteFile: async () => ({}), setLastIndexedCommit: async () => ({}) },
        getLastIndexedCommit: async () => null }
    );
    ok('syncRepo with no watermark returns full_onboard_needed', res.full_onboard_needed === true);
  }

  // ---- syncRepo: HEAD === lastCommit ⇒ up-to-date no-op -------------------------------------------
  {
    let diffed = false;
    const res = await sync.syncRepo(
      { repo: '/fake/repo3', workspace: '/ws', lastCommit: 'SAME' },
      { git: async (_r, args) => { if (args[0] === 'diff') diffed = true; return 'SAME'; },
        daemon: { replaceFile: async () => ({}), deleteFile: async () => ({}), setLastIndexedCommit: async () => ({}) } }
    );
    ok('syncRepo no-ops when HEAD === lastCommit', res.up_to_date === true && res.changed_files.length === 0);
    ok('syncRepo does NOT diff when already up to date', diffed === false);
  }

  // ---- syncRepo: rename deletes old path + replaces new path -------------------------------------
  {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-rename-'));
    fs.writeFileSync(path.join(fixtureDir, 'renamed.js'), 'export function moved(){ return 1; }\n');
    const replaceCalls = [], deleteCalls = [];
    await sync.syncRepo(
      { repo: '/fake/repo4', workspace: '/ws', lastCommit: 'OLD' },
      { git: async (_r, args) => {
          if (args[0] === 'rev-parse') return 'NEW';
          if (args[0] === 'diff') return 'R100\told.js\trenamed.js';
          return '';
        },
        daemon: {
          replaceFile: async ({ file, nodes }) => { replaceCalls.push(file); return { created: nodes.length }; },
          deleteFile: async ({ file }) => { deleteCalls.push(file); return { deleted: 1 }; },
          setLastIndexedCommit: async () => ({}),
        },
        readFile: (abs) => { try { return fs.readFileSync(path.join(fixtureDir, path.basename(abs)), 'utf8'); } catch { return null; } } }
    );
    ok('rename deleted the OLD path', deleteCalls.includes('old.js'));
    ok('rename replaced the NEW path', replaceCalls.includes('renamed.js'));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  // ================================================================================================
  // overlay.removeCodeNodesForFile + get/setLastIndexedCommit (with reload-survival check)
  // ================================================================================================
  {
    const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-overlay-'));
    graphStore.forWorkspace(TMP_WS);
    const o = ov.load(TMP_WS);

    // Seed two files' worth of code nodes.
    ov.upsertCodeNode(o, { name: 'a1', kind: 'function', file: 'x.js', signature: 'a1()', vec: dummyVec(1), vecMeta: { dimensions: DIMS } });
    ov.upsertCodeNode(o, { name: 'a2', kind: 'function', file: 'x.js', signature: 'a2()', vec: dummyVec(2), vecMeta: { dimensions: DIMS } });
    ov.upsertCodeNode(o, { name: 'b1', kind: 'function', file: 'y.js', signature: 'b1()', vec: dummyVec(3), vecMeta: { dimensions: DIMS } });
    ov.save(TMP_WS, o);
    ok('seeded 3 code nodes across 2 files', Object.keys(o.code_nodes).length === 3);

    const r = ov.removeCodeNodesForFile(o, 'x.js');
    ok('removeCodeNodesForFile removed exactly x.js nodes (2)', r.removed.length === 2);
    ok('removeCodeNodesForFile left y.js node intact', !!o.code_nodes['code:y.js#b1'] && !o.code_nodes['code:x.js#a1']);
    ov.save(TMP_WS, o);

    // RELOAD: the deletion must survive (code_node_removed event replayed, not resurrected by the upsert
    // log). ov.load re-reads the event log from disk via graphStore.loadGraph, so a fresh load reflects
    // every appended event including the removal tombstone.
    const reloaded = ov.load(TMP_WS);
    ok('after reload, x.js nodes stay gone (deletion survived)',
      !reloaded.code_nodes['code:x.js#a1'] && !reloaded.code_nodes['code:x.js#a2']);
    ok('after reload, y.js node still present', !!reloaded.code_nodes['code:y.js#b1']);

    // lastIndexedCommit round-trip.
    ok('getLastIndexedCommit null before set', ov.getLastIndexedCommit(o, '/repo') === null);
    ov.setLastIndexedCommit(o, '/repo', 'abc123');
    ok('getLastIndexedCommit returns the set value', ov.getLastIndexedCommit(o, '/repo') === 'abc123');
    ov.save(TMP_WS, o);
    const reloaded2 = ov.load(TMP_WS);
    ok('lastIndexedCommit round-trips through save/load', ov.getLastIndexedCommit(reloaded2, '/repo') === 'abc123');
    ov.setLastIndexedCommit(o, '/repo', null);
    ok('setLastIndexedCommit(null) clears it', ov.getLastIndexedCommit(o, '/repo') === null);

    fs.rmSync(TMP_WS, { recursive: true, force: true });
  }

  // ================================================================================================
  // routes/overlay.js — DELETE /overlay/code-nodes  &  POST /overlay/code-nodes/replace
  // ================================================================================================
  {
    const overlayRoute = require('../routes/overlay');
    const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-route-'));
    graphStore.forWorkspace(TMP_WS);
    const o = ov.EMPTY();
    // Seed file z.js with 2 symbols.
    ov.upsertCodeNode(o, { name: 'z1', kind: 'function', file: 'z.js', signature: 'z1()', vec: dummyVec(1), vecMeta: { dimensions: DIMS } });
    ov.upsertCodeNode(o, { name: 'z2', kind: 'function', file: 'z.js', signature: 'z2()', vec: dummyVec(2), vecMeta: { dimensions: DIMS } });

    // DELETE by file.
    {
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { file: 'z.js', workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-nodes', 'DELETE', { method: 'DELETE', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('DELETE /overlay/code-nodes returns 200', r && r.status === 200);
      ok('DELETE reports 2 deleted', r && r.body.deleted === 2);
      ok('DELETE actually removed z.js nodes', Object.keys(o.code_nodes).length === 0);
    }
    // DELETE missing file -> 400.
    {
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-nodes', 'DELETE', { method: 'DELETE', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      ok('DELETE without file -> 400', getLastSent().status === 400);
    }

    // REPLACE: file w.js had an OLD symbol; replace with two NEW symbols (old must be gone).
    ov.upsertCodeNode(o, { name: 'oldFn', kind: 'function', file: 'w.js', signature: 'oldFn()', vec: dummyVec(9), vecMeta: { dimensions: DIMS } });
    ok('w.js seeded with oldFn', !!o.code_nodes['code:w.js#oldFn']);
    {
      const newNodes = [
        { name: 'newA', kind: 'function', file: 'w.js', signature: 'newA()' },
        { name: 'newB', kind: 'function', file: 'w.js', signature: 'newB()' },
      ];
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { file: 'w.js', nodes: newNodes, workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-nodes/replace', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('REPLACE returns 200', r && r.status === 200);
      ok('REPLACE reports deleted:1 created:2', r && r.body.deleted === 1 && r.body.created === 2);
      ok('REPLACE removed the OLD symbol', !o.code_nodes['code:w.js#oldFn']);
      ok('REPLACE added both NEW symbols', !!o.code_nodes['code:w.js#newA'] && !!o.code_nodes['code:w.js#newB']);
      ok('REPLACE-created nodes carry a pooled vec (embeds ran)', o.code_nodes['code:w.js#newA'].vec && o.code_nodes['code:w.js#newA'].vec.length === DIMS);
    }
    // REPLACE with empty nodes[] just clears the file.
    {
      ov.upsertCodeNode(o, { name: 'clearMe', kind: 'function', file: 'c.js', signature: 'c()', vec: dummyVec(1), vecMeta: { dimensions: DIMS } });
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { file: 'c.js', nodes: [], workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-nodes/replace', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      const r = getLastSent();
      ok('REPLACE with empty nodes[] clears the file (deleted:1 created:0)', r && r.body.deleted === 1 && r.body.created === 0);
      ok('REPLACE empty actually removed c.js node', !o.code_nodes['code:c.js#clearMe']);
    }
    // REPLACE missing file -> 400.
    {
      const { ctx, getLastSent } = makeCtx(o, TMP_WS, { nodes: [], workspace: TMP_WS });
      await overlayRoute(ctx)('/overlay/code-nodes/replace', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
      ok('REPLACE without file -> 400', getLastSent().status === 400);
    }

    fs.rmSync(TMP_WS, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
