#!/usr/bin/env node
// Phase 2a test: the per-workspace overlay cache (overlayFor). The old single-slot cache only
// write-coalesced the daemon-global workspace; every OTHER workspace did a fresh overlayStore.load
// per call. Now EVERY workspace gets a cached, write-coalesced overlay keyed by absolute path.
//
// Proves, in-process (no port binding — daemon is require()d for its test hooks):
//   (1) WRITE-COALESCE per workspace: repeated overlayFor(wsA) returns the SAME in-memory object,
//       so mutations accumulate across calls without re-reading the file (the coalescing property
//       that previously ONLY state.overlay had).
//   (2) NO CROSS-WORKSPACE CLOBBER: overlayFor(wsA) and overlayFor(wsB) are SEPARATE objects;
//       mutating one never leaks into the other (separate Map entries — the whole point).
//   (3) CURRENT-WORKSPACE ALIAS: overlayFor(state.workspace) IS state.overlay (the authoritative
//       in-memory entry — the test hooks set it directly and the cache honors that aliasing).
//   (4) OUT-OF-BAND COHERENCY: an external overlayStore.save(wsA) (mtime bump) is picked up by the
//       next overlayFor(wsA) — same staleness guard the pre-P2a per-call load() had; no NEW
//       staleness class. After the daemon's own save + refreshOverlayStamp, the cached (coalesced)
//       object is RETAINED instead of needlessly reloaded.
//   (7) STALE-HANDLE SAFETY: a pre-reload request that saves after deferred code-edge batches cannot
//       emit false removals or replace the newer cache object; a following load retains every batch.
// Run: node test/overlay-cache.test.js — exits non-zero on any failed assertion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE before requiring overlay/daemon (BASE is read at require-time).
process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-base-')));
const overlayStore = require('../lib/overlay');
const daemon = require('../daemon');
const { overlayFor, refreshOverlayStamp, sweepStaleGuidance, targetOverlay, __setOverlayForTest, __setWorkspaceForTest, __clearOverlayCacheForTest } = daemon;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const WS_CUR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-cur-')));
const WS_A = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-A-')));
const WS_B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-B-')));
const WS_SWEEP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-sweep-')));
const WS_SPAWN = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-spawn-')));
const WS_CLAIM = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-claim-')));
const WS_EDGE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-edge-')));

// Pin a current workspace + its authoritative in-memory overlay (mirrors setWorkspace).
const curOv = overlayStore.EMPTY();
__setWorkspaceForTest(WS_CUR);
__setOverlayForTest(curOv);
__clearOverlayCacheForTest();

