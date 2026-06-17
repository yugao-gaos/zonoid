#!/usr/bin/env node
// P3 (no-global) regression test: the daemon-global workspace fallback is GONE.
//
// History: Phase 1 added an observe-only STRUCTURED WARNING (orch.workspace-fallback) at every seam
// that still silently fell through to the daemon-global `state.workspace`, so we could see which
// callers relied on it before removing it. Phase 3 REMOVED the global pointer entirely (grep-zero on
// state.workspace/state.overlay/state.graphStore) — so the warn scaffold (and its
// __resetWorkspaceFallbackSeamsForTest hook) is gone too, intentionally superseded by hard
// no-fallback resolution: a seam with no explicit workspace now resolves to a NULL workspace, and
// routes 400 rather than silently defaulting. This test asserts that P3 invariant directly:
//   (a) targetOverlay() with NO explicit workspace resolves to ws=null (no global default);
//   (b) targetOverlay() WITH an explicit workspace (body or ?workspace=) resolves to that ws.
//
// Unit-level: require()s daemon.js directly (it only binds ports under require.main === module) and
// drives the exported targetOverlay seam in-process. No framework; matches the style of
// test/workspace-write-target.test.js / workspace-read-target.test.js.
// Run: node test/workspace-fallback-warn.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE so any overlay/workspace-file reads land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wsfallback-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;

const overlayStore = require('../lib/overlay');
const daemon = require('../daemon');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wsfallback-WS-')));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

(async () => {
  try {
    const ov = overlayStore.load(WS);

    // --- (a) NO global default: omitting the workspace resolves to ws=null ----------------------
    // (No __setWorkspaceForTest pin here — that test alias is honored by overlayFor, but
    // targetOverlay's contract is to read the explicit request workspace ONLY. With none supplied
    // there is nothing to fall back to in P3.)
    const fromNullQuery = daemon.targetOverlay(null, { searchParams: new URLSearchParams() });
    ok('targetOverlay(null, empty-query) resolves to ws=null (no global fallback)', fromNullQuery.ws === null);
    const fromEmptyBody = daemon.targetOverlay({}, null);
    ok('targetOverlay({}, null) resolves to ws=null (no global fallback)', fromEmptyBody.ws === null);

    // The legacy reset hook is GONE — its absence is part of the P3 contract (no warn scaffold).
    ok('__resetWorkspaceFallbackSeamsForTest hook removed (warn scaffold gone)',
      typeof daemon.__resetWorkspaceFallbackSeamsForTest !== 'function');

    // --- (b) explicit workspace resolves to that workspace (body or ?workspace=) ----------------
    const fromBody = daemon.targetOverlay({ workspace: WS }, null);
    ok('targetOverlay resolves explicit body.workspace', fromBody.ws === WS);
    const u = { searchParams: new URLSearchParams(`workspace=${encodeURIComponent(WS)}`) };
    const fromQuery = daemon.targetOverlay(null, u);
    ok('targetOverlay resolves explicit ?workspace= query', fromQuery.ws === WS);

    // The explicit overlay is a real (non-EMPTY) per-workspace overlay object.
    ok('explicit-workspace overlay is a usable object', fromBody.ov && typeof fromBody.ov === 'object' && Array.isArray(fromBody.ov.edges));
    void ov;
  } catch (e) {
    console.error('TEST ERROR:', e);
    fail++;
  } finally {
    for (const d of [SANDBOX, WS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
