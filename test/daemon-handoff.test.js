#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureCurrentDaemon } = require('../lib/daemon-handoff');

function daemon(head, pid = 41, ready = true) {
  return {
    reachable: true,
    identified: true,
    ownershipProof: true,
    ready,
    head,
    build: head ? `git:${head}` : null,
    pid,
  };
}

function fakeChild(pid = 42) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    signals: [],
    kill(signal) { this.signals.push(signal); this.signalCode = signal; },
    once() {},
    removeListener() {},
  };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-daemon-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'daemon.pid');
  const lockFile = path.join(dir, 'daemon-handoff.lock');
  fs.writeFileSync(pidFile, '41');
  return { pidFile, lockFile };
}

test('current daemon owner is reused without signaling or spawning', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let signals = 0;
  let spawns = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => daemon('new'),
    pidFile,
    lockFile,
    signalProcess: () => { signals++; },
    spawnDaemon: () => { spawns++; return fakeChild(); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'reused');
  assert.equal(signals, 0);
  assert.equal(spawns, 0);
});

test('stale owned daemon is gracefully replaced after releasing its port', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let state = 'stale';
  let signals = 0;
  let spawns = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => state === 'stale' ? daemon('old')
      : state === 'down' ? { reachable: false, identified: false, ready: false }
        : daemon('new', 42),
    pidFile,
    lockFile,
    isProcessAlive: () => true,
    signalProcess: (pid, signal) => {
      assert.equal(pid, 41);
      assert.equal(signal, 'SIGTERM');
      signals++;
      state = 'down';
    },
    spawnDaemon: () => {
      spawns++;
      state = 'current';
      fs.writeFileSync(pidFile, '42');
      return fakeChild();
    },
    pollMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'replaced');
  assert.equal(signals, 1);
  assert.equal(spawns, 1);
});

test('concurrent contenders serialize; the loser joins the replacement cleanly', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let state = 'stale';
  let initialCalls = 0;
  let releaseInitial;
  const bothProbed = new Promise((resolve) => { releaseInitial = resolve; });
  let signals = 0;
  let spawns = 0;

  const probe = async () => {
    if (initialCalls < 2) {
      initialCalls++;
      if (initialCalls === 2) releaseInitial();
      await bothProbed;
      return daemon('old');
    }
    if (state === 'down') return { reachable: false, identified: false, ready: false };
    return daemon(state === 'stale' ? 'old' : 'new', state === 'stale' ? 41 : 42);
  };
  const options = {
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe,
    pidFile,
    lockFile,
    isProcessAlive: () => true,
    signalProcess: () => { signals++; state = 'down'; },
    spawnDaemon: () => {
      spawns++;
      state = 'current';
      fs.writeFileSync(pidFile, '42');
      return fakeChild();
    },
    pollMs: 2,
    startupTimeoutMs: 500,
  };

  const results = await Promise.all([ensureCurrentDaemon(options), ensureCurrentDaemon(options)]);
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(new Set(results.map((result) => result.action)), new Set(['replaced', 'joined']));
  assert.equal(signals, 1);
  assert.equal(spawns, 1);
});

test('stale daemon that does not stop fails at the bounded handoff timeout', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let signals = 0;
  let spawns = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => daemon('old'),
    pidFile,
    lockFile,
    isProcessAlive: () => true,
    signalProcess: () => { signals++; },
    spawnDaemon: () => { spawns++; return fakeChild(); },
    handoffTimeoutMs: 30,
    startupTimeoutMs: 60,
    pollMs: 2,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_daemon_shutdown_timeout');
  assert.equal(signals, 1);
  assert.equal(spawns, 0);
});

test('unrelated listener is never signaled even when the pid file exists', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let signals = 0;
  let spawns = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => ({ reachable: true, identified: false, ready: false, pid: 41 }),
    pidFile,
    lockFile,
    signalProcess: () => { signals++; },
    spawnDaemon: () => { spawns++; return fakeChild(); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unrelated_listener');
  assert.equal(signals, 0);
  assert.equal(spawns, 0);
});

test('a transient health timeout during cold boot is not classified as an unrelated listener', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let spawned = false;
  let timedOut = false;
  const child = fakeChild();
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => {
      if (!spawned) return { reachable: false, identified: false, ready: false };
      if (!timedOut) {
        timedOut = true;
        return { reachable: true, identified: false, ready: false, timedOut: true };
      }
      return daemon('new', 42);
    },
    pidFile,
    lockFile,
    isProcessAlive: (pid) => pid === 42,
    spawnDaemon: () => {
      spawned = true;
      fs.writeFileSync(pidFile, '42');
      return child;
    },
    pollMs: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'started');
  assert.equal(child.signalCode, null);
});

