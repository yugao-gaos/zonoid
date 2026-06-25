// Shared ScheduleWakeup substrate: cancel prior wake for a session, arm a delayed re-prompt.
// Pidfiles under resolveWakeDir()/<session-slug>.pid; wake lines append to <session-slug>.fire.
// On fire, a detached sleeper appends:
//   ORCH_SCHEDULED_TASK {"delaySeconds":N,"reason":"...","prompt":"..."}
//
// Registry: .graph/scheduled-wakeups.json maps KEY -> {pid, fireAt, session}
// - On arm: kill prior sleeper for same KEY (dedup), write new entry.
// - On fire: sleeper removes its own registry entry (reap-on-fire).
// - On boot (sweepOrphanWakeups): kill pids that are dead or whose fireAt is long past.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const runtimePaths = require('./runtime-paths');

const recentlyKilledPids = new Map();
const RECENTLY_KILLED_TTL_MS = 30 * 1000;

function resolveDataDir() {
  return runtimePaths.resolveDataDir();
}

function resolveWakeDir() {
  return path.join(resolveDataDir(), 'wake');
}

// Registry lives inside .graph/ (workspace-relative) when ORCH_WORKSPACE is set,
// otherwise falls back to data dir so it is still findable.
function resolveRegistryPath() {
  const workspace = process.env.ORCH_WORKSPACE;
  if (workspace) return path.join(workspace, '.graph', 'scheduled-wakeups.json');
  return path.join(resolveDataDir(), 'scheduled-wakeups.json');
}

function sessionSlug(session) {
  const s = String(session || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return s || 'unknown';
}

function pidFile(session) {
  return path.join(resolveWakeDir(), `${sessionSlug(session)}.pid`);
}

function fireFile(session) {
  return path.join(resolveWakeDir(), `${sessionSlug(session)}.fire`);
}

function ensureFireFile(session) {
  if (!session) return '';
  fs.mkdirSync(resolveWakeDir(), { recursive: true });
  const fp = fireFile(session);
  fs.closeSync(fs.openSync(fp, 'a'));
  return fp;
}

// ---------- Registry helpers ----------

function readRegistry(registryPath) {
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeRegistry(registryPath, data) {
  const dir = path.dirname(registryPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, registryPath);
}

// ---------- Cross-platform process utilities ----------

function noteKilledPid(pid) {
  recentlyKilledPids.set(pid, Date.now());
}

function wasRecentlyKilled(pid) {
  const killedAt = recentlyKilledPids.get(pid);
  if (!killedAt) return false;
  if (Date.now() - killedAt > RECENTLY_KILLED_TTL_MS) {
    recentlyKilledPids.delete(pid);
    return false;
  }
  return true;
}

// Send signal 0 to check liveness; returns true if alive.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (wasRecentlyKilled(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = process does not exist
    return e.code !== 'ESRCH';
  }
}

// Kill a process cross-platform. On Windows uses taskkill /F; on POSIX sends SIGTERM.
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    noteKilledPid(pid);
  } catch (e) {
    // ESRCH = already dead; Windows errors = process gone — ignore both.
    if (e.code === 'ESRCH') noteKilledPid(pid);
    else { /* swallow Windows errors */ }
  }
}

// ---------- Boot-time orphan sweep ----------

/**
 * sweepOrphanWakeups() — call once on daemon boot.
 * Reads the global registry and kills any entry whose pid is:
 *   (a) no longer alive, OR
 *   (b) alive but fireAt is more than 10 min in the past (stale leaker).
 * Cleans up matching .pid files and removes swept entries from the registry.
 */
function sweepOrphanWakeups() {
  const registryPath = resolveRegistryPath();
  const registry = readRegistry(registryPath);
  const now = Date.now();
  const STALE_MS = 10 * 60 * 1000; // 10 minutes past fireAt = stale
  let changed = false;
  for (const [key, entry] of Object.entries(registry)) {
    if (!entry) { delete registry[key]; changed = true; continue; }
    const { pid, fireAt, session } = entry;
    const alive = isPidAlive(pid);
    const stale = typeof fireAt === 'number' && (now - fireAt) > STALE_MS;
    if (!alive || stale) {
      if (alive && stale) killPid(pid);
      delete registry[key];
      changed = true;
      if (session) {
        const pf = pidFile(session);
        try { if (fs.existsSync(pf)) fs.unlinkSync(pf); } catch (_) {}
      }
    }
  }
  if (changed) {
    try { writeRegistry(registryPath, registry); } catch (_) {}
  }
  return { swept: changed };
}

// ---------- Periodic registry reaper (PART 1: always on) ----------

