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
// Run: node test/overlay-cache.test.js — exits non-zero on any failed assertion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE before requiring overlay/daemon (BASE is read at require-time).
process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-base-')));
const overlayStore = require('../lib/overlay');
const daemon = require('../daemon');
const { overlayFor, refreshOverlayStamp, __setOverlayForTest, __setWorkspaceForTest, __clearOverlayCacheForTest } = daemon;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const WS_CUR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-cur-')));
const WS_A = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-A-')));
const WS_B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ovcache-B-')));

// Pin a current workspace + its authoritative in-memory overlay (mirrors setWorkspace).
const curOv = overlayStore.EMPTY();
__setWorkspaceForTest(WS_CUR);
__setOverlayForTest(curOv);
__clearOverlayCacheForTest();

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
  for (const d of [process.env.CLAUDE_PLUGIN_DATA, WS_CUR, WS_A, WS_B]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