test('a timed-out pre-existing listener is not trusted or replaced', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let spawns = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => ({ reachable: true, identified: false, ready: false, timedOut: true }),
    pidFile,
    lockFile,
    spawnDaemon: () => { spawns++; return fakeChild(); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unrelated_listener');
  assert.equal(spawns, 0);
});

test('signed stale listener with a PID-file mismatch is not treated as owned', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let signals = 0;
  let spawns = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => daemon('old', 42),
    pidFile,
    lockFile,
    isProcessAlive: () => true,
    signalProcess: () => { signals++; },
    spawnDaemon: () => { spawns++; return fakeChild(); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_daemon_unowned');
  assert.equal(signals, 0);
  assert.equal(spawns, 0);
});

test('self-owned spawned daemon may outlive transient unsigned and timed-out health', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  const child = fakeChild(42);
  let spawned = false;
  let startupProbes = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => {
      if (!spawned) return { reachable: false, identified: false, ready: false };
      startupProbes++;
      if (startupProbes === 1) {
        return { reachable: true, identified: false, ownershipProof: false, ready: false, timedOut: true };
      }
      if (startupProbes === 2) {
        return { reachable: true, identified: true, ownershipProof: false, ready: false, timedOut: true, head: 'new' };
      }
      return daemon('new', 42);
    },
    pidFile,
    lockFile,
    isProcessAlive: (pid) => pid === 42,
    spawnDaemon: () => {
      spawned = true;
      fs.writeFileSync(pidFile, '42');
      return child;
    },
    sleep: async () => {},
    pollMs: 1,
    startupTimeoutMs: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'started');
  assert.equal(result.identity.pid, 42);
  assert.deepEqual(child.signals, []);
  assert.equal(startupProbes, 3);
});

test('spawn ownership follows the child runtime data directory', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-handoff-runtime-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const child = fakeChild(42);
  let spawned = false;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    env: { ...process.env, CLAUDE_PLUGIN_DATA: runtimeDir },
    probe: async () => spawned
      ? daemon('new', 42)
      : { reachable: false, identified: false, ready: false },
    isProcessAlive: (pid) => pid === 42,
    spawnDaemon: () => {
      spawned = true;
      fs.writeFileSync(path.join(runtimeDir, 'daemon.pid'), '42');
      return child;
    },
    sleep: async () => {},
    pollMs: 1,
    startupTimeoutMs: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'started');
  assert.deepEqual(child.signals, []);
});

test('an unreachable spawned child is reaped after startup timeout without a pid file', async (t) => {
  const { lockFile } = fixture(t);
  const child = fakeChild(42);
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => ({ reachable: false, identified: false, ready: false }),
    lockFile,
    spawnDaemon: () => child,
    sleep: async () => {},
    now: (() => { let value = 0; return () => value += 2; })(),
    pollMs: 1,
    startupTimeoutMs: 3,
    childCleanupGraceMs: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'daemon_startup_timeout');
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('unowned listener after spawn fails immediately without signaling the detached child', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  const child = fakeChild(42);
  let spawned = false;
  let startupProbes = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'new', build: 'git:new' },
    probe: async () => {
      if (!spawned) return { reachable: false, identified: false, ready: false };
      startupProbes++;
      return { reachable: true, identified: false, ownershipProof: false, ready: false, timedOut: true };
    },
    pidFile,
    lockFile,
    isProcessAlive: () => true,
    spawnDaemon: () => {
      spawned = true;
      return child;
    },
    sleep: async () => {},
    pollMs: 1,
    startupTimeoutMs: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unrelated_listener_after_spawn');
  assert.equal(startupProbes, 1);
  assert.deepEqual(child.signals, []);
});

test('reuse-only handoff never spawns when the locked daemon disappears', async (t) => {
  const { pidFile, lockFile } = fixture(t);
  let spawns = 0;
  const result = await ensureCurrentDaemon({
    expectedIdentity: { head: 'locked', build: 'git:locked' },
    probe: async () => ({ reachable: false, identified: false, ready: false }),
    pidFile,
    lockFile,
    reuseOnly: true,
    spawnDaemon: () => { spawns++; return fakeChild(); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'current_daemon_reuse_required');
  assert.equal(spawns, 0);
});
