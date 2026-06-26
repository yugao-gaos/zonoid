#!/usr/bin/env node
// Tests for the daemon process-reaper sweeps in lib/schedule-wakeup.js:
//   PART 1 — sweepStaleWakeups(): registry reconciliation (always on, safe).
//   PART 2 — sweepOrphanProcesses(): opt-in OS node-process janitor (default OFF).
// Run: node --test test/process-reaper-sweep.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Isolate the registry + data dir into a sandbox so we never touch the real one. schedule-wakeup
// resolves both via runtime-paths (ORCH_DATA wins) and resolveRegistryPath (ORCH_WORKSPACE/.graph).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reaper-data-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reaper-ws-')));
process.env.ORCH_DATA = SANDBOX;
process.env.ORCH_WORKSPACE = WS;

const sw = require('../lib/schedule-wakeup');

// A pid that is essentially guaranteed not to exist (process.kill(pid,0) → ESRCH ⇒ dead).
const DEAD_PID = 2147480000;

function writeRegistry(obj) {
  const p = sw.resolveRegistryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function readRegistry() {
  return sw._readRegistry(sw.resolveRegistryPath());
}

// ---------------- PART 1: sweepStaleWakeups ----------------

test('sweepStaleWakeups: prunes a dead-pid entry (fired+exited)', () => {
  writeRegistry({ s_dead: { pid: DEAD_PID, fireAt: Date.now(), session: 's_dead' } });
  const r = sw.sweepStaleWakeups();
  assert.equal(r.pruned, 1);
  assert.equal(r.killed, 0);
  assert.ok(!('s_dead' in readRegistry()), 'dead entry removed from registry');
});

test('sweepStaleWakeups: kills + prunes an ALIVE but long-overdue sleeper', async () => {
  // Spawn a REAL disposable child sleeper so liveness (isPidAlive) is genuine and killPid can
  // legitimately terminate it — never the test runner. (Using process.pid here would make the
  // real killPid run `taskkill /F /PID <self>` on Windows and kill this process.)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  // Give the OS a beat to register the pid so the liveness probe sees it alive.
  await new Promise((res) => setTimeout(res, 150));
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    const staleFireAt = Date.now() - (60 * 60 * 1000); // 1h ago, far past the 5min grace
    writeRegistry({ s_stuck: { pid: child.pid, fireAt: staleFireAt, session: 's_stuck' } });
    const r = sw.sweepStaleWakeups();
    assert.equal(r.killed, 1, 'one overdue-alive sleeper killed');
    assert.equal(r.pruned, 1, 'and pruned from registry');
    assert.ok(!('s_stuck' in readRegistry()), 'stuck entry removed');
    // The child must actually be gone: poll liveness for up to ~1.5s.
    for (let i = 0; i < 30 && !exited && sw._isPidAlive(child.pid); i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(!sw._isPidAlive(child.pid), 'the stuck child sleeper was actually killed');
  } finally {
    try { sw._killPid(child.pid); } catch (_) {}
  }
});

test('sweepStaleWakeups: leaves a fresh/pending entry untouched', () => {
  // Fresh sleeper: alive pid, fireAt in the FUTURE ⇒ neither dead nor overdue ⇒ left alone.
  writeRegistry({ s_fresh: { pid: process.pid, fireAt: Date.now() + (60 * 1000), session: 's_fresh' } });
  const r = sw.sweepStaleWakeups();
  assert.equal(r.killed, 0);
  assert.equal(r.pruned, 0);
  assert.ok('s_fresh' in readRegistry(), 'fresh entry retained');
  // cleanup
  writeRegistry({});
});

test('sweepStaleWakeups: ORCH_WAKEUP_GRACE_MIN widens the overdue window', () => {
  const prev = process.env.ORCH_WAKEUP_GRACE_MIN;
  process.env.ORCH_WAKEUP_GRACE_MIN = '120'; // 2h grace
  try {
    // 1h-old fireAt is now WITHIN grace ⇒ not overdue ⇒ retained (pid alive).
    writeRegistry({ s_grace: { pid: process.pid, fireAt: Date.now() - (60 * 60 * 1000), session: 's_grace' } });
    const r = sw.sweepStaleWakeups();
    assert.equal(r.killed, 0, 'within widened grace ⇒ not killed');
    assert.ok('s_grace' in readRegistry(), 'retained within widened grace');
  } finally {
    if (prev === undefined) delete process.env.ORCH_WAKEUP_GRACE_MIN;
    else process.env.ORCH_WAKEUP_GRACE_MIN = prev;
    writeRegistry({});
  }
});

// ---------------- PART 2: sweepOrphanProcesses (janitor) ----------------

// A fake process list + kill sink injected via opts so no real processes are enumerated/killed.
function janitorRun({ procs, env }) {
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const killed = [];
  try {
    const r = sw.sweepOrphanProcesses({
      list: () => procs,
      kill: (pid) => killed.push(pid),
    });
    return { r, killed };
  } finally {
    for (const k of Object.keys(env || {})) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const OLD = 99 * 60; // 99 min in seconds — comfortably over the 20min default
const YOUNG = 60;    // 1 min

test('janitor: OFF by default ⇒ pure no-op, kills nothing', () => {
  // No ORCH_PROCESS_JANITOR set. Even with a juicy over-age allowlisted proc, nothing happens.
  const { r, killed } = janitorRun({
    env: {},
    procs: [{ pid: 50001, etimeSec: OLD, cmd: 'node --test test/foo.test.js' }],
  });
  assert.equal(r.enabled, false, 'disabled when flag unset');
  assert.equal(killed.length, 0, 'no kills when disabled');
});

test('janitor: ON ⇒ kills an allowlisted over-age proc', () => {
  const { r, killed } = janitorRun({
    env: { ORCH_PROCESS_JANITOR: '1' },
    procs: [{ pid: 50002, etimeSec: OLD, cmd: 'node --test test/bar.test.js' }],
  });
  assert.equal(r.enabled, true);
  assert.deepEqual(killed, [50002], 'over-age test runner killed');
  assert.equal(r.kills[0].pattern, '--test runner');
});

test('janitor: ON ⇒ kills an over-age `node -e require("./daemon")` blob', () => {
  const { killed } = janitorRun({
    env: { ORCH_PROCESS_JANITOR: '1' },
    procs: [{ pid: 50003, etimeSec: OLD, cmd: `node -e "require('./daemon'); start(0)"` }],
  });
  assert.deepEqual(killed, [50003], 'over-age daemon-eval blob killed');
});

test('janitor: ON ⇒ SKIPS a fresh (under-age) allowlisted proc', () => {
  const { killed } = janitorRun({
    env: { ORCH_PROCESS_JANITOR: '1' },
    procs: [{ pid: 50004, etimeSec: YOUNG, cmd: 'node --test test/baz.test.js' }],
  });
  assert.deepEqual(killed, [], 'young proc spared even though it matches the allowlist');
});

test('janitor: ON ⇒ SKIPS non-matching commands (services / user programs)', () => {
  const { killed } = janitorRun({
    env: { ORCH_PROCESS_JANITOR: '1' },
    procs: [
      { pid: 50005, etimeSec: OLD, cmd: 'node server.js --port 3000' },        // a service
      { pid: 50006, etimeSec: OLD, cmd: 'node mcp-graph.js' },                  // mcp-graph
      { pid: 50007, etimeSec: OLD, cmd: 'node /usr/local/bin/some-tool build' },// user program
      { pid: 50008, etimeSec: OLD, cmd: 'node daemon.js' },                     // plain daemon (no test port)
    ],
  });
  assert.deepEqual(killed, [], 'no non-allowlisted command is ever killed');
});

test('janitor: ON ⇒ NEVER kills the daemon pid or the embed/rerank sidecar pids', () => {
  // Plant sidecar pidfiles in the sandbox data dir, then offer those exact pids as over-age
  // allowlisted procs. They must be excluded by the protected-pid set regardless.
  const SIDE_EMBED = 50009;
  const SIDE_RERANK = 50010;
  fs.writeFileSync(path.join(SANDBOX, 'embed.pid'), String(SIDE_EMBED));
  fs.writeFileSync(path.join(SANDBOX, 'rerank.pid'), String(SIDE_RERANK));
  // Sanity: the protected set really did pick up the planted sidecar pids + this process.
  const prot = sw._protectedPids();
  assert.ok(prot.has(process.pid), 'daemon pid protected');
  assert.ok(prot.has(SIDE_EMBED), 'embed sidecar pid protected');
  assert.ok(prot.has(SIDE_RERANK), 'rerank sidecar pid protected');

  const { killed } = janitorRun({
    env: { ORCH_PROCESS_JANITOR: '1' },
    procs: [
      // Even disguised with an allowlisted-looking command + over age, protected pids survive.
      { pid: process.pid, etimeSec: OLD, cmd: 'node --test test/self.test.js' },
      { pid: SIDE_EMBED, etimeSec: OLD, cmd: 'node --test test/embed.test.js' },
      { pid: SIDE_RERANK, etimeSec: OLD, cmd: `node -e "require('./daemon')"` },
      // A genuinely-killable one mixed in, to prove the sweep still works around the exclusions.
      { pid: 50011, etimeSec: OLD, cmd: 'node --test test/real.test.js' },
    ],
  });
  assert.deepEqual(killed, [50011], 'only the unprotected allowlisted over-age proc is killed');
});

test('janitor: allowlist matcher classifies commands correctly', () => {
  const m = sw._matchesEphemeralAllowlist;
  assert.equal(m('node --test test/x.test.js'), '--test runner');
  assert.equal(m('node.exe --test=test/x.test.js'), '--test runner');
  assert.equal(m(`node -e "require('./daemon')"`), "node -e require('./daemon') blob");
  assert.equal(m('node daemon.js ORCH_TEST_PORT=9921'), 'test-port daemon');
  // Negatives — must return null (never a candidate):
  assert.equal(m('node server.js'), null);
  assert.equal(m('node mcp-graph.js'), null);
  assert.equal(m('node daemon.js'), null, 'plain daemon (no test port) is NOT a candidate');
  assert.equal(m(`node -e "console.log(1)"`), null, 'arbitrary -e blob without daemon require is spared');
  assert.equal(m(''), null);
  assert.equal(m(undefined), null);
});
