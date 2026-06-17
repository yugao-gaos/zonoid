'use strict';
/**
 * gc-stale-spawns.test.js — unit tests for scripts/gc-stale-spawns.js
 *
 * Tests classify() and the exported predicate helpers against a MOCK process list.
 * No real processes are spawned or killed.
 * Run: node test/gc-stale-spawns.test.js
 */

const assert = require('assert');
const {
  classify,
  _isScheduledSleeper,
  _isHeadlessDrain,
  _isDaemon,
  _extractDelaySeconds,
} = require('../scripts/gc-stale-spawns');

// ---- helpers ----------------------------------------------------------------
let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

// ---- mock data --------------------------------------------------------------
const nowMs = Date.now();
const oneHourAgo = nowMs - 3_600_000;
const twentyFiveHoursAgo = nowMs - 25 * 3_600_000;
const threeHoursAgo = nowMs - 3 * 3_600_000;

// Default opts matching the script defaults
const defaultOpts = {
  maxLifetimeHours: 24,
  drainLifetimeHours: 2,
  graceSeconds: 300,
};

// A scheduled sleeper cmdline (mirroring lib/schedule-wakeup.js spawn signature).
const sleeperCmdline60 = [
  'node',
  '-e',
  '"const fs = require(\\"fs\\");const p = JSON.parse(process.argv[1]);const fire = process.argv[2];',
  'setTimeout(() => { fs.appendFileSync(fire, \\"ORCH_SCHEDULED_TASK \\" + JSON.stringify(p) + \\"\\\\n\\"); }, 60000);"',
  '{"delaySeconds":60,"reason":"heartbeat","prompt":"resume"}',
  '/home/user/.claude/orchestrator/wake/abc123.fire',
].join(' ');

const sleeperCmdlineNoDelay = [
  'node -e "ORCH_SCHEDULED_TASK ..."',
  '{"noDelay":true}',
  '/tmp/wake/x.fire',
].join(' ');

const drainCmdline = 'claude -p "Invoke skill: self-learn-edge-judge ..." --output-format json';
const daemonCmdline = '/usr/local/bin/node /home/user/zonoid/daemon.js';
const ordinaryNodeCmdline = 'node server.js --port 3000';

// ---- predicate tests --------------------------------------------------------
console.log('\n--- Predicate helpers ---');

test('isScheduledSleeper: matches ORCH_SCHEDULED_TASK in cmdline', () => {
  assert.strictEqual(_isScheduledSleeper(sleeperCmdline60), true);
  assert.strictEqual(_isScheduledSleeper(sleeperCmdlineNoDelay), true);
});

test('isScheduledSleeper: does NOT match ordinary node cmdlines', () => {
  assert.strictEqual(_isScheduledSleeper(ordinaryNodeCmdline), false);
  assert.strictEqual(_isScheduledSleeper(daemonCmdline), false);
  assert.strictEqual(_isScheduledSleeper(drainCmdline), false);
});

test('isHeadlessDrain: matches claude -p with self-learn', () => {
  assert.strictEqual(_isHeadlessDrain(drainCmdline), true);
});

test('isHeadlessDrain: does NOT match daemon or ordinary node', () => {
  assert.strictEqual(_isHeadlessDrain(daemonCmdline), false);
  assert.strictEqual(_isHeadlessDrain(ordinaryNodeCmdline), false);
  assert.strictEqual(_isHeadlessDrain(sleeperCmdline60), false);
});

test('isDaemon: matches daemon.js', () => {
  assert.strictEqual(_isDaemon(daemonCmdline), true);
  assert.strictEqual(_isDaemon('node /var/app/daemon.js'), true);
  assert.strictEqual(_isDaemon('node C:\\zonoid\\daemon.js'), true);
});

test('isDaemon: does NOT match non-daemon cmdlines', () => {
  assert.strictEqual(_isDaemon(sleeperCmdline60), false);
  assert.strictEqual(_isDaemon(drainCmdline), false);
  assert.strictEqual(_isDaemon(ordinaryNodeCmdline), false);
  assert.strictEqual(_isDaemon('node daemon-helper.js'), false);
});

test('extractDelaySeconds: parses delaySeconds from JSON payload', () => {
  assert.strictEqual(_extractDelaySeconds(sleeperCmdline60), 60);
});

test('extractDelaySeconds: returns null when no JSON', () => {
  assert.strictEqual(_extractDelaySeconds(ordinaryNodeCmdline), null);
  assert.strictEqual(_extractDelaySeconds(sleeperCmdlineNoDelay), null);
});

// ---- classify() tests -------------------------------------------------------
console.log('\n--- classify() ---');

// Helper to make a fake process record
function proc(pid, cmdline, startEpochMs = nowMs) {
  return { pid, name: 'node', cmdline, startEpochMs };
}

test('classify: daemon.js → kind=skip, never stale', () => {
  const cls = classify(proc(999, daemonCmdline, twentyFiveHoursAgo), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'skip');
  assert.strictEqual(cls.stale, false);
  assert.ok(cls.reason.includes('daemon.js'));
});

test('classify: ordinary node process → kind=skip', () => {
  const cls = classify(proc(100, ordinaryNodeCmdline, twentyFiveHoursAgo), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'skip');
  assert.strictEqual(cls.stale, false);
});

