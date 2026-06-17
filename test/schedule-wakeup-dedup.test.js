#!/usr/bin/env node
// Test: scheduling the SAME key N times leaves exactly ONE live sleeper (not N).
// Uses tiny delays (real ms) and real spawns — avoids 24h sleepers entirely.
// Verifies the dedup via registry + process liveness checks.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const sw = require('../lib/schedule-wakeup');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// ---- helpers ----

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Collect all pids from N successive arm calls, returning the array of pids.
function armN(session, n, sandbox) {
  // Use large-enough delay so the sleepers don't fire during the test (5 seconds).
  // We'll cancel them all at the end.
  const pids = [];
  for (let i = 0; i < n; i++) {
    const res = sw.armWakeup({ session, delaySeconds: 5, reason: `step-${i}`, prompt: `p${i}` });
    ok(`arm ${i} ok`, res.ok && typeof res.pid === 'number');
    pids.push(res.pid);
  }
  return pids;
}

(async () => {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dedup-'));
  const prevData = process.env.ORCH_DATA;
  const prevWorkspace = process.env.ORCH_WORKSPACE;
  process.env.ORCH_DATA = SANDBOX;
  // Put registry in sandbox too
  process.env.ORCH_WORKSPACE = SANDBOX;

  try {
    const SESSION = 'dedup-test-sess';
    const N = 5;

    // Arm N times for the same session
    const pids = armN(SESSION, N, SANDBOX);
    ok(`got ${N} pids`, pids.length === N);

    // All pids should be distinct (each arm call created a new child)
    const uniquePids = new Set(pids);
    ok('all pids distinct', uniquePids.size === N);

    // Only the LAST pid should be alive; all prior ones must have been killed (dedup)
    const lastPid = pids[N - 1];
    const priorPids = pids.slice(0, N - 1);

    ok('last pid alive', sw._isPidAlive(lastPid));
    for (let i = 0; i < priorPids.length; i++) {
      ok(`prior pid ${i} killed`, !sw._isPidAlive(priorPids[i]));
    }

    // Registry must contain exactly one entry for our key
    const registryPath = sw.resolveRegistryPath();
    const registry = sw._readRegistry(registryPath);
    const key = sw.sessionSlug(SESSION);
    const entries = Object.keys(registry);
    ok('registry has exactly 1 entry', entries.length === 1);
    ok('registry key matches session', entries[0] === key);
    ok('registry pid matches last pid', registry[key] && registry[key].pid === lastPid);

    // Pid file should reflect the last spawn
    const pfContent = fs.readFileSync(sw.pidFile(SESSION), 'utf8').trim();
    ok('pidfile has last pid', parseInt(pfContent, 10) === lastPid);

    // Cancel the remaining sleeper — should succeed
    const cancel = sw.cancelWakeup(SESSION);
    ok('cancel ok', cancel.ok && cancel.canceled);
    ok('last pid now dead', !sw._isPidAlive(lastPid));
    ok('pidfile gone after cancel', !fs.existsSync(sw.pidFile(SESSION)));

    // Registry should be empty
    const registryAfter = sw._readRegistry(registryPath);
    ok('registry empty after cancel', Object.keys(registryAfter).length === 0);

    // ----- sweepOrphanWakeups: stale pids are swept on boot -----
    // Arm one more, then manually set a fireAt in the past to simulate a leaker
    const staleSession = 'stale-sess';
    const arm = sw.armWakeup({ session: staleSession, delaySeconds: 5, reason: 'leak', prompt: 'x' });
    ok('stale arm ok', arm.ok);
    // Corrupt the registry entry to look stale (fireAt 20 min ago)
    const rp2 = sw.resolveRegistryPath();
    const reg2 = sw._readRegistry(rp2);
    const staleKey = sw.sessionSlug(staleSession);
    reg2[staleKey].fireAt = Date.now() - 20 * 60 * 1000;
    const tmp = rp2 + '.test.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg2, null, 2));
    fs.renameSync(tmp, rp2);

    const stalePid = arm.pid;
    ok('stale pid alive before sweep', sw._isPidAlive(stalePid));

    const sweepResult = sw.sweepOrphanWakeups();
    ok('sweep reported change', sweepResult.swept === true);
    ok('stale pid killed by sweep', !sw._isPidAlive(stalePid));
    const regAfterSweep = sw._readRegistry(rp2);
    ok('registry empty after sweep', Object.keys(regAfterSweep).length === 0);

  } finally {
    if (prevData === undefined) delete process.env.ORCH_DATA;
    else process.env.ORCH_DATA = prevData;
    if (prevWorkspace === undefined) delete process.env.ORCH_WORKSPACE;
    else process.env.ORCH_WORKSPACE = prevWorkspace;
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
