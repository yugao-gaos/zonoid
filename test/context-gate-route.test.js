#!/usr/bin/env node
// Route-level test for GATED retrieval — GET /search?gated=1 (daemon.js) wiring the context-need
// gate (lib/context-gate.js) into the live consult path. End-to-end over HTTP: spawns the real
// daemon on a private port with a sandboxed CLAUDE_PLUGIN_DATA (matches the style of
// test/workspace-write-target.test.js). Run: node test/context-gate-route.test.js
//
// Covers:
//   - gated query on a NON-project-local topic (tls-local heldout spec) → decision:'abstain',
//     results EMPTY (no notes leak through an abstain).
//   - gated query matching a project-local winner note (locale-sum heldout spec; winner
//     note-mq7ydrv353p — same fixture as test/context-gate-regression.test.js) →
//     decision:'inject' with THAT note in /search result shape.
//   - per-request ?workspace= targeting (notes live in a sandbox workspace, not the daemon's).
//   - ungated /search unchanged (back-compat: results array, no decision field).
//
// SLOW + environment-dependent like the regression suite: requires the REAL embedded note_nodes
// from the live cloude overlay AND the cached MiniLM weights (the daemon's FIRST gated call
// lazy-loads the model — can take 10–90s). If either is missing the suite SKIPS (exit 0, loud
// warning) — gate thresholds are calibrated for the semantic path only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const LIVE_WS = '__WORKSPACE__';
const SPECS = path.join(REPO, 'bench', 'heldout', 'specs');
const REAL_BASE = path.join(os.homedir(), '.claude', 'orchestrator');

function skip(why) {
  console.log(`SKIP  context-gate route suite: ${why}`);
  console.log('      (needs the live embedded KB + cached MiniLM weights — semantic path only)');
  process.exit(0);
}

// --- read the LIVE overlay's embedded note_nodes (fixture source) BEFORE sandboxing ---
// Mirror lib/overlay.js fileFor() (content-hash filename) without requiring the module twice.
function liveOverlayFile(ws) {
  const h = crypto.createHash('sha1').update(String(ws)).digest('hex').slice(0, 16);
  const base = (path.basename(ws) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(REAL_BASE, 'overlay', `${base}-${h}.json`);
}
let liveNotes = {};
try { liveNotes = JSON.parse(fs.readFileSync(liveOverlayFile(LIVE_WS), 'utf8')).note_nodes || {}; }
catch { /* skip below */ }
const embedded = Object.keys(liveNotes).filter((k) => Array.isArray(liveNotes[k].vec));
if (embedded.length === 0) skip(`no embedded note nodes in live overlay for ${LIVE_WS}`);
if (!liveNotes['note-mq7ydrv353p']) skip('winner fixture note-mq7ydrv353p missing from live overlay');
if (!fs.existsSync(path.join(REAL_BASE, 'models'))) skip('no cached MiniLM weights (~/.claude/orchestrator/models)');

// --- sandbox: own CLAUDE_PLUGIN_DATA, model cache symlinked, live notes copied into a temp WS ---
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-route-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
fs.symlinkSync(path.join(REAL_BASE, 'models'), path.join(SANDBOX, 'models'));
const overlayStore = require('../lib/overlay');   // BASE read at require-time → sandbox
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-route-ws-')));
{
  const ov = overlayStore.load(WS);
  ov.note_nodes = liveNotes;                       // full live KB → same candidate field as regression
  overlayStore.save(WS, ov);
}

const PORT = 18980 + Math.floor(Math.random() * 200);
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Query text = spec title + body (same task text the regression suite feeds gateTask).
function specQuery(name) {
  const spec = fs.readFileSync(path.join(SPECS, name + '.md'), 'utf8');
  const label = (spec.match(/^#\s*(.+)$/m) || [, name])[1];
  return `${label} ${spec}`;
}
const gatedPath = (name) => `/search?gated=1&workspace=${encodeURIComponent(WS)}&q=${encodeURIComponent(specQuery(name))}`;

(async () => {
  const daemon = spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    if (!(await waitForPing())) { console.log('FAIL  daemon did not come up'); process.exit(1); }

    // --- 1. gated + non-project-local topic → abstain, NO notes (first call lazy-loads MiniLM) ---
    const ab = await get(gatedPath('tls-local'));
    ok('abstain: HTTP 200', ab.status === 200);
    ok('abstain: decision=abstain', ab.body.decision === 'abstain');
    ok('abstain: gated flag echoed', ab.body.gated === true);
    ok('abstain: NO notes returned', Array.isArray(ab.body.results) && ab.body.results.length === 0);
    ok('abstain: carries a reason', typeof ab.body.reason === 'string' && ab.body.reason.length > 0);
    if (ab.body.via && ab.body.via !== 'semantic') skip(`scored via=${ab.body.via} — model unavailable in daemon`);

    // --- 2. gated + project-local winner (locale-sum → note-mq7ydrv353p) → inject WITH the note ---
    const inj = await get(gatedPath('locale-sum'));
    ok('inject: decision=inject', inj.body.decision === 'inject');
    ok('inject: exactly one note returned', Array.isArray(inj.body.results) && inj.body.results.length === 1);
    const top = (inj.body.results || [])[0] || {};
    ok('inject: the winner note (note-mq7ydrv353p)', String(top.key || '').includes('mq7ydrv353p'));
    ok('inject: /search result shape (key/title/summary/score/kind)', top.kind === 'note' && typeof top.title === 'string' && typeof top.summary === 'string' && typeof top.score === 'number');
    ok('inject: gate metadata present', typeof inj.body.top1 === 'number' && typeof inj.body.gap === 'number' && typeof inj.body.locality === 'number' && typeof inj.body.margin === 'number');
    ok('inject: semantic path', inj.body.via === 'semantic');

    // --- 3. back-compat: ungated /search unchanged (no decision field, plain results) ---
    const un = await get(`/search?workspace=${encodeURIComponent(WS)}&q=${encodeURIComponent('locale decimal sum parsing')}&k=3`);
    ok('ungated: HTTP 200', un.status === 200);
    ok('ungated: no decision field', un.body.decision === undefined);
    ok('ungated: results returned', Array.isArray(un.body.results) && un.body.results.length > 0);
  } finally {
    daemon.kill('SIGKILL');
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
