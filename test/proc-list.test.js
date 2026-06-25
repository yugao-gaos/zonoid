#!/usr/bin/env node
'use strict';
/**
 * test/proc-list.test.js
 *
 * Unit tests for lib/proc-list.js and lib/headless-ancestor.js.
 *
 * ALL system calls are MOCKED via injectable execFileSync — no real ps or PowerShell runs.
 * Synthetic POSIX output and synthetic Windows (Get-CimInstance pipe-delimited) output are
 * both exercised so the cross-platform paths are proven without requiring a specific OS.
 *
 * Run: node test/proc-list.test.js
 */

const assert = require('assert');
const os = require('os');

const { _parsePosixOutput, _parseWindowsOutput, listProcs } = require('../lib/proc-list');
const { hasHeadlessDrainAncestor, isHeadlessDrainCommand } = require('../lib/headless-ancestor');

const IS_WINDOWS = os.platform() === 'win32';

// ---- test runner ------------------------------------------------------------
let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.then(() => {
        console.log(`  PASS  ${label}`);
        passed++;
      }).catch((e) => {
        console.error(`  FAIL  ${label}`);
        console.error(`        ${e.message}`);
        failed++;
      });
      return result;
    }
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

// ---- synthetic POSIX ps output ----------------------------------------------
// Matches `ps -eo pid=,ppid=,command=` format: "  <pid>  <ppid>  <command...>"
const POSIX_OUTPUT = [
  '  1001  1000  node /home/user/zonoid/daemon.js',
  '  1002  1001  node /home/user/zonoid/scripts/onboard-learn.js --drain --repo /home/user/proj',
  '  1003  1002  claude -p "edge-judge single-pass headless mode" --output-format stream-json',
  '  1004     0  /usr/lib/systemd/systemd',
  '  1005  1004  bash',
].join('\n') + '\n';

// ---- synthetic Windows Get-CimInstance output (pipe-delimited: pid|ppid|cmdline) ----
const WINDOWS_OUTPUT = [
  '4|0|System',
  '1001|0|"node.exe" C:\\zonoid\\daemon.js',
  '1002|1001|"node.exe" C:\\zonoid\\scripts\\onboard-learn.js --drain --repo C:\\proj',
  '1003|1002|"claude.exe" -p "edge-judge single-pass headless mode" --output-format stream-json',
  '1005|1004|cmd.exe /c echo hello | more',  // command with pipe in cmdline
  '',
].join('\n');

// ---- Helper: make a native-format stub for the current platform -------------
// Returns a stub that returns output in the format the current platform expects,
// feeding the given logical proc list.
function makeNativeStub(procs) {
  if (IS_WINDOWS) {
    // Windows: pipe-delimited pid|ppid|cmdline
    const lines = procs.map((p) => `${p.pid}|${p.ppid}|${p.command}`).join('\n') + '\n';
    return (_bin, _args, _opts) => lines;
  }
  // POSIX: space-separated "  pid  ppid  command..."
  const lines = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n') + '\n';
  return (_bin, _args, _opts) => lines;
}

// ---- _parsePosixOutput tests ------------------------------------------------
console.log('\n--- _parsePosixOutput ---');

test('parsePosixOutput: parses pid, ppid, command correctly', () => {
  const procs = _parsePosixOutput(POSIX_OUTPUT);
  assert.ok(procs.length >= 4, `expected at least 4 rows, got ${procs.length}`);
  const daemon = procs.find((p) => p.pid === 1001);
  assert.ok(daemon, 'should find pid 1001 (daemon)');
  assert.strictEqual(daemon.ppid, 1000);
  assert.ok(daemon.command.includes('daemon.js'), 'command should include daemon.js');
});

test('parsePosixOutput: handles commands with spaces', () => {
  const procs = _parsePosixOutput(POSIX_OUTPUT);
  const drain = procs.find((p) => p.pid === 1003);
  assert.ok(drain, 'should find pid 1003 (drain)');
  assert.ok(drain.command.includes('edge-judge single-pass headless mode'), 'drain command should include skill text');
});

