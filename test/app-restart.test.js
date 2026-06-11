#!/usr/bin/env node
// Integration test for Claude app restart resilience (Task #18).
//
// Pain point: when the Claude app restarts, the daemon stays up but agents from the previous
// session are still registered as state:'running' with lastSeen >= daemon bootMs. vouchedLive()
// returns true for them (they pinged since this daemon boot), so claims stay locked for the full
// stale_minutes window (default 10min) — even though those agents are dead.
//
// Fix: POST /sweep with force:true bypasses vouchedLive entirely and only applies the
// lastChanged window check. Safe for restart recovery: active agents ping within seconds.
//
// Covers:
//   (A) Stale window: claim stays locked while agent is "recently seen"
//   (B) POST /sweep with force:true: immediately releases stale claims
//   (C) New agent can claim the released task without waiting
//   (D) Active agent protection: force sweep does NOT release a recently-changed claim
//
// Run: node test/app-restart.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const overlayStore = require('../lib/overlay.js');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-apprestart-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;

try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback fine */ }

const PORT = 18820 + Math.floor(Math.random() * 100);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-apprestart-ws-')));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Read in_progress keys via overlayStore.load — the daemon's own rehydration path. Since the
// overlay-split refactor, per-task status lives in the workspace graph-store (WS/.graph), not the
// overlay JSON (which now persists only LOCAL_FIELDS). load() replays the graph-store events, so
// it surfaces overlay-only claims AND honors the release event the sweep now emits (a swept claim
// becomes 'ready', not 'in_progress'). This is exactly what a restarted daemon would read back.
function overlayInProgress() {
  try {
    const ov = overlayStore.load(WS);
    return Object.entries(ov.status || {}).filter(([, v]) => v === 'in_progress').map(([k]) => k);
  } catch { return []; }
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    ok('daemon came up', await waitForPing());
    await req('POST', '/workspace', { path: WS });

    // -----------------------------------------------------------------------
    // (A) Stale window — claim stays locked while agent looks "recently seen"
    // -----------------------------------------------------------------------
    // Set stale_minutes to 0.1 (6s) so the test does not take 10min.
    await req('POST', '/config', { workspace: WS, stale_minutes: 0.1 });

    // Register "prev-agent" simulating an agent from the pre-restart session
    await req('POST', '/agent/start', {
      agent_id: 'prev-agent', state: 'running', workspace: WS, session: 'prev-session',
    });
    // Claim test/1 via overlay status (no native task backing file needed for sweep testing)
    const claim1 = await req('POST', '/overlay/status', {
      workspace: WS, key: 'test/1', status: 'in_progress', agent_id: 'prev-agent',
    });
    ok('(A) claim accepted (200)', claim1.status === 200 && claim1.body.ok === true);
    ok('(A) test/1 is in_progress in overlay', overlayInProgress().includes('test/1'));

    // Immediate force sweep — claim is fresh (<6s), should NOT be released
    const sweepImm = await req('POST', '/sweep', { workspace: WS, force: true, stale_minutes: 0.1 });
    ok('(A) immediate force sweep releases 0 (claim fresh)', sweepImm.body.released === 0);
    ok('(A) test/1 still in_progress after immediate sweep', overlayInProgress().includes('test/1'));

    // -----------------------------------------------------------------------
    // (B) POST /sweep with force:true after stale window — releases the claim
    // -----------------------------------------------------------------------
    // Wait past the stale window (0.1min = 6s), then force-sweep.
    await sleep(7000);

    const sweepForce = await req('POST', '/sweep', { workspace: WS, force: true, stale_minutes: 0.1 });
    ok('(B) POST /sweep force:true returns ok', sweepForce.status === 200 && sweepForce.body.ok === true);
    ok('(B) force sweep released 1 stale claim', sweepForce.body.released === 1);
    ok('(B) test/1 no longer in_progress after force sweep', !overlayInProgress().includes('test/1'));

    // -----------------------------------------------------------------------
    // (C) New agent can claim the released task immediately
    // -----------------------------------------------------------------------
    await req('POST', '/agent/start', {
      agent_id: 'new-agent', state: 'running', workspace: WS, session: 'new-session',
    });
    const reClaim = await req('POST', '/overlay/status', {
      workspace: WS, key: 'test/1', status: 'in_progress', agent_id: 'new-agent',
    });
    ok('(C) new agent re-claim accepted (200)', reClaim.status === 200 && reClaim.body.ok === true);
    ok('(C) test/1 in_progress under new agent', overlayInProgress().includes('test/1'));

    // -----------------------------------------------------------------------
    // (D) Active agent protection — force sweep does NOT release a claim whose
    //     lastChanged is within the stale window
    // -----------------------------------------------------------------------
    const sweepActive = await req('POST', '/sweep', { workspace: WS, force: true, stale_minutes: 0.1 });
    ok('(D) force sweep with 0.1min window returns ok', sweepActive.status === 200);
    ok('(D) active claim NOT released (lastChanged within window)', sweepActive.body.released === 0);
    ok('(D) test/1 stays in_progress (active claim intact)', overlayInProgress().includes('test/1'));

    // Bonus: /version still alive
    const ver = await req('GET', '/version');
    ok('version endpoint still live', ver.status === 200 && ver.body.bootedAt);

  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