async function run() {
try {
  // (3) current-workspace alias: overlayFor(state.workspace) === state.overlay (no second Map copy).
  ok('(3) overlayFor(current ws) IS state.overlay (alias, not a copy)', overlayFor(WS_CUR) === curOv);

  // (1) write-coalesce for a NON-current workspace: same object across calls; mutation persists in mem.
  const a1 = overlayFor(WS_A);
  a1.status['a/1'] = 'in_progress';
  const a2 = overlayFor(WS_A);
  ok('(1) overlayFor(wsA) returns the SAME cached object across calls', a1 === a2);
  ok('(1) mutation on the first handle is visible on the second (write-coalesced)', a2.status['a/1'] === 'in_progress');

  // (2) no cross-workspace clobber: wsB is a distinct object; wsA mutation absent in wsB and vice-versa.
  const b1 = overlayFor(WS_B);
  b1.status['b/1'] = 'done';
  ok('(2) overlayFor(wsA) !== overlayFor(wsB) (separate Map entries)', overlayFor(WS_A) !== overlayFor(WS_B));
  ok('(2) wsA write did NOT leak into wsB', overlayFor(WS_B).status['a/1'] === undefined);
  ok('(2) wsB write did NOT leak into wsA', overlayFor(WS_A).status['b/1'] === undefined);
  ok('(2) neither non-current write leaked into the current overlay', curOv.status['a/1'] === undefined && curOv.status['b/1'] === undefined);

  // Persist both non-current overlays and re-stamp the cache (mirrors targetOverlay.save()).
  overlayStore.save(WS_A, a2); refreshOverlayStamp(WS_A);
  overlayStore.save(WS_B, b1); refreshOverlayStamp(WS_B);
  ok('(4) after daemon save + refreshOverlayStamp, cached coalesced object is RETAINED (not reloaded)', overlayFor(WS_A) === a2);

  // A representative daemon-local sweep saves the cached overlay through the shared helper. The
  // next access must retain identity and must not replay/load the graph it just persisted.
  const sweepOv = overlayFor(WS_SWEEP);
  sweepOv.status['origin/done'] = 'done';
  overlayStore.addGuidance(sweepOv, { question: 'stale?', origin_task: 'origin/done' });
  const originalLoad = overlayStore.load;
  let sweepReloads = 0;
  overlayStore.load = (...args) => { sweepReloads++; return originalLoad(...args); };
  try {
    ok('(4) representative stale-guidance sweep persisted a local mutation', sweepStaleGuidance(WS_SWEEP, sweepOv) === true);
    ok('(4) daemon-local sweep save retains the cached overlay identity', overlayFor(WS_SWEEP) === sweepOv);
    ok('(4) daemon-local sweep save causes zero overlay reloads on next access', sweepReloads === 0);
  } finally {
    overlayStore.load = originalLoad;
  }

  // A routine graph mutation wakes the frontier spawn pump even when headless dispatch is off.
  // Its config gate must read through the same daemon cache instead of replaying the graph, and
  // the executor must retain that authoritative object for the following state request.
  const spawnOv = overlayFor(WS_SPAWN);
  daemon.__setLoopsForTest([['managed-cache-test', {
    id: 'managed-cache-test', active: true, managed: 'graph', session: null, workspace: WS_SPAWN,
  }]]);
  const originalSpawnLoad = overlayStore.load;
  let spawnReloads = 0;
  overlayStore.load = (...args) => { spawnReloads++; return originalSpawnLoad(...args); };
  try {
    const result = await daemon.__createHeadlessSpawnExecutorForTest().runDueDrains({ workspace: WS_SPAWN });
    ok('(5) gated-off frontier wake exits without dispatch', result.skipped === 'headless_driver_off');
    ok('(5) frontier config check causes zero graph overlay reloads', spawnReloads === 0);
    ok('(5) following state access retains the cached overlay identity', overlayFor(WS_SPAWN) === spawnOv);
  } finally {
    overlayStore.load = originalSpawnLoad;
    daemon.__clearLoopsForTest();
  }

  // Every write-gated worker tool call probes /active-claim without a workspace. The route scans
  // registered workspaces to recover the session binding; that scan must stay on the daemon's
  // mtime-coherent cache instead of replaying each workspace graph through overlayStore.load.
  const claimOv = overlayFor(WS_CLAIM);
  claimOv.status['claim/task'] = 'in_progress';
  claimOv.claimSessions['claim/task'] = 'worker-session';
  const sessionRoute = require('../routes/session');
  const replies = [];
  const claimHandler = sessionRoute({
    send: (_res, status, payload) => replies.push({ status, payload }),
    readBody: async () => ({}),
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [{
      id: 'claim/task', label: 'Claim task', status: 'in_progress', session: 'owner-session', agent_id: null,
    }] }),
    state: { agents: {} },
    targetOverlay: () => ({ ws: null, ov: overlayStore.EMPTY() }),
    overlayFor,
    resolveRepo: () => WS_CLAIM,
    now: () => new Date().toISOString(),
    stopSignalFor: () => null,
    agentsArr: () => [],
    loops: new Map(),
    saveLoops: () => {},
    registeredWorkspaces: () => [WS_CLAIM],
    harness: { tasks: { readSessionTasksRaw: () => [] } },
  });
  const originalClaimLoad = overlayStore.load;
  let claimReloads = 0;
  overlayStore.load = (...args) => { claimReloads++; return originalClaimLoad(...args); };
  try {
    const url = new URL('http://localhost/active-claim?session=worker-session');
    await claimHandler('/active-claim', 'GET', {}, {}, url);
    await claimHandler('/active-claim', 'GET', {}, {}, url);
    ok('(6) repeated workspace-less active-claim probes recover the registered session binding',
      replies.length === 2 && replies.every((reply) => reply.status === 200
        && reply.payload.claimed === true
        && reply.payload.claims.some((claim) => claim.key === 'claim/task' && claim.session === 'worker-session')));
    ok('(6) repeated workspace-less active-claim probes cause zero raw overlay reloads', claimReloads === 0);
    ok('(6) active-claim probes retain the daemon-cached overlay identity', overlayFor(WS_CLAIM) === claimOv);
  } finally {
    overlayStore.load = originalClaimLoad;
  }

  // A long-running request can retain the old cached object while an out-of-band local-overlay
  // write invalidates the cache and the next request reloads a new authoritative object. Sequential
  // deferred code-edge batches saved through that new object must not be interpreted as deletions
  // when the older request eventually persists an unrelated mutation.
  const staleTarget = targetOverlay({ workspace: WS_EDGE });
  const externalEdgeOverlay = overlayStore.load(WS_EDGE);
  externalEdgeOverlay.config.external_touch = true;
  overlayStore.save(WS_EDGE, externalEdgeOverlay);
  try {
    const f = overlayStore.fileFor(WS_EDGE);
    const t = new Date(Date.now() + 1000);
    fs.utimesSync(f, t, t);
  } catch { /* best effort */ }

  const edgeReplies = [];
  let edgeNotifyCount = 0;
  let edgeBody = null;
  const edgeRoute = require('../routes/overlay')({
    send(_res, status, payload) { edgeReplies.push({ status, payload }); },
    readBody: async () => edgeBody,
    notifyChange: () => { edgeNotifyCount++; },
    targetOverlay,
    opReplay: () => false,
  });
  const EDGE_FILES = 24;
  for (let index = 0; index < EDGE_FILES; index++) {
    const file = `src/batch-${String(index).padStart(2, '0')}.js`;
    const edges = [{
      from_file: file,
      from: `code:${file}#caller`,
      to: 'code:src/target.js#callee',
      kind: 'calls',
    }];
    const replace = index % 2 === 0;
    edgeBody = {
      workspace: WS_EDGE,
      defer_publish: true,
      edges,
      ...(replace ? { file } : {}),
    };
    const endpoint = replace ? '/overlay/code-edges/replace' : '/overlay/code-edges/bulk';
    await edgeRoute(endpoint, 'POST', {}, {}, new URL(`http://localhost${endpoint}`), null);
  }
  ok('(7) every sequential deferred code-edge replace/bulk write returned success',
    edgeReplies.length === EDGE_FILES && edgeNotifyCount === 0
      && edgeReplies.every((reply) => reply.status === 200 && reply.payload.created === 1));
  const activeEdgeOverlay = overlayFor(WS_EDGE);
  ok('(7) the post-reload cached overlay accumulated every edge batch',
    activeEdgeOverlay !== staleTarget.ov && activeEdgeOverlay.code_edges.length === EDGE_FILES);

  staleTarget.ov.config.stale_request_finished = true;
  staleTarget.save();
  const postStaleOverlay = overlayFor(WS_EDGE);
  const reloadedEdges = postStaleOverlay.code_edges || [];
  ok('(7) a stale pre-reload save invalidates itself and cannot erase persisted edge batches',
    postStaleOverlay !== staleTarget.ov && postStaleOverlay !== activeEdgeOverlay
      && reloadedEdges.length === EDGE_FILES
      && new Set(reloadedEdges.map((edge) => edge.from_file)).size === EDGE_FILES);

  // (4) out-of-band coherency: an EXTERNAL writer mutates wsA's file (fresh object → new mtime).
  // The next overlayFor(wsA) must pick up the external change (reload), exactly as the pre-P2a
  // per-call load() did — no NEW staleness class.
  const external = overlayStore.load(WS_A);
  external.status['a/2'] = 'tested';
  // Some filesystems have coarse mtime resolution; nudge mtime forward so the stamp differs.
  overlayStore.save(WS_A, external);
  try {
    const f = overlayStore.fileFor(WS_A);
    const t = new Date(Date.now() + 1000);
    fs.utimesSync(f, t, t);
  } catch { /* best effort — most FS bump mtime on the rename above already */ }
  const a3 = overlayFor(WS_A);
  ok('(4) out-of-band write to wsA is picked up on next overlayFor (mtime invalidation)', a3.status['a/2'] === 'tested');
  ok('(4) reload replaced the stale cached object', a3 !== a2);
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  for (const d of [process.env.CLAUDE_PLUGIN_DATA, WS_CUR, WS_A, WS_B, WS_SWEEP, WS_SPAWN, WS_CLAIM, WS_EDGE]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('TEST ERROR:', e);
  process.exit(1);
});