test('parsePosixOutput: skips blank lines', () => {
  const out = '\n  100  50  node server.js\n\n  101  50  bash\n\n';
  const procs = _parsePosixOutput(out);
  assert.strictEqual(procs.length, 2);
});

test('parsePosixOutput: skips malformed lines', () => {
  const out = 'notanumber  999  node foo.js\n  200  notanumber  bash\n';
  const procs = _parsePosixOutput(out);
  assert.strictEqual(procs.length, 0);
});

// ---- _parseWindowsOutput tests ----------------------------------------------
console.log('\n--- _parseWindowsOutput ---');

test('parseWindowsOutput: parses pid, ppid, command correctly', () => {
  const procs = _parseWindowsOutput(WINDOWS_OUTPUT);
  assert.ok(procs.length >= 4, `expected at least 4 rows, got ${procs.length}`);
  const daemon = procs.find((p) => p.pid === 1001);
  assert.ok(daemon, 'should find pid 1001 (daemon)');
  assert.strictEqual(daemon.ppid, 0);
  assert.ok(daemon.command.includes('daemon.js'), 'command should include daemon.js');
});

test('parseWindowsOutput: handles cmdline with embedded pipe characters', () => {
  const procs = _parseWindowsOutput(WINDOWS_OUTPUT);
  const piped = procs.find((p) => p.pid === 1005);
  assert.ok(piped, 'should find pid 1005 (cmd with pipe)');
  // The command (third field) should contain the full cmdline after the second pipe
  assert.ok(piped.command.includes('echo hello | more'), 'pipe in cmdline must be preserved, got: ' + piped.command);
});

test('parseWindowsOutput: skips blank lines', () => {
  const out = '100|50|node.exe server.js\n\n101|50|cmd.exe\n';
  const procs = _parseWindowsOutput(out);
  assert.strictEqual(procs.length, 2);
});

test('parseWindowsOutput: skips lines without two pipe separators', () => {
  const out = 'no pipes here\n100|50|good line\n';
  const procs = _parseWindowsOutput(out);
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(procs[0].pid, 100);
});

test('parseWindowsOutput: skips lines with non-numeric pid/ppid', () => {
  const out = 'abc|50|cmd.exe\n100|xyz|node.exe\n200|50|valid.exe\n';
  const procs = _parseWindowsOutput(out);
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(procs[0].pid, 200);
});

// ---- listProcs injection tests (platform-native format) ---------------------
console.log('\n--- listProcs (injectable execFileSync, native format) ---');

const SAMPLE_PROCS = [
  { pid: 1001, ppid: 1000, command: 'node /home/user/zonoid/daemon.js' },
  { pid: 1002, ppid: 1001, command: 'node /home/user/zonoid/scripts/onboard-learn.js --drain --repo /home/user/proj' },
  { pid: 1003, ppid: 1002, command: 'claude -p "edge-judge single-pass headless mode"' },
  { pid: 1004, ppid: 0, command: '/usr/lib/systemd/systemd' },
  { pid: 1005, ppid: 1004, command: 'bash' },
];

test('listProcs: injected native stub returns parsed procs', () => {
  const procs = listProcs({ execFileSync: makeNativeStub(SAMPLE_PROCS) });
  assert.ok(procs.length >= 4, `expected at least 4 procs, got ${procs.length}`);
  assert.ok(procs.every((p) => typeof p.pid === 'number' && typeof p.ppid === 'number' && typeof p.command === 'string'),
    'all entries must have numeric pid/ppid and string command');
});

test('listProcs: can find daemon.js in injected proc list', () => {
  const procs = listProcs({ execFileSync: makeNativeStub(SAMPLE_PROCS) });
  const ownPid = process.pid;
  const daemonProc = procs.find((p) => /daemon\.js/.test(p.command) && p.pid !== ownPid);
  assert.ok(daemonProc, 'should find daemon.js process via injected proc list');
});

