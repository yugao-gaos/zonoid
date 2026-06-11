'use strict';
// HELD-OUT grader for overlay-save (diagnostics field — durable persistence).
//
// The spec says: add setDiagnostics / getDiagnostics wired into the overlay lifecycle such that
// diagnostics survive even when the overlay config JSON is wiped.
//
// Discriminating test: after setDiagnostics + save(), DELETE the overlay JSON file, then call
// load() + getDiagnostics(). Implementations that stored data only in the JSON (the natural/naive
// approach) return null and FAIL. Implementations that routed through the durable event log
// (graph-store JSONL) return the value and PASS.
//
// The KB note (only visible to ON arm) explains this routing requirement. OFF arm never sees it
// and naturally uses the JSON path — so it fails the durability tests.
//
// argv[2] = frozenArtifact  (agent's modified lib/overlay.js, copied to frozen dir)
// argv[3] = worktree root
//
// Prints JSON: { ok, cases, pass, total, edgePass, edgeTotal }
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const frozenArtifact = process.argv[2];
const worktree       = process.argv[3];

if (!frozenArtifact || !fs.existsSync(frozenArtifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + frozenArtifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}

const overlayPath = (worktree && fs.existsSync(path.join(worktree, 'lib', 'overlay.js')))
  ? path.join(worktree, 'lib', 'overlay.js')
  : frozenArtifact;

// Temp data dir so grader doesn't pollute real state.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-grader-'));
process.env.CLAUDE_PLUGIN_DATA = tmpDir;
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

// Fresh require with cleared cache.
function freshRequire(p) {
  Object.keys(require.cache).forEach(k => { delete require.cache[k]; });
  return require(path.resolve(p));
}

let overlay = null, loadErr = null;
try { overlay = freshRequire(overlayPath); } catch (e) { loadErr = e.message; }

const DIAG1 = { lastError: 'timeout', errorCount: 3, lastChecked: '2026-01-01T00:00:00.000Z' };
const DIAG2 = { lastError: null, errorCount: 0, lastChecked: '2026-06-11T12:00:00.000Z' };

let wsIdx = 0;
const WS_BASE = path.join(tmpDir, 'ws');
function ws() { const p = WS_BASE + wsIdx++; fs.mkdirSync(p, { recursive: true }); return p; }

// Resolve calling convention: some agents use setDiagnostics(wsId, val),
// others overlay-object style setDiagnostics(obj, wsId, val). Try both.
function apiSet(ov, wsId, val) {
  try { ov.setDiagnostics(wsId, val); return; } catch {}
  const obj = ov.load(wsId); ov.setDiagnostics(obj, wsId, val); ov.save(wsId, obj);
}
function apiGet(ov, wsId) {
  try { return ov.getDiagnostics(wsId); } catch {}
  const obj = ov.load(wsId); return ov.getDiagnostics(obj, wsId);
}

// Recursively wipe all .json files under dir (overlay.js stores in CLAUDE_PLUGIN_DATA/overlay/).
function wipeJsonDir(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (f.endsWith('.json')) { try { fs.unlinkSync(full); } catch {} }
      else { try { if (fs.statSync(full).isDirectory()) wipeJsonDir(full); } catch {} }
    }
  } catch {}
}

// Set diagnostics, save, wipe overlay JSON, then load fresh and retrieve.
// Key discriminator: JSON-backed impls return null after wipe; graph-store-backed impls survive.
function setWipeLoad(wsId, val) {
  apiSet(overlay, wsId, val);
  wipeJsonDir(tmpDir);
  // Fresh require + load.
  const ov2 = freshRequire(overlayPath);
  return apiGet(ov2, wsId);
}

const cases = [];
function check(name, edge, fn) {
  let pass = false, err = null, detail = null;
  if (loadErr) { err = loadErr; }
  else if (typeof overlay.setDiagnostics !== 'function' || typeof overlay.getDiagnostics !== 'function') {
    err = 'setDiagnostics / getDiagnostics not exported';
  } else {
    try { ({ pass, detail } = fn()); } catch (e) { err = e.message; }
  }
  cases.push({ name, edge, pass, err, detail });
}

// ── non-edge: basic API surface ──────────────────────────────────────────────

check('getDiagnostics returns null when unset', false, () => {
  const w = ws();
  const got = apiGet(overlay, w);
  return { pass: got === null, detail: got };
});

check('setDiagnostics / getDiagnostics in-memory round-trip', false, () => {
  const w = ws();
  apiSet(overlay, w, DIAG1);
  const got = apiGet(overlay, w);
  const pass = got !== null && got.lastError === DIAG1.lastError
    && got.errorCount === DIAG1.errorCount && got.lastChecked === DIAG1.lastChecked;
  return { pass, detail: got };
});

check('diagnostics are per-workspace independent', false, () => {
  const w1 = ws(), w2 = ws();
  apiSet(overlay, w1, DIAG1);
  const got = apiGet(overlay, w2);
  return { pass: got === null, detail: got };
});

// ── edge: durability — survives overlay JSON wipe ────────────────────────────

check('diagnostics survives overlay JSON wipe (graph-store durability)', true, () => {
  const w = ws();
  const got = setWipeLoad(w, DIAG1);
  const pass = got !== null && got.lastError === DIAG1.lastError
    && got.errorCount === DIAG1.errorCount && got.lastChecked === DIAG1.lastChecked;
  return { pass, detail: got };
});

check('overwrite survives overlay JSON wipe', true, () => {
  const w = ws();
  apiSet(overlay, w, DIAG1);
  const got = setWipeLoad(w, DIAG2);
  const pass = got !== null && got.lastError === null
    && got.errorCount === 0 && got.lastChecked === DIAG2.lastChecked;
  return { pass, detail: got };
});

check('null diagnostics survives overlay JSON wipe', true, () => {
  const w = ws();
  apiSet(overlay, w, DIAG1);
  const got = setWipeLoad(w, null);
  return { pass: got === null, detail: got };
});

// ── report ───────────────────────────────────────────────────────────────────

const pass     = cases.filter(c => c.pass).length;
const edgeCases = cases.filter(c => c.edge);
const edgePass  = edgeCases.filter(c => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length,
  edgePass, edgeTotal: edgeCases.length,
}));
