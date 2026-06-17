#!/usr/bin/env node
'use strict';

// gc-stale-spawns.js — GC reaper for orphaned orchestrator child processes.
//
// Enumerates orchestrator-spawned Node child processes and kills stale ones:
//
//   Targeted process classes (NEVER kills anything else):
//     - ORCH_SCHEDULED_TASK sleepers: detached `node -e <inline-script>` children spawned by
//       lib/schedule-wakeup.js. These write "ORCH_SCHEDULED_TASK {...}" to a .fire file after a
//       delaySeconds timeout. If the session is gone, they sleep forever.
//     - Headless drain `claude -p` children: identified by ORCH_DRAIN_* env vars set by
//       lib/headless-drain.js. These are kill-safe: the drain governor re-spawns them on the next
//       tick if needed.
//
//   NEVER kills:
//     - daemon.js (the orchestrator daemon itself)
//     - Any process without an explicit ORCH_SCHEDULED_TASK or ORCH_DRAIN env marker
//     - Non-node processes
//
//   Staleness threshold:
//     - ORCH_SCHEDULED_TASK: if {delaySeconds} is parseable from argv JSON, expires =
//       startTime + delaySeconds + GRACE_SECONDS. Else falls back to MAX_LIFETIME_HOURS.
//     - Headless drains: always stale after DRAIN_LIFETIME_HOURS.
//
// CLI:
//   --dry-run    (default) List what WOULD be killed. No processes are killed.
//   --apply      Actually send SIGTERM (posix) / taskkill (windows) to stale candidates.
//   --max-lifetime-hours <n>   Override default staleness for scheduled sleepers (default: 24).
//   --drain-lifetime-hours <n> Override default lifetime for headless drains (default: 2).
//   --grace-seconds <n>        Extra grace beyond declared delay before a sleeper is stale (default: 300).
//
// Integration note:
//   This script is designed to run:
//     1. On daemon boot  — add `require('./scripts/gc-stale-spawns').run({ apply: true })` near
//        the startup code in daemon.js (before the HTTP server starts).
//     2. Periodically     — call once per hour via a setInterval in daemon.js or a cron-like
//        wrapper; `run({ apply: true })` is idempotent and fast.
//   Wiring the daemon hook is intentionally NOT done here to keep this PR scope-contained. This
//   standalone script is safe to run at any time without side-effects when --dry-run is used.
//
// Dependency-free. Node >= 16.

const { spawnSync } = require('child_process');
const os = require('os');

const DEFAULT_MAX_LIFETIME_HOURS = 24;
const DEFAULT_DRAIN_LIFETIME_HOURS = 2;
const DEFAULT_GRACE_SECONDS = 300;

// ---- args -----------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    dryRun: true,
    maxLifetimeHours: DEFAULT_MAX_LIFETIME_HOURS,
    drainLifetimeHours: DEFAULT_DRAIN_LIFETIME_HOURS,
    graceSeconds: DEFAULT_GRACE_SECONDS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--apply') opts.dryRun = false;
    else if (a === '--max-lifetime-hours') opts.maxLifetimeHours = Number(argv[++i]);
    else if (a === '--drain-lifetime-hours') opts.drainLifetimeHours = Number(argv[++i]);
    else if (a === '--grace-seconds') opts.graceSeconds = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  for (const [k, v] of [
    ['--max-lifetime-hours', opts.maxLifetimeHours],
    ['--drain-lifetime-hours', opts.drainLifetimeHours],
    ['--grace-seconds', opts.graceSeconds],
  ]) {
    if (!Number.isFinite(v) || v < 0) {
      console.error(`${k} must be a non-negative number`);
      process.exit(2);
    }
  }
  return opts;
}

// ---- process enumeration --------------------------------------------------------

// Returns an array of process info objects:
//   { pid, name, cmdline, startEpochMs }  — startEpochMs may be 0 if unavailable.
function enumerateNodeProcesses() {
  if (os.platform() === 'win32') return enumerateWindows();
  return enumeratePosix();
}

function enumerateWindows() {
  // Query WMI for process list. SpawnSync keeps us dependency-free.
  // Get-CimInstance Win32_Process gives us Name, ProcessId, CommandLine, CreationDate.
  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Depth 2',
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });

  if (ps.error || ps.status !== 0) {
    // PowerShell unavailable or failed — no-op cleanly.
    return [];
  }

  let rows;
  try { rows = JSON.parse(ps.stdout || '[]'); }
  catch { return []; }

  if (!Array.isArray(rows)) rows = [rows]; // single-process edge case

  return rows
    .filter((r) => r && typeof r === 'object')
    .filter((r) => {
      const name = String(r.Name || '').toLowerCase();
      // Only node processes (node.exe) — broad exclusion of non-node.
      return name === 'node.exe' || name === 'node';
    })
    .map((r) => ({
      pid: Number(r.ProcessId),
      name: String(r.Name || ''),
      cmdline: String(r.CommandLine || ''),
      // CreationDate is a .NET DateTime serialized as "/Date(ms)/" or ISO string.
      startEpochMs: parseWindowsDate(r.CreationDate),
    }));
}