test('listProcs: no daemon.js → find returns undefined', () => {
  const noDaemon = [
    { pid: 1002, ppid: 1001, command: 'node /home/user/zonoid/scripts/onboard-learn.js --drain' },
    { pid: 1003, ppid: 1002, command: 'node server.js' },
  ];
  const procs = listProcs({ execFileSync: makeNativeStub(noDaemon) });
  const ownPid = process.pid;
  const daemonProc = procs.find((p) => /daemon\.js/.test(p.command) && p.pid !== ownPid);
  assert.strictEqual(daemonProc, undefined, 'should return undefined when no daemon.js in proc list');
});

test('listProcs: when execFileSync throws, returns empty array', () => {
  const procs = listProcs({
    execFileSync: () => { throw new Error('ps not found'); },
  });
  assert.deepStrictEqual(procs, []);
});

// ---- isHeadlessDrainCommand tests -------------------------------------------
console.log('\n--- isHeadlessDrainCommand ---');

test('isHeadlessDrainCommand: detects edge-judge single-pass headless mode', () => {
  assert.strictEqual(isHeadlessDrainCommand('edge-judge single-pass headless mode'), true);
});

test('isHeadlessDrainCommand: detects headless mode against the orchestrator daemon', () => {
  assert.strictEqual(isHeadlessDrainCommand('headless mode against the orchestrator daemon'), true);
});

test('isHeadlessDrainCommand: detects onboard-learn.js --drain', () => {
  assert.strictEqual(isHeadlessDrainCommand('/path/to/scripts/onboard-learn.js --drain --repo /x'), true);
});

test('isHeadlessDrainCommand: detects gate-label.js --workspace', () => {
  assert.strictEqual(isHeadlessDrainCommand('gate-label.js --workspace /some/path'), true);
});

test('isHeadlessDrainCommand: does NOT match ordinary node commands', () => {
  assert.strictEqual(isHeadlessDrainCommand('node server.js --port 3000'), false);
  assert.strictEqual(isHeadlessDrainCommand('/usr/bin/node daemon.js'), false);
  assert.strictEqual(isHeadlessDrainCommand(''), false);
  assert.strictEqual(isHeadlessDrainCommand(null), false);
});

// ---- hasHeadlessDrainAncestor tests -----------------------------------------
console.log('\n--- hasHeadlessDrainAncestor (synthetic process tree) ---');

//
// Synthetic process tree:
//   1000 (bash/cmd) → 1001 (daemon.js) → 1002 (onboard-learn.js --drain) → 1003 (ordinary) → 1004 (test)
//
// Walking from 1003: 1003→ordinary; 1002→DRAIN (hit!) → return true

const PROC_TREE = [
  { pid: 1000, ppid: 999, command: 'bash' },
  { pid: 1001, ppid: 1000, command: 'node /home/user/zonoid/daemon.js' },
  { pid: 1002, ppid: 1001, command: 'node /home/user/zonoid/scripts/onboard-learn.js --drain --repo /proj' },
  { pid: 1003, ppid: 1002, command: 'node helper.js' },
  { pid: 1004, ppid: 1003, command: 'node test.js' },
];

test('hasHeadlessDrainAncestor: detects drain in ancestor chain', () => {
  const result = hasHeadlessDrainAncestor({
    ppid: 1003,       // parent of our "test" process
    depth: 8,
    execFileSync: makeNativeStub(PROC_TREE),
  });
  assert.strictEqual(result, true, 'should detect drain ancestor 1002 walking up from 1003');
});

