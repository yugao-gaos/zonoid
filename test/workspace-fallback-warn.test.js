#!/usr/bin/env node
// Phase-1 (observe-only) regression test for the daemon-global workspace-fallback warning.
// The MCP client already stamps `workspace` into every request, so state.workspace should now
// only be consulted as a SILENT FALLBACK. Before later phases remove that fallback, the daemon
// emits a STRUCTURED, DEDUPED warning at every seam that still falls through to it — so we can see
// which callers still rely on it. This test asserts the two halves of the contract:
//   (a) the warning FIRES (once per distinct seam) when no explicit workspace is supplied;
//   (b) it is COMPLETELY SILENT on the hot path (an explicit workspace IS supplied).
// ZERO behavior change is expected beyond the stderr line.
//
// Unit-level: require()s daemon.js directly (it only binds ports under require.main === module),
// drives the exported seams in-process, and captures process.stderr.write. No framework; matches
// the style of test/workspace-write-target.test.js / workspace-read-target.test.js.
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

// Capture every line daemon.warnWorkspaceFallback writes to stderr without polluting test output.
const origWrite = process.stderr.write.bind(process.stderr);
let captured = [];
function startCapture() {
  captured = [];
  process.stderr.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (s.includes('orch.workspace-fallback')) { captured.push(s); return true; }
    return origWrite(chunk, ...rest);
  };
}
function stopCapture() { process.stderr.write = origWrite; return captured.slice(); }
const sawSeam = (lines, seam) => lines.some((l) => l.includes(`seam=${seam}`));

(async () => {
  try {
    // Pin a workspace + a minimal overlay so the seams have something coherent to resolve against.
    const ov = overlayStore.load(WS);
    daemon.__setWorkspaceForTest(WS);
    daemon.__setOverlayForTest(ov);

    // --- (a) FALLBACK fires when no explicit workspace is supplied -----------------------------
    daemon.__resetWorkspaceFallbackSeamsForTest();
    startCapture();
    // targetOverlay with neither a body.workspace nor a ?workspace= query → falls through.
    daemon.targetOverlay(null, { searchParams: new URLSearchParams() });
    daemon.targetOverlay({}, null);
    // A sweep invoked with NO ws arg → defaults to state.workspace (the legacy fallback path).
    daemon.sweepFailedTasks();
    let lines = stopCapture();
    ok('targetOverlay fallback warned when workspace omitted', sawSeam(lines, 'targetOverlay'));
    ok('sweepFailedTasks fallback warned when ws omitted', sawSeam(lines, 'sweepFailedTasks'));

    // --- dedupe: the SAME seam warns only ONCE across repeated fallbacks -----------------------
    startCapture();
    daemon.targetOverlay(null, { searchParams: new URLSearchParams() });
    daemon.targetOverlay(null, { searchParams: new URLSearchParams() });
    daemon.targetOverlay(null, { searchParams: new URLSearchParams() });
    lines = stopCapture();
    ok('targetOverlay does NOT re-warn (deduped within the seen set)', !sawSeam(lines, 'targetOverlay'));

    // --- after reset, the seam warns again (proves the dedupe set is the gate, not a one-shot) -
    daemon.__resetWorkspaceFallbackSeamsForTest();
    startCapture();
    daemon.targetOverlay(null, { searchParams: new URLSearchParams() });
    lines = stopCapture();
    ok('targetOverlay re-warns after the seen-set is reset', sawSeam(lines, 'targetOverlay'));

    // --- (b) HOT PATH is completely SILENT when an explicit workspace IS supplied --------------
    daemon.__resetWorkspaceFallbackSeamsForTest();
    startCapture();
    // explicit via body.workspace
    daemon.targetOverlay({ workspace: WS }, null);
    // explicit via ?workspace= query
    const u = { searchParams: new URLSearchParams(`workspace=${encodeURIComponent(WS)}`) };
    daemon.targetOverlay(null, u);
    // sweep invoked WITH an explicit ws (the per-workspace hot path the loop tick uses)
    daemon.sweepFailedTasks(WS, ov);
    lines = stopCapture();
    ok('targetOverlay SILENT when explicit workspace passed (body or query)', !sawSeam(lines, 'targetOverlay'));
    ok('sweepFailedTasks SILENT when explicit ws passed', !sawSeam(lines, 'sweepFailedTasks'));
    ok('no fallback warning at all on the explicit hot path', lines.length === 0);
  } catch (e) {
    console.error('TEST ERROR:', e);
    fail++;
  } finally {
    process.stderr.write = origWrite;
    for (const d of [SANDBOX, WS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
