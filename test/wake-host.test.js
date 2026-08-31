#!/usr/bin/env node
// lib/wake-host.js — the single process that delivers every pending wakeup in a registry.
// Covers what the per-wakeup sleeper used to do (fire the line, drop the row) plus the two
// properties that make it a leak fix: one process for many wakeups, and it exits when idle.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wake-host-')));
const prevData = process.env.ORCH_DATA;
const prevWs = process.env.ORCH_WORKSPACE;
const prevTick = process.env.ORCH_WAKE_HOST_TICK_MS;
const prevIdle = process.env.ORCH_WAKE_HOST_IDLE_MS;
process.env.ORCH_DATA = SANDBOX;
process.env.ORCH_WORKSPACE = SANDBOX;
// Tight timings so the test stays fast; the host reads both from its inherited env.
process.env.ORCH_WAKE_HOST_TICK_MS = '50';
process.env.ORCH_WAKE_HOST_IDLE_MS = '400';

const sw = require('../lib/schedule-wakeup');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

function fireLines(session) {
  try {
    return fs.readFileSync(sw.fireFile(session), 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

(async () => {
  try {
    const registryPath = sw.resolveRegistryPath();

    // ---- delivery: many sessions, ONE host ----
    const sessions = ['host-a', 'host-b', 'host-c'];
    for (const s of sessions) {
      sw.armWakeup({ session: s, delaySeconds: 0, reason: 'now', prompt: `wake-${s}` });
    }
    const hostPid = sw._readHostPid(registryPath);
    ok('one host serves every armed session', typeof hostPid === 'number' && hostPid > 0);

    ok('every session got its fire line', await waitFor(() => sessions.every((s) => fireLines(s).length === 1)));
    for (const s of sessions) {
      const line = fireLines(s)[0] || '';
      const payload = JSON.parse(line.replace(/^ORCH_SCHEDULED_TASK /, '') || '{}');
      ok(`${s} payload round-trips`, payload.prompt === `wake-${s}` && payload.reason === 'now');
    }
    ok('fired rows are dropped from the registry',
      await waitFor(() => Object.keys(sw._readRegistry(registryPath)).length === 0));
    ok('still the same single host', sw._readHostPid(registryPath) === hostPid);

    // ---- a future wakeup is not fired early ----
    sw.armWakeup({ session: 'host-later', delaySeconds: 30, reason: 'later', prompt: 'not yet' });
    await sleep(250);
    ok('pending wakeup is not fired early', fireLines('host-later').length === 0);
    ok('pending row is retained', sw._isHostedEntry(sw._readRegistry(registryPath)[sw.sessionSlug('host-later')]));
    sw.cancelWakeup('host-later');
    await sleep(150);
    ok('canceled wakeup never fires', fireLines('host-later').length === 0);

    // ---- idle exit: an empty registry must not keep a process alive ----
    ok('host exits once the registry stays empty', await waitFor(() => !sw._probePidAlive(hostPid)));
    ok('host releases its pidfile on exit', sw._readHostPid(registryPath) === null);

    // ---- arming again after the host exited starts a fresh one ----
    const again = sw.armWakeup({ session: 'host-d', delaySeconds: 0, reason: 'again', prompt: 'revived' });
    ok('re-arm after idle exit starts a new host', again.ok && again.pid !== hostPid);
    ok('revived host delivers', await waitFor(() => fireLines('host-d').length === 1));

    // ---- legacy per-wakeup sleeper rows are left strictly alone ----
    const legacyKey = 'legacy_row';
    const reg = sw._readRegistry(registryPath);
    reg[legacyKey] = { pid: 2147480000, fireAt: Date.now(), session: legacyKey };
    sw._writeRegistry(registryPath, reg);
    await sleep(200);
    ok('host ignores rows it does not own', legacyKey in sw._readRegistry(registryPath));
    ok('legacy row is not hosted', !sw._isHostedEntry(sw._readRegistry(registryPath)[legacyKey]));
    // The registry sweep still reaps it by pid (dead pid ⇒ pruned).
    sw.sweepStaleWakeups();
    ok('registry sweep still prunes legacy rows', !(legacyKey in sw._readRegistry(registryPath)));

    await waitFor(() => !sw._probePidAlive(again.pid));
    ok('second host exits when idle too', !sw._probePidAlive(again.pid));
  } finally {
    for (const [k, v] of [
      ['ORCH_DATA', prevData], ['ORCH_WORKSPACE', prevWs],
      ['ORCH_WAKE_HOST_TICK_MS', prevTick], ['ORCH_WAKE_HOST_IDLE_MS', prevIdle],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