test('classify: fresh scheduled sleeper (declared 60s + grace not yet elapsed) → NOT stale', () => {
  // Started 1 hour ago, delay=60s, grace=300s → expired ~1h ago — wait that's stale.
  // Let's use a very recent start (10 seconds ago), delay=3600s → not yet expired.
  const tenSecondsAgo = nowMs - 10_000;
  const recentSleeper = sleeperCmdline60.replace('"delaySeconds":60', '"delaySeconds":3600');
  const cls = classify(proc(101, recentSleeper, tenSecondsAgo), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'scheduled-sleeper');
  assert.strictEqual(cls.stale, false);
});

test('classify: stale scheduled sleeper (started 25h ago, max 24h) → stale', () => {
  // Use a cmdline with no parseable delay → falls back to maxLifetimeHours=24h
  const cls = classify(proc(102, sleeperCmdlineNoDelay, twentyFiveHoursAgo), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'scheduled-sleeper');
  assert.strictEqual(cls.stale, true);
});

test('classify: stale scheduled sleeper with declared delay (60s + grace=300s, started 1h ago) → stale', () => {
  // declared=60s, grace=300s → expires at start+360s.  Started 1h ago → stale.
  const cls = classify(proc(103, sleeperCmdline60, oneHourAgo), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'scheduled-sleeper');
  assert.strictEqual(cls.stale, true);
  assert.ok(cls.reason.includes('60'));
});

test('classify: fresh headless drain (started 1h ago, max 2h) → NOT stale', () => {
  const cls = classify(proc(104, drainCmdline, oneHourAgo), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'headless-drain');
  assert.strictEqual(cls.stale, false);
});

test('classify: stale headless drain (started 3h ago, max 2h) → stale', () => {
  const cls = classify(proc(105, drainCmdline, threeHoursAgo), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'headless-drain');
  assert.strictEqual(cls.stale, true);
});

test('classify: scheduled sleeper with unknown start time (0) → NOT stale (conservative)', () => {
  const cls = classify(proc(106, sleeperCmdline60, 0), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'scheduled-sleeper');
  assert.strictEqual(cls.stale, false, 'unknown start time must never mark stale');
});

test('classify: headless drain with unknown start time (0) → NOT stale (conservative)', () => {
  const cls = classify(proc(107, drainCmdline, 0), defaultOpts, nowMs);
  assert.strictEqual(cls.kind, 'headless-drain');
  assert.strictEqual(cls.stale, false, 'unknown start time must never mark stale');
});

// ---- selection set: only ORCH + stale, never daemon -------------------------
console.log('\n--- Selection-set correctness ---');

test('only stale orch candidates are selected; daemon and ordinary are excluded', () => {
  const mockProcs = [
    { pid: 1, name: 'node', cmdline: daemonCmdline, startEpochMs: twentyFiveHoursAgo },           // daemon — SKIP
    { pid: 2, name: 'node', cmdline: ordinaryNodeCmdline, startEpochMs: twentyFiveHoursAgo },     // ordinary — SKIP
    { pid: 3, name: 'node', cmdline: sleeperCmdline60, startEpochMs: oneHourAgo },                // stale sleeper
    { pid: 4, name: 'node', cmdline: sleeperCmdlineNoDelay, startEpochMs: twentyFiveHoursAgo },   // stale (max 24h)
    { pid: 5, name: 'node', cmdline: drainCmdline, startEpochMs: threeHoursAgo },                 // stale drain
    { pid: 6, name: 'node', cmdline: drainCmdline, startEpochMs: oneHourAgo },                    // fresh drain — NOT stale
  ];

  const results = mockProcs.map((p) => ({ pid: p.pid, cls: classify(p, defaultOpts, nowMs) }));

  // daemon → skip
  assert.strictEqual(results[0].cls.kind, 'skip', `pid 1 (daemon) must be skipped`);
  // ordinary → skip
  assert.strictEqual(results[1].cls.kind, 'skip', `pid 2 (ordinary) must be skipped`);
  // stale sleeper (60s + 300s grace, started 1h ago) → stale
  assert.strictEqual(results[2].cls.kind, 'scheduled-sleeper');
  assert.strictEqual(results[2].cls.stale, true, `pid 3 (stale sleeper) must be stale`);
  // stale sleeper (no delay, max 24h, started 25h ago) → stale
  assert.strictEqual(results[3].cls.kind, 'scheduled-sleeper');
  assert.strictEqual(results[3].cls.stale, true, `pid 4 (stale sleeper no-delay) must be stale`);
  // stale drain (3h > 2h max) → stale
  assert.strictEqual(results[4].cls.kind, 'headless-drain');
  assert.strictEqual(results[4].cls.stale, true, `pid 5 (stale drain) must be stale`);
  // fresh drain (1h < 2h max) → NOT stale
  assert.strictEqual(results[5].cls.kind, 'headless-drain');
  assert.strictEqual(results[5].cls.stale, false, `pid 6 (fresh drain) must NOT be stale`);

  // Collect what would be killed = kind != skip && stale
  const wouldKill = results.filter((r) => r.cls.kind !== 'skip' && r.cls.stale).map((r) => r.pid);
  assert.deepStrictEqual(wouldKill.sort((a, b) => a - b), [3, 4, 5], 'exactly pids 3,4,5 should be selected');

  // Daemon is NEVER in the kill set
  assert.ok(!wouldKill.includes(1), 'daemon.js pid must never be selected');
});

// ---- report -----------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
}