test('hasHeadlessDrainAncestor: returns false when no drain in chain', () => {
  const noDrainTree = [
    { pid: 1000, ppid: 999, command: 'bash' },
    { pid: 1001, ppid: 1000, command: 'node server.js' },
    { pid: 1002, ppid: 1001, command: 'node helper.js' },
  ];
  const result = hasHeadlessDrainAncestor({
    ppid: 1001,
    depth: 8,
    execFileSync: makeNativeStub(noDrainTree),
  });
  assert.strictEqual(result, false, 'should return false when no drain in chain');
});

test('hasHeadlessDrainAncestor: direct parent is drain', () => {
  const result = hasHeadlessDrainAncestor({
    ppid: 1002,       // direct parent is the drain process
    depth: 8,
    execFileSync: makeNativeStub(PROC_TREE),
  });
  assert.strictEqual(result, true, 'should detect drain as direct parent');
});

test('hasHeadlessDrainAncestor: depth limit stops walk before drain', () => {
  // depth=1 means we only check one ancestor (ppid=1003 → ordinary node, not drain)
  const result = hasHeadlessDrainAncestor({
    ppid: 1003,
    depth: 1,
    execFileSync: makeNativeStub(PROC_TREE),
  });
  assert.strictEqual(result, false, 'depth=1 should not reach the drain ancestor at 1002');
});

test('hasHeadlessDrainAncestor: returns false when execFileSync throws', () => {
  const result = hasHeadlessDrainAncestor({
    ppid: 1003,
    depth: 8,
    execFileSync: () => { throw new Error('ps unavailable'); },
  });
  assert.strictEqual(result, false, 'should return false on enumeration error');
});

test('hasHeadlessDrainAncestor: handles edge-judge headless mode in ancestor', () => {
  const edgeJudgeTree = [
    { pid: 1000, ppid: 999, command: 'bash' },
    { pid: 1001, ppid: 1000, command: 'claude -p "You are running edge-judge single-pass headless mode"' },
    { pid: 1002, ppid: 1001, command: 'node child.js' },
  ];
  const result = hasHeadlessDrainAncestor({
    ppid: 1002,
    depth: 8,
    execFileSync: makeNativeStub(edgeJudgeTree),
  });
  assert.strictEqual(result, true, 'should detect edge-judge headless mode in ancestor');
});

test('hasHeadlessDrainAncestor: handles gate-label.js ancestor', () => {
  const gateLabelTree = [
    { pid: 1000, ppid: 999, command: 'bash' },
    { pid: 1001, ppid: 1000, command: 'node /scripts/gate-label.js --workspace /some/path' },
    { pid: 1002, ppid: 1001, command: 'node child.js' },
  ];
  const result = hasHeadlessDrainAncestor({
    ppid: 1002,
    depth: 8,
    execFileSync: makeNativeStub(gateLabelTree),
  });
  assert.strictEqual(result, true, 'should detect gate-label.js --workspace in ancestor');
});

// ---- _parsePosixOutput vs _parseWindowsOutput direct parser tests -----------
// These verify that BOTH platform parsers correctly identify a daemon.js and drain process.
console.log('\n--- Parser correctness: both platforms detect daemon.js and drain ---');

test('POSIX parser: finds daemon.js and drain process', () => {
  const procs = _parsePosixOutput(POSIX_OUTPUT);
  const daemon = procs.find((p) => p.command.includes('daemon.js'));
  const drain = procs.find((p) => isHeadlessDrainCommand(p.command));
  assert.ok(daemon, 'POSIX parser should find daemon.js');
  assert.ok(drain, 'POSIX parser should find drain command');
});

test('Windows parser: finds daemon.js and drain process', () => {
  const procs = _parseWindowsOutput(WINDOWS_OUTPUT);
  const daemon = procs.find((p) => p.command.includes('daemon.js'));
  const drain = procs.find((p) => isHeadlessDrainCommand(p.command));
  assert.ok(daemon, 'Windows parser should find daemon.js');
  assert.ok(drain, 'Windows parser should find drain command');
});

// ---- summary ----------------------------------------------------------------
setImmediate(() => {
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All tests passed.');
  }
});
