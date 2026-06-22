'use strict';
/**
 * lib/proc-list.js — Cross-platform process enumeration helper.
 *
 * Returns an array of { pid, ppid, command } objects for all running processes.
 *
 * POSIX (macOS / Linux):  uses `ps -eo pid=,ppid=,command=`
 * Win32:                   uses PowerShell Get-CimInstance Win32_Process
 *
 * DO NOT use wmic — it was removed on modern Windows.
 *
 * The execFileSync parameter is INJECTABLE (opts.execFileSync) so unit tests can
 * pass a stub returning synthetic output without requiring a real ps or PowerShell.
 *
 * Usage:
 *   const { listProcs } = require('./proc-list');
 *   const procs = listProcs();          // real system call
 *   const procs = listProcs({ execFileSync: myStub }); // injected for tests
 */

const { execFileSync: defaultExecFileSync } = require('child_process');
const os = require('os');

/**
 * List all running processes.
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFileSync]  Injectable execFileSync for tests.
 * @returns {{ pid: number, ppid: number, command: string }[]}
 */
function listProcs(opts = {}) {
  const execFile = opts.execFileSync || defaultExecFileSync;
  if (os.platform() === 'win32') {
    return listProcsWindows(execFile);
  }
  return listProcsPosix(execFile);
}

// ---------------------------------------------------------------------------
// POSIX (macOS / Linux)
// ---------------------------------------------------------------------------

function listProcsPosix(execFile) {
  let out = '';
  try {
    // -eo pid=,ppid=,command= produces clean numeric columns + full command.
    out = execFile('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return parsePosixOutput(out);
}

/**
 * Parse `ps -eo pid=,ppid=,command=` output.
 * Each line: "  <pid>  <ppid>  <command...>"
 */
function parsePosixOutput(out) {
  const result = [];
  for (const line of String(out).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const command = parts.slice(2).join(' ');
    result.push({ pid, ppid, command });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Windows (PowerShell Get-CimInstance)
// ---------------------------------------------------------------------------

// PowerShell command that outputs a simple delimited format: pid|ppid|cmdline
// Using a custom format avoids JSON quoting issues with arbitrary CommandLine strings.
const WIN_PS_CMD = [
  'Get-CimInstance Win32_Process',
  '| ForEach-Object {',
  '  "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)"',
  '}',
].join(' ');

function listProcsWindows(execFile) {
  let out = '';
  try {
    out = execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      WIN_PS_CMD,
    ], { encoding: 'utf8', timeout: 15000 });
  } catch {
    return [];
  }
  return parseWindowsOutput(out);
}

/**
 * Parse the pipe-delimited PowerShell output: "pid|ppid|cmdline".
 * CommandLine may contain pipes, so we split on the FIRST two `|` only.
 */
function parseWindowsOutput(out) {
  const result = [];
  for (const line of String(out).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split on first two pipe characters only — command may contain pipes
    const firstPipe = trimmed.indexOf('|');
    if (firstPipe === -1) continue;
    const secondPipe = trimmed.indexOf('|', firstPipe + 1);
    if (secondPipe === -1) continue;

    const pid = Number(trimmed.slice(0, firstPipe).trim());
    const ppid = Number(trimmed.slice(firstPipe + 1, secondPipe).trim());
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const command = trimmed.slice(secondPipe + 1); // raw CommandLine
    result.push({ pid, ppid, command });
  }
  return result;
}

module.exports = {
  listProcs,
  // Exported for testing:
  _parsePosixOutput: parsePosixOutput,
  _parseWindowsOutput: parseWindowsOutput,
};