/**
 * sweepStaleWakeups() — call on every daemon sweep tick (60s).
 *
 * Walks the wakeup REGISTRY and reconciles each entry against process reality.
 * Reuses the same liveness probe (isPidAlive) + kill path (killPid) as the boot
 * sweep — there is no second kill/liveness mechanism.
 *
 * Per entry:
 *   (a) process DEAD                         → DELETE the entry (it fired+exited; the
 *                                              reap-on-fire write may have been lost, e.g.
 *                                              hard kill — prune the dangling record).
 *   (b) ALIVE but fireAt well past
 *       (now > fireAt + GRACE)               → stuck sleeper that should have fired and
 *                                              exited long ago → KILL pid + DELETE entry.
 *   (c) pending / recently-fired             → LEAVE (a sleeper whose fireAt is in the
 *                                              future, or only just past, is doing its job).
 *
 * GRACE defaults to 5 min, override via ORCH_WAKEUP_GRACE_MIN. This is a tighter window
 * than the boot sweep's 10 min STALE_MS on purpose: the boot sweep runs once against a
 * possibly-long-stale registry, whereas this runs continuously, so a stuck sleeper should
 * be reaped sooner. Entries with a non-numeric fireAt are treated as never-stale for the
 * grace test (only pruned if their pid is dead).
 *
 * Returns { swept, killed, pruned } for observability/tests.
 */