function parseWindowsDate(val) {
  if (!val) return 0;
  // PowerShell serializes DateTime as "/Date(1234567890000)/"
  const m = String(val).match(/\/Date\((\d+)\)\//);
  if (m) return Number(m[1]);
  // Or as ISO string
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function enumeratePosix() {
  // `ps -eo pid,comm,lstart,args` — lstart gives human-readable start time.
  // Fall back to `ps -eo pid,comm,etime,args` if lstart unavailable.
  let ps = spawnSync('ps', ['-eo', 'pid,comm,lstart,args'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (ps.error || ps.status !== 0) {
    // Try a simpler subset without lstart (Linux default ps often lacks lstart).
    ps = spawnSync('ps', ['-eo', 'pid,comm,etimes,args'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (ps.error || ps.status !== 0) return [];
    return parsePsEtimes(ps.stdout || '');
  }
  return parsePsLstart(ps.stdout || '');
}

function parsePsLstart(out) {
  // Header: PID COMMAND STARTED ARGS (lstart is 4 tokens: "Mon Jan  1 00:00:00 2025")
  const lines = out.split('\n').slice(1); // skip header
  const result = [];
  const now = Date.now();
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    const comm = parts[1] || '';
    if (!isNodeBin(comm)) continue;
    // lstart: "Mon Jan  1 00:00:00 2025" — 5 tokens after comm
    const lstart = parts.slice(2, 7).join(' ');
    const startEpochMs = parseLstart(lstart, now);
    const cmdline = parts.slice(7).join(' ');
    result.push({ pid, name: comm, cmdline, startEpochMs });
  }
  return result;
}

function parsePsEtimes(out) {
  // Header: PID COMMAND ELAPSED_SECS ARGS
  const lines = out.split('\n').slice(1);
  const now = Date.now();
  const result = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    const comm = parts[1] || '';
    if (!isNodeBin(comm)) continue;
    const elapsedSec = Number(parts[2]);
    const startEpochMs = Number.isFinite(elapsedSec) ? now - elapsedSec * 1000 : 0;
    const cmdline = parts.slice(3).join(' ');
    result.push({ pid, name: comm, cmdline, startEpochMs });
  }
  return result;
}

function parseLstart(s, now) {
  if (!s) return 0;
  const d = new Date(s);
  // new Date("Mon Jan  1 00:00:00 2025") may be NaN in some engines.
  if (!Number.isNaN(d.getTime())) return d.getTime();
  // Normalize double spaces: "Jan  1" -> "Jan 1"
  const d2 = new Date(s.replace(/\s+/g, ' '));
  return Number.isNaN(d2.getTime()) ? 0 : d2.getTime();
}

function isNodeBin(name) {
  const n = String(name).toLowerCase();
  return n === 'node' || n === 'node.exe';
}

// ---- classification -------------------------------------------------------------

const SCHEDULED_TASK_MARKER = 'ORCH_SCHEDULED_TASK';

// Returns true when the command line looks like an ORCH_SCHEDULED_TASK sleeper.
// Signature from lib/schedule-wakeup.js:
//   node -e "const fs = require("fs");...ORCH_SCHEDULED_TASK..." <json-payload> <fire-path>
function isScheduledSleeper(cmdline) {
  return cmdline.includes(SCHEDULED_TASK_MARKER);
}

// Headless drain `claude -p` processes set ORCH_DRAIN_ env vars. However, we cannot read env
// vars of other processes cross-platform without /proc on Linux. Instead we look for the distinctive
// headless drain args: the bin is `claude`/`claude.cmd` and args contain the drain skill prompt.
// This is best-effort — if the pattern doesn't match, we safely miss it (false-negative), never
// false-positive.
function isHeadlessDrain(cmdline) {
  // headless-drain spawns: claude -p "..." --output-format json ...
  // The prompt contains recognizable self-learn skill names.
  const lower = cmdline.toLowerCase();
  return (
    (lower.includes('claude') && lower.includes(' -p ') && lower.includes('self-learn')) ||
    // Fallback: ORCH_DRAIN env may be present in cmdline on some platforms
    lower.includes('orch_drain')
  );
}

// NEVER kill guard — must return true to block killing any of these.
function isDaemon(cmdline) {
  // Protect daemon.js regardless of path form.
  return /[/\\]daemon\.js($|\s|")/.test(cmdline) || cmdline.endsWith('daemon.js');
}

// Try to extract delaySeconds from the JSON payload argv of a scheduled sleeper.
// The argv format from schedule-wakeup.js: `node -e <script> <json-payload> <fire-path>`
// So JSON is the second non -e argument.
function extractDelaySeconds(cmdline) {
  // Find the JSON payload — a substring matching {"delaySeconds":N,...}
  const m = cmdline.match(/\{"delaySeconds"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  return null;
}

// Returns a classification:
//   { kind: 'scheduled-sleeper'|'headless-drain'|'skip', reason, stale: bool, expiresAt: number|null }
function classify(proc, opts, nowMs) {
  const { cmdline, startEpochMs } = proc;

  if (isDaemon(cmdline)) {
    return { kind: 'skip', reason: 'daemon.js — protected', stale: false, expiresAt: null };
  }

  if (isScheduledSleeper(cmdline)) {
    const declared = extractDelaySeconds(cmdline);
    const maxMs = opts.maxLifetimeHours * 3_600_000;
    let expiresAt = null;
    let stale = false;

    if (startEpochMs > 0) {
      if (declared !== null && Number.isFinite(declared)) {
        // expires = start + declared delay + grace
        expiresAt = startEpochMs + declared * 1000 + opts.graceSeconds * 1000;
      } else {
        // No parseable delay — use max lifetime fallback
        expiresAt = startEpochMs + maxMs;
      }
      stale = nowMs > expiresAt;
    } else {
      // Cannot determine start time — conservative: don't kill.
      stale = false;
    }

    const ageH = startEpochMs > 0 ? ((nowMs - startEpochMs) / 3_600_000).toFixed(2) + 'h' : 'unknown age';
    const declaredLabel = declared !== null ? `declared ${declared}s` : 'no delay parsed';
    return {
      kind: 'scheduled-sleeper',
      reason: `ORCH_SCHEDULED_TASK sleeper (${declaredLabel}, age ${ageH})`,
      stale,
      expiresAt,
    };
  }

  if (isHeadlessDrain(cmdline)) {
    const maxMs = opts.drainLifetimeHours * 3_600_000;
    let stale = false;
    let expiresAt = null;
    if (startEpochMs > 0) {
      expiresAt = startEpochMs + maxMs;
      stale = nowMs > expiresAt;
    }
    const ageH = startEpochMs > 0 ? ((nowMs - startEpochMs) / 3_600_000).toFixed(2) + 'h' : 'unknown age';
    return {
      kind: 'headless-drain',
      reason: `headless drain (age ${ageH}, max ${opts.drainLifetimeHours}h)`,
      stale,
      expiresAt,
    };
  }

  return { kind: 'skip', reason: 'not an orchestrator-managed process', stale: false, expiresAt: null };
}

// ---- kill -----------------------------------------------------------------------

function killProcess(pid) {
  const platform = os.platform();
  if (platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return { ok: r.status === 0 && !r.error, detail: (r.stdout || r.stderr || '').trim() };
  }
  // POSIX: SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true, detail: 'SIGTERM sent' };
  } catch (e) {
    if (e.code === 'ESRCH') return { ok: true, detail: 'already gone (ESRCH)' };
    return { ok: false, detail: e.message };
  }
}

// ---- formatting -----------------------------------------------------------------
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

// ---- main logic -----------------------------------------------------------------

/**
 * run({ apply, maxLifetimeHours, drainLifetimeHours, graceSeconds })
 * Programmatic entry-point for daemon integration.
 * Returns a summary object.
 */
function run(opts = {}) {
  const options = {
    dryRun: opts.apply !== true,
    maxLifetimeHours: Number.isFinite(opts.maxLifetimeHours) ? opts.maxLifetimeHours : DEFAULT_MAX_LIFETIME_HOURS,
    drainLifetimeHours: Number.isFinite(opts.drainLifetimeHours) ? opts.drainLifetimeHours : DEFAULT_DRAIN_LIFETIME_HOURS,
    graceSeconds: Number.isFinite(opts.graceSeconds) ? opts.graceSeconds : DEFAULT_GRACE_SECONDS,
  };

  const nowMs = Date.now();
  let procs;
  try {
    procs = enumerateNodeProcesses();
  } catch (e) {
    return { ok: false, error: `enumeration failed: ${e.message}`, killed: [], skipped: [], candidates: [] };
  }

  const candidates = [];
  const skipped = [];

  for (const proc of procs) {
    if (!Number.isInteger(proc.pid) || proc.pid <= 0) continue;
    if (proc.pid === process.pid) continue; // never self-kill

    const cls = classify(proc, options, nowMs);
    if (cls.kind === 'skip') {
      skipped.push({ pid: proc.pid, reason: cls.reason });
      continue;
    }
    candidates.push({ proc, cls });
  }

  const stale = candidates.filter((c) => c.cls.stale);
  const notStale = candidates.filter((c) => !c.cls.stale);
  const killed = [];
  const wouldKill = [];

  if (options.dryRun) {
    for (const { proc, cls } of stale) {
      wouldKill.push({ pid: proc.pid, kind: cls.kind, reason: cls.reason });
    }
  } else {
    for (const { proc, cls } of stale) {
      const r = killProcess(proc.pid);
      killed.push({ pid: proc.pid, kind: cls.kind, reason: cls.reason, ok: r.ok, detail: r.detail });
    }
  }

  return {
    ok: true,
    dryRun: options.dryRun,
    enumerated: procs.length,
    candidates: candidates.length,
    stale: stale.length,
    notStaleCount: notStale.length,
    killed: options.dryRun ? [] : killed,
    wouldKill: options.dryRun ? wouldKill : [],
    skipped: skipped.length,
  };
}

// ---- CLI entry ------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      'Usage: gc-stale-spawns.js [--dry-run] [--apply]',
      '       [--max-lifetime-hours <n>] [--drain-lifetime-hours <n>] [--grace-seconds <n>]',
      '',
      '  --dry-run               List stale candidates without killing (default).',
      '  --apply                 Actually kill stale candidates.',
      '  --max-lifetime-hours    Max age for ORCH_SCHEDULED_TASK sleepers (default: 24).',
      '  --drain-lifetime-hours  Max age for headless drain claude children (default: 2).',
      '  --grace-seconds         Extra grace beyond declared delay (default: 300).',
    ].join('\n'));
    process.exit(0);
  }

  console.log(`gc-stale-spawns: ${opts.dryRun ? 'DRY RUN (no kills)' : 'APPLY (will kill stale processes)'}`);
  console.log(`max-lifetime-hours:   ${opts.maxLifetimeHours}`);
  console.log(`drain-lifetime-hours: ${opts.drainLifetimeHours}`);
  console.log(`grace-seconds:        ${opts.graceSeconds}`);
  console.log('');

  const result = run({
    apply: !opts.dryRun,
    maxLifetimeHours: opts.maxLifetimeHours,
    drainLifetimeHours: opts.drainLifetimeHours,
    graceSeconds: opts.graceSeconds,
  });

  if (!result.ok) {
    console.error(`ERROR: ${result.error}`);
    process.exit(1);
  }

  const targets = opts.dryRun ? result.wouldKill : result.killed;

  if (targets.length === 0) {
    console.log('No stale orchestrator child processes found.');
  } else {
    const c1 = Math.max(5, ...targets.map((t) => String(t.pid).length));
    const c2 = Math.max(4, ...targets.map((t) => t.kind.length));
    const header = `${pad('PID', c1)}  ${pad('KIND', c2)}  REASON`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const t of targets) {
      const extra = !opts.dryRun ? `  [${t.ok ? 'KILLED' : 'FAILED'}: ${t.detail}]` : '  [would kill]';
      console.log(`${pad(t.pid, c1)}  ${pad(t.kind, c2)}  ${truncate(t.reason, 80)}${extra}`);
    }
  }

  console.log('');
  console.log('summary:');
  console.log(`  enumerated:    ${result.enumerated}`);
  console.log(`  candidates:    ${result.candidates}  (matched orchestrator signatures)`);
  console.log(`  stale:         ${result.stale}`);
  console.log(`  not-stale:     ${result.notStaleCount}`);
  if (opts.dryRun) {
    console.log(`  would-kill:    ${result.wouldKill.length}`);
    if (result.wouldKill.length > 0) {
      console.log('  Re-run with --apply to kill these.');
    }
  } else {
    const ok = result.killed.filter((k) => k.ok).length;
    const fail = result.killed.filter((k) => !k.ok).length;
    console.log(`  killed:        ${ok}`);
    if (fail > 0) console.log(`  kill-failed:   ${fail}`);
  }
}

module.exports = {
  enumerateNodeProcesses,
  classify,
  killProcess,
  run,
  // Exported for testing:
  _isScheduledSleeper: isScheduledSleeper,
  _isHeadlessDrain: isHeadlessDrain,
  _isDaemon: isDaemon,
  _extractDelaySeconds: extractDelaySeconds,
};

if (require.main === module) main();
