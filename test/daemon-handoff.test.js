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

function fakeChild() {
  return {
    exitCode: null,
    signalCode: null,
    kill() { this.signalCode = 'SIGTERM'; },
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
    spawnDaemon: () => { spawns++; state = 'current'; return fakeChild(); },
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
