#!/usr/bin/env node
// Test: arming wakeups never costs one OS process per wakeup.
//   - N arms of the SAME key leave exactly ONE registry row (dedup), and
//   - N arms across DISTINCT keys still leave exactly ONE process (the shared wake host).
// The second invariant is the leak fix: the old design spawned a detached `node -e` sleeper per
// wakeup, so pending-wakeup count == live-process count and 3,893 accumulated on one machine.
// Uses real spawns with short delays.
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

// Collect the host pid reported by N successive arm calls of one session.
function armN(session, n) {
  // Delay large enough that nothing fires mid-test (5s); everything is canceled at the end.
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
    const registryPath = sw.resolveRegistryPath();
    const key = sw.sessionSlug(SESSION);

    // Arm N times for the same session
    const pids = armN(SESSION, N);
    ok(`got ${N} pids`, pids.length === N);

    // All arms share ONE host process — no per-wakeup sleeper is ever spawned.
    const uniquePids = new Set(pids);
    ok('all arms share one host process', uniquePids.size === 1);
    const hostPid = pids[0];
    ok('host is the registered host', sw._readHostPid(registryPath) === hostPid);
    ok('host alive', sw._isPidAlive(hostPid));

    // Registry must contain exactly one entry for our key
    const registry = sw._readRegistry(registryPath);
    const entries = Object.keys(registry);
    ok('registry has exactly 1 entry', entries.length === 1);
    ok('registry key matches session', entries[0] === key);
    ok('entry is hosted (no per-wakeup process)', sw._isHostedEntry(registry[key]) && registry[key].pid === undefined);
    ok('entry carries the fire path', registry[key].fire === sw.fireFile(SESSION));
    ok('entry carries the last payload', registry[key].payload.prompt === `p${N - 1}`);

    // Pid file records the shared host
    const pfContent = fs.readFileSync(sw.pidFile(SESSION), 'utf8').trim();
    ok('pidfile has host pid', parseInt(pfContent, 10) === hostPid);

    // Distinct sessions do NOT add processes — that is the whole point of the host.
    const others = ['dedup-other-a', 'dedup-other-b', 'dedup-other-c'];
    for (const s of others) sw.armWakeup({ session: s, delaySeconds: 5, reason: 'x', prompt: s });
    ok('4 pending wakeups, still one host', sw._readHostPid(registryPath) === hostPid);
    ok('registry has 4 entries', Object.keys(sw._readRegistry(registryPath)).length === 4);
    for (const s of others) sw.cancelWakeup(s);

    // Cancel the remaining wake — the row goes, the shared host survives (it serves other sessions).
    const cancel = sw.cancelWakeup(SESSION);
    ok('cancel ok', cancel.ok && cancel.canceled);
    ok('cancel does not kill the shared host', sw._isPidAlive(hostPid));
    ok('pidfile gone after cancel', !fs.existsSync(sw.pidFile(SESSION)));

    // Registry should be empty
    const registryAfter = sw._readRegistry(registryPath);
    ok('registry empty after cancel', Object.keys(registryAfter).length === 0);

    // ----- sweepOrphanWakeups: undelivered rows are swept on boot -----
    // Arm one more, then backdate fireAt to simulate a row no host ever delivered.
    const staleSession = 'stale-sess';
    const arm = sw.armWakeup({ session: staleSession, delaySeconds: 5, reason: 'leak', prompt: 'x' });
    ok('stale arm ok', arm.ok);
    const rp2 = sw.resolveRegistryPath();
    const reg2 = sw._readRegistry(rp2);
    const staleKey = sw.sessionSlug(staleSession);
    reg2[staleKey].fireAt = Date.now() - 20 * 60 * 1000;
    const tmp = rp2 + '.test.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg2, null, 2));
    fs.renameSync(tmp, rp2);

    const sweepResult = sw.sweepOrphanWakeups();
    ok('sweep reported change', sweepResult.swept === true);
    const regAfterSweep = sw._readRegistry(rp2);
    ok('registry empty after sweep', Object.keys(regAfterSweep).length === 0);
    ok('sweep never kills the shared host', sw._isPidAlive(arm.pid));

    // ----- sweepStaleWakeups re-hosts a pending row whose host died -----
    sw.armWakeup({ session: 'rehost-sess', delaySeconds: 5, reason: 'x', prompt: 'y' });
    const doomed = sw._readHostPid(rp2);
    sw._killPid(doomed);
    for (let i = 0; i < 40 && sw._probePidAlive(doomed); i++) await new Promise((r) => setTimeout(r, 50));
    const rehost = sw.sweepStaleWakeups();
    ok('sweep reports the pending hosted row', rehost.hosted === 1);
    const revived = sw._readHostPid(rp2);
    ok('sweep started a replacement host', revived !== doomed && sw._probePidAlive(revived));
    sw.cancelWakeup('rehost-sess');
    sw._killPid(revived);
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