function wakeupGraceMs() {
  const raw = Number(process.env.ORCH_WAKEUP_GRACE_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? raw : 5;
  return min * 60 * 1000;
}

function sweepStaleWakeups() {
  const registryPath = resolveRegistryPath();
  const registry = readRegistry(registryPath);
  const now = Date.now();
  const GRACE_MS = wakeupGraceMs();
  let changed = false;
  let killed = 0;
  let pruned = 0;
  for (const [key, entry] of Object.entries(registry)) {
    if (!entry) { delete registry[key]; changed = true; pruned++; continue; }
    const { pid, fireAt, session } = entry;
    const alive = isPidAlive(pid);
    if (!alive) {
      // (a) dead → prune the dangling record.
      delete registry[key];
      changed = true;
      pruned++;
      if (session) {
        const pf = pidFile(session);
        try { if (fs.existsSync(pf)) fs.unlinkSync(pf); } catch (_) {}
      }
      continue;
    }
    const overdue = typeof fireAt === 'number' && (now - fireAt) > GRACE_MS;
    if (overdue) {
      // (b) alive but long overdue → stuck sleeper → kill + prune.
      killPid(pid);
      delete registry[key];
      changed = true;
      killed++;
      pruned++;
      if (session) {
        const pf = pidFile(session);
        try { if (fs.existsSync(pf)) fs.unlinkSync(pf); } catch (_) {}
      }
      continue;
    }
    // (c) pending / recent → leave.
  }
  if (changed) {
    try { writeRegistry(registryPath, registry); } catch (_) {}
  }
  return { swept: changed, killed, pruned };
}

// ---------- Opt-in orphan node-process janitor (PART 2: default OFF) ----------

// Filenames of the long-running sidecars/services whose pids must NEVER be killed by the
// janitor. We read these pidfiles directly off the canonical data dir (the same place
// lib/embed.js and lib/rerank.js write them) rather than importing those modules — importing
// lib/embed.js has the side effect of eagerly spawning the MiniLM sidecar, which a janitor
// pass must never trigger. resolveDataDir() here is the shared runtime-paths resolver, so the
// path matches what those modules compute.
const SIDECAR_PIDFILES = ['embed.pid', 'rerank.pid'];

function readPidFile(filePath) {
  try {
    const pid = parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

// The set of pids that are UNCONDITIONALLY protected: this daemon process, and the embed +
// rerank sidecars (read live off their pidfiles each pass so a sidecar restart is always
// covered). The mcp-graph process is protected structurally — it never matches the ephemeral
// allowlist below (its argv is `mcp-graph.js`, not a `--test` runner or a `require('./daemon')`
// blob) — so it needs no pidfile read.
function protectedPids() {
  const protectedSet = new Set([process.pid]);
  const dataDir = resolveDataDir();
  for (const name of SIDECAR_PIDFILES) {
    const pid = readPidFile(path.join(dataDir, name));
    if (pid) protectedSet.add(pid);
  }
  return protectedSet;
}

// ALLOWLIST — a process is a kill CANDIDATE only if its command line matches one of these
// ephemeral patterns. Anything not matching is left strictly alone (services, editors, shells,
// the user's own node programs, the daemon, mcp-graph, the sidecars). This is the core safety
// invariant: when a command does not clearly look like a throwaway test/daemon-eval process,
// we DO NOT kill it.
function matchesEphemeralAllowlist(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  // node --test runners (the test suite); `node --test path` or `node --test=...`.
  if (/\bnode(\.exe)?\b[^\n]*\s--test(\s|=|$)/.test(cmd)) return '--test runner';
  // `node -e "...require('./daemon')..."` / require("./daemon") inline daemon-boot blobs
  // (ad-hoc test daemons spun up on a throwaway port). Match both quote styles.
  if (/\bnode(\.exe)?\b[^\n]*\s-e\b/.test(cmd) && /require\((['"])\.\/daemon\1\)/.test(cmd)) {
    return "node -e require('./daemon') blob";
  }
  // Obvious test-port daemons: an explicit ORCH test-port env inlined on a daemon.js launch.
  if (/daemon\.js/.test(cmd) && /\bORCH_(TEST_)?PORT=/.test(cmd)) return 'test-port daemon';
  return null;
}

// List OS node processes cross-platform as { pid, etimeSec, cmd }.
//   POSIX: ps -eo pid,etimes,args   (etimes = elapsed seconds, directly usable).
//   Win:   Get-CimInstance Win32_Process for node.exe — CreationDate → age; CommandLine → cmd.
// Returns [] on any failure (a janitor that cannot enumerate safely does nothing).
function listNodeProcesses() {
  try {
    if (process.platform === 'win32') {
      return listNodeProcessesWindows();
    }
    return listNodeProcessesPosix();
  } catch (_) {
    return [];
  }
}

function listNodeProcessesPosix() {
  const res = spawnSync('ps', ['-eo', 'pid=,etimes=,args='], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return [];
  const out = [];
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[3];
    if (!/\bnode\b/.test(cmd)) continue;
    out.push({ pid: parseInt(m[1], 10), etimeSec: parseInt(m[2], 10), cmd });
  }
  return out;
}

function listNodeProcessesWindows() {
  // PowerShell: emit one JSON object per node.exe process with pid, age (s), and command line.
  // CreationDate comes back as a CIM datetime; convert to epoch-seconds age in-script.
  const ps = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$now=Get-Date;",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {",
    "  $age=[int]($now - $_.CreationDate).TotalSeconds;",
    "  [PSCustomObject]@{ pid=$_.ProcessId; age=$age; cmd=$_.CommandLine } } |",
    "  ConvertTo-Json -Compress",
  ].join(' ');
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (_) { return []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const p of arr) {
    if (!p || typeof p.pid !== 'number') continue;
    out.push({ pid: p.pid, etimeSec: Number(p.age) || 0, cmd: p.cmd || '' });
  }
  return out;
}

/**
 * sweepOrphanProcesses() — OPT-IN OS-level node-process janitor (default OFF).
 *
 * Gated behind ORCH_PROCESS_JANITOR: with the flag unset/falsy this is a PURE NO-OP (returns
 * { enabled:false } having listed/killed nothing — zero behavior change). Only when enabled
 * does it enumerate node processes and kill the narrow intersection of:
 *   (1) command line MATCHES the ephemeral allowlist (test runners / `node -e require('./daemon')`
 *       blobs / inline test-port daemons), AND
 *   (2) age > ORCH_PROCESS_JANITOR_MAX_MIN (default 20 min), AND
 *   (3) pid is NOT in the protected set (this daemon + embed/rerank sidecars), AND
 *   (4) pid was not just killed (recentlyKilled guard, shared with the wakeup path).
 *
 * Everything else is left untouched. It is structurally impossible to kill a service or a
 * long-runner: a non-matching command never becomes a candidate (rule 1), and the daemon /
 * sidecars / mcp-graph are excluded by pid (rule 3) or by never matching the allowlist.
 * Each kill is logged with pid + matched pattern + age.
 *
 * Optional injection points (tests): opts.list (a listNodeProcesses replacement) and
 * opts.kill (a killPid replacement) — production passes neither.
 */
function janitorMaxMs() {
  const raw = Number(process.env.ORCH_PROCESS_JANITOR_MAX_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? raw : 20;
  return min * 60 * 1000;
}

function sweepOrphanProcesses(opts = {}) {
  if (!process.env.ORCH_PROCESS_JANITOR) {
    return { enabled: false, scanned: 0, killed: 0, kills: [] };
  }
  const list = typeof opts.list === 'function' ? opts.list : listNodeProcesses;
  const kill = typeof opts.kill === 'function' ? opts.kill : killPid;
  const maxAgeMs = janitorMaxMs();
  const protectedSet = protectedPids();
  const procs = list() || [];
  const kills = [];
  for (const proc of procs) {
    if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) continue;
    if (protectedSet.has(proc.pid)) continue;        // (3) never the daemon/sidecars
    if (wasRecentlyKilled(proc.pid)) continue;       // (4) don't double-kill
    const pattern = matchesEphemeralAllowlist(proc.cmd);
    if (!pattern) continue;                          // (1) not an allowlisted ephemeral proc
    const ageMs = (Number(proc.etimeSec) || 0) * 1000;
    if (ageMs <= maxAgeMs) continue;                 // (2) too young — leave it
    kill(proc.pid);
    const ageMin = Math.round((ageMs / 60000) * 10) / 10;
    const rec = { pid: proc.pid, pattern, ageMin };
    kills.push(rec);
    try {
      process.stderr.write(
        `[janitor] killed orphan node pid=${proc.pid} matched="${pattern}" age=${ageMin}min\n`,
      );
    } catch (_) {}
  }
  return { enabled: true, scanned: procs.length, killed: kills.length, kills };
}

// ---------- Cancel / arm ----------

function cancelWakeup(session) {
  if (!session) return { ok: false, error: 'session required' };
  const pf = pidFile(session);
  const registryPath = resolveRegistryPath();
  const key = sessionSlug(session);
  try {
    let pid;
    let hadEntry = false;

    // 1. Check legacy pid file
    if (fs.existsSync(pf)) {
      pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
      try { fs.unlinkSync(pf); } catch (_) {}
    }

    // 2. Check and clean registry
    const registry = readRegistry(registryPath);
    if (registry[key]) {
      hadEntry = true;
      if (!pid || !Number.isInteger(pid)) pid = registry[key].pid;
      delete registry[key];
      try { writeRegistry(registryPath, registry); } catch (_) {}
    }

    const canceled = hadEntry || (Number.isInteger(pid) && pid > 0);
    if (Number.isInteger(pid) && pid > 0) killPid(pid);

    return { ok: true, canceled, pid: Number.isInteger(pid) ? pid : undefined };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function armWakeup({ session, delaySeconds, reason = '', prompt = '' }) {
  if (!session) return { ok: false, error: 'session required' };
  const delay = Math.max(0, Math.floor(Number(delaySeconds) || 0));

  // Dedup: kill any prior sleeper for this session before spawning new one.
  const prior = cancelWakeup(session);
  if (!prior.ok) return prior;

  const registryPath = resolveRegistryPath();
  const key = sessionSlug(session);
  const fireAt = Date.now() + delay * 1000;
  const payload = { delaySeconds: delay, reason: String(reason), prompt: String(prompt) };
  const firePath = ensureFireFile(session);

  // Sleeper script:
  // 1. Appends the wakeup event to the .fire file.
  // 2. Reap-on-fire: removes its own entry from the global registry.
  const script = [
    'const fs = require("fs");',
    'const p = JSON.parse(process.argv[1]);',
    'const fire = process.argv[2];',
    'const reg = process.argv[3];',
    'const key = process.argv[4];',
    `setTimeout(() => {`,
    '  try { fs.appendFileSync(fire, "ORCH_SCHEDULED_TASK " + JSON.stringify(p) + "\\n"); } catch(_) {}',
    '  try {',
    '    const data = JSON.parse(fs.readFileSync(reg, "utf8"));',
    '    delete data[key];',
    '    const tmp = reg + ".fired.tmp";',
    '    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));',
    '    fs.renameSync(tmp, reg);',
    '  } catch(_) {}',
    `}, ${delay * 1000});`,
  ].join('\n');

  const child = spawn(
    process.execPath,
    ['-e', script, JSON.stringify(payload), firePath, registryPath, key],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();

  // Write legacy pid file (backward compat)
  const pf = pidFile(session);
  const tmp = `${pf}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(child.pid));
  fs.renameSync(tmp, pf);

  // Write global registry entry
  try {
    const registry = readRegistry(registryPath);
    registry[key] = { pid: child.pid, fireAt, session: key };
    writeRegistry(registryPath, registry);
  } catch (_) {}

  return { ok: true, pid: child.pid, delaySeconds: delay, session };
}

module.exports = {
  resolveDataDir,
  resolveWakeDir,
  resolveRegistryPath,
  sessionSlug,
  pidFile,
  fireFile,
  ensureFireFile,
  cancelWakeup,
  armWakeup,
  sweepOrphanWakeups,
  sweepStaleWakeups,
  sweepOrphanProcesses,
  // Exposed for testing
  _killPid: killPid,
  _isPidAlive: isPidAlive,
  _readRegistry: readRegistry,
  _matchesEphemeralAllowlist: matchesEphemeralAllowlist,
  _protectedPids: protectedPids,
  _noteKilledPid: noteKilledPid,
};
