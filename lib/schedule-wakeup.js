// Shared ScheduleWakeup substrate: cancel prior wake for a session, arm a delayed re-prompt.
// Pidfiles under resolveWakeDir()/<session-slug>.pid; wake lines append to <session-slug>.fire.
// On fire, the wake host appends:
//   ORCH_SCHEDULED_TASK {"delaySeconds":N,"reason":"...","prompt":"..."}
//
// Registry: .graph/scheduled-wakeups.json maps KEY -> {fireAt, session, payload, fire}
// - On arm: drop the prior row for the same KEY (dedup), write the new one, ensure a wake host.
// - On fire: the host appends the line and deletes the row.
// - On sweep: prune rows the host failed to deliver; re-host anything still pending.
//
// ONE host process serves the WHOLE registry. The previous design spawned a detached `node -e`
// sleeper per wakeup, so the live-process count tracked the pending-wakeup count and any lost fire
// leaked a process nothing could find again (3,893 accumulated on one machine and exhausted the
// process table). Rows written by that older design — a `pid`, no `payload`/`fire` — are still
// recognized and reaped by pid; see _isHostedEntry.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Windows refuses a rename ONTO a path that another process currently holds open, with EPERM (or
// EACCES/EBUSY). Readers deliberately take no lock — the wake host reads the registry every tick,
// and so do the sweeps and the tests — so a mutator's publish can collide with a read window that
// lasts microseconds. Left unretried that EPERM aborts the whole caller: an arm that hit it dropped
// its wakeup on the floor, which is exactly the "registry has N entries" flake this retry removes.
// POSIX renames over an open file just fine, so this loop is a no-op there.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_ATTEMPTS = 40;
const RENAME_RETRY_SLEEP_MS = 10;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmp, dest) {
  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (!e || !RENAME_RETRY_CODES.has(e.code)) break;
      sleepSync(RENAME_RETRY_SLEEP_MS);
    }
  }
  try { fs.unlinkSync(tmp); } catch (_) {}
  throw lastErr;
}

// Publish `content` at `dest` atomically: write a per-process temp beside it, then rename over.
// Used for every file in this module that another process may read concurrently.
function atomicWrite(dest, content) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  renameWithRetry(tmp, dest);
}

function writeRegistry(registryPath, data) {
  atomicWrite(registryPath, JSON.stringify(data, null, 2));
}

// ---------- Cross-process registry lock ----------

// Every registry mutation is a read-modify-write, and two of them run concurrently BY DESIGN: the
// caller process (arm / cancel / sweep) and the shared wake host (fire a row, then drop it).
// Unserialized they lose updates — an arm publishes a snapshot taken before the host's delete, or
// the host publishes one taken before the arm's insert — and the losing side's wakeup silently
// never happens.
//
// The lock is an atomically-created DIRECTORY holding its owner's pid: mkdir is the only
// test-and-set every filesystem gives us on both Windows and POSIX. The shape (unique owner file
// inside the held directory, so a slow reclaimer can only ever unlink the exact record it judged
// dead) is adapted from withFileLock in lib/onboard-state.js.
//
// It lives in the WAKE DIR, not beside the registry, for the same reason hostPidPath does: the
// registry sits in a workspace's .graph/, which the daemon commits with `git add -A`, and lock
// debris must never be a candidate for that commit. This shares hostPidPath's existing invariant
// that all participants resolve the same wake dir — if that ever broke, host registration would
// already be broken with it, so the lock adds no new failure mode.
//
// Posture differs from onboard-state's withFileLock ON PURPOSE. That lock guards a publication
// transaction and must fail closed. This one guards a soft runtime cache of pending timers, so it
// fails OPEN: if the lock cannot be taken within LOCK_WAIT_MS we run the mutation unlocked rather
// than throw, because leaked lock debris must never make wakeups permanently unarmable — degrading
// to today's racy-but-working behavior beats refusing to arm. It also never probes process start
// tokens the way onboard-state does: that costs a powershell spawn per acquisition on Windows,
// which is far too expensive for a path the hook layer calls on every turn. A dead owner is
// reclaimed by pid liveness, with an age fallback covering the records pid liveness cannot judge.

// Deliberately short. Acquisition parks the calling thread, and one caller is the daemon's 60s
// sweep, which runs synchronously on its event loop — a long wait there is a stalled HTTP server,
// not merely a slow sweep. Every critical section under this lock is a read, an object edit and a
// rename, so honest contention clears in well under a millisecond and this already covers dozens of
// queued holders. Waiting longer than this means something is wrong, which is the case failing open
// exists to handle.
const REGISTRY_LOCK_WAIT_MS = 250;
const REGISTRY_LOCK_STALE_MS = 30 * 1000;
const REGISTRY_LOCK_SLEEP_MS = 5;
const OWNER_FILE_RE = /^owner-[a-f0-9]{16}\.json$/;

function registryLockDir(registryPath) {
  const tag = crypto.createHash('sha1').update(String(registryPath)).digest('hex').slice(0, 12);
  return path.join(resolveWakeDir(), `wake-registry-${tag}.lock`);
}

// Decide whether an existing lock directory can be taken over, and take it over if so.
// Returns true when the caller should immediately retry acquisition.
function reclaimStaleRegistryLock(lockDir) {
  let stat;
  let names;
  try {
    stat = fs.statSync(lockDir);
    names = fs.readdirSync(lockDir);
  } catch (_) {
    return true; // Vanished under us — the owner released it. Retry acquiring.
  }
  if (!stat.isDirectory()) return false;
  const ownerName = names.find((n) => OWNER_FILE_RE.test(n));
  if (!ownerName) {
    // No owner record: either a lock being acquired right now (the window between mkdir and the
    // owner write), or debris from a process that died inside that window. Only age separates them.
    if (Date.now() - stat.mtimeMs <= REGISTRY_LOCK_STALE_MS) return false;
    try { fs.rmdirSync(lockDir); return true; } catch (_) { return false; }
  }
  const ownerPath = path.join(lockDir, ownerName);
  let record = null;
  try { record = JSON.parse(fs.readFileSync(ownerPath, 'utf8')); } catch (_) {}
  const pid = record && Number(record.pid);
  const heldSince = Number(record && record.at) || stat.mtimeMs;
  const aged = Date.now() - heldSince > REGISTRY_LOCK_STALE_MS;
  // A live owner stays authoritative until it ages out. The age escape hatch is what a start token
  // would otherwise buy us: without one, a pid recycled onto an unrelated live process would keep
  // the lock forever. Critical sections here are sub-millisecond, so 30s never fires on a real one.
  if (Number.isInteger(pid) && pid > 0 && probePidAlive(pid) && !aged) return false;
  // Remove ONLY the exact record judged dead. A replacement owner writes a different random
  // pathname, so a slow reclaimer can never unlink the live owner that succeeded it.
  try { fs.unlinkSync(ownerPath); } catch (_) { return false; }
  try { fs.rmdirSync(lockDir); } catch (_) { /* a replacement may already hold it */ }
  return true;
}

function withRegistryLock(registryPath, fn) {
  let lockDir;
  let ownerPath = null;
  try {
    lockDir = registryLockDir(registryPath);
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  } catch (_) {
    return fn(); // Cannot even reach the lock's directory — fail open.
  }
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
    } catch (e) {
      // The deadline governs every retry path, reclaim included: a reclaim that keeps succeeding
      // because a competitor keeps re-acquiring would otherwise spin here without a bound.
      if (e && e.code === 'EEXIST' && Date.now() < deadline) {
        if (reclaimStaleRegistryLock(lockDir)) continue;
        sleepSync(REGISTRY_LOCK_SLEEP_MS);
        continue;
      }
      break; // Waited long enough, or the lock is unusable — fail open.
    }
    try {
      const candidate = path.join(lockDir, `owner-${crypto.randomBytes(8).toString('hex')}.json`);
      fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid, at: Date.now() }));
      ownerPath = candidate;
    } catch (_) {
      try { fs.rmdirSync(lockDir); } catch (_) {}
    }
    break;
  }
  try {
    return fn();
  } finally {
    if (ownerPath) {
      try { fs.unlinkSync(ownerPath); } catch (_) {}
      try { fs.rmdirSync(lockDir); } catch (_) {}
    }
  }
}

/**
 * The ONLY sanctioned way to change the registry. `mutate` receives the registry object read
 * fresh INSIDE the lock and returns a result; the file is rewritten only when that result reports
 * `changed`. Reads stay lock-free — a reader can never corrupt anything, and blocking the wake
 * host's every-second poll behind a lock would buy nothing.
 */
function mutateRegistry(registryPath, mutate) {
  return withRegistryLock(registryPath, () => {
    const registry = readRegistry(registryPath);
    const result = mutate(registry) || {};
    if (result.changed) writeRegistry(registryPath, registry);
    return result;
  });
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

// Raw OS liveness probe — signal 0, no recently-killed memo. Used where the answer must reflect
// process reality rather than our own dedup bookkeeping (host detection, kill verification).
function probePidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = process does not exist
    return e.code !== 'ESRCH';
  }
}

// Send signal 0 to check liveness; returns true if alive. A pid we just killed counts as dead so
// the sweep and janitor paths do not re-target it while the OS is still tearing it down.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (wasRecentlyKilled(pid)) return false;
  return probePidAlive(pid);
}

// Kill a process cross-platform. On Windows uses taskkill /F; on POSIX sends SIGTERM.
// Returns true only when the process is actually gone. The recently-killed memo is recorded ONLY
// on a real kill: memoizing a kill that never happened (taskkill itself failing to spawn is the
// exact failure mode a process-table exhaustion produces) makes isPidAlive report a live process
// as dead, so the sweeps prune its registry row and the process becomes permanently untrackable.
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      if (res.error) return false; // taskkill could not be spawned — nothing was killed.
      if (res.status === 0 || !probePidAlive(pid)) { noteKilledPid(pid); return true; }
      return false;
    }
    process.kill(pid, 'SIGTERM');
    noteKilledPid(pid);
    return true;
  } catch (e) {
    // ESRCH = already dead.
    if (e.code === 'ESRCH') { noteKilledPid(pid); return true; }
    return false;
  }
}

// ---------- Shared wake host ----------

// A registry row is HOSTED when it carries everything the shared host needs to deliver it itself
// (payload + fire path) and therefore owns no process of its own. Rows from the older
// one-sleeper-per-wakeup design carry a `pid` instead and are still reaped by pid.
function isHostedEntry(entry) {
  return !!(entry && entry.payload && typeof entry.fire === 'string' && entry.fire);
}

// The host pidfile lives in the WAKE DIR (not next to the registry) under a name derived from the
// registry path, so every tool that can see the wake dir — including the bash adapter's cancel —
// can recognize a host pid and refuse to kill it. One host per registry.
function hostPidPath(registryPath) {
  const tag = crypto.createHash('sha1').update(String(registryPath)).digest('hex').slice(0, 12);
  return path.join(resolveWakeDir(), `wake-host-${tag}.pid`);
}

function readHostPid(registryPath) {
  try {
    const pid = parseInt(fs.readFileSync(hostPidPath(registryPath), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

// Start the registry's wake host if it is not already running, and return its pid (null if the
// spawn failed). Liveness uses the raw probe: a host wrongly judged dead would be duplicated, and
// a host wrongly judged alive would leave every pending row undelivered.
function ensureWakeHost(registryPath) {
  const existing = readHostPid(registryPath);
  if (existing && probePidAlive(existing)) return existing;
  const hp = hostPidPath(registryPath);
  try {
    fs.mkdirSync(path.dirname(hp), { recursive: true });
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'wake-host.js'), registryPath, hp],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    atomicWrite(hp, String(child.pid));
    return child.pid;
  } catch (_) {
    return null;
  }
}

// Release the registry's host registration WITHOUT killing anything. Called when a sweep finds a
// row the recorded host failed to deliver — evidence that it is stuck, or that its pid was recycled
// and now belongs to an unrelated process. Dropping the pidfile is enough: ensureWakeHost then
// starts a working host, and a merely-stuck host exits on its next tick when it sees it no longer
// owns the file. The pid itself is never killed, because we can no longer prove what it is.
function clearWakeHost(registryPath) {
  try { fs.unlinkSync(hostPidPath(registryPath)); } catch (_) {}
}

// Count rows the shared host is responsible for. Used by the sweeps to decide whether a host still
// needs to exist.
function countHostedEntries(registry) {
  let n = 0;
  for (const entry of Object.values(registry)) if (isHostedEntry(entry)) n++;
  return n;
}

// ---------- Boot-time orphan sweep ----------

/**
 * sweepOrphanWakeups() — call once on daemon boot.
 *
 * Hosted rows carry no process of their own: one still sitting here more than 10 min past its
 * fireAt means no host delivered it, so the row is pruned. Legacy per-wakeup sleeper rows keep the
 * original treatment — pruned when their pid is dead, killed + pruned when alive but long stale.
 * Cleans up matching .pid files, then re-hosts whatever is still pending.
 */
function sweepOrphanWakeups() {
  const registryPath = resolveRegistryPath();
  const STALE_MS = 10 * 60 * 1000; // 10 minutes past fireAt = stale
  const dropSession = (session) => {
    if (!session) return;
    const pf = pidFile(session);
    try { if (fs.existsSync(pf)) fs.unlinkSync(pf); } catch (_) {}
  };
  // The whole reconcile runs inside the lock: its decisions are read off the registry, so a row
  // arming or firing mid-pass would otherwise be judged against a snapshot that no longer exists.
  let outcome;
  try {
    outcome = mutateRegistry(registryPath, (registry) => {
      const now = Date.now();
      let changed = false;
      let undelivered = 0;
      for (const [key, entry] of Object.entries(registry)) {
        if (!entry) { delete registry[key]; changed = true; continue; }
        const { pid, fireAt, session } = entry;
        const stale = typeof fireAt === 'number' && (now - fireAt) > STALE_MS;
        if (isHostedEntry(entry)) {
          if (stale) { delete registry[key]; changed = true; undelivered++; dropSession(session); }
          continue;
        }
        const alive = isPidAlive(pid);
        if (!alive || stale) {
          if (alive && stale) killPid(pid);
          delete registry[key];
          changed = true;
          dropSession(session);
        }
      }
      return { changed, undelivered, hosted: countHostedEntries(registry) };
    });
  } catch (_) {
    outcome = null;
  }
  // A registry we could not reconcile tells us nothing about hosting; leave the host alone.
  if (!outcome) return { swept: false, undelivered: 0 };
  if (outcome.undelivered > 0) clearWakeHost(registryPath);
  if (outcome.hosted > 0) ensureWakeHost(registryPath);
  return { swept: outcome.changed, undelivered: outcome.undelivered };
}

// ---------- Periodic registry reaper (PART 1: always on) ----------

/**
 * sweepStaleWakeups() — call on every daemon sweep tick (60s).
 *
 * Walks the wakeup REGISTRY and reconciles each entry against process reality.
 * Reuses the same liveness probe (isPidAlive) + kill path (killPid) as the boot
 * sweep — there is no second kill/liveness mechanism.
 *
 * HOSTED entries (the current design) own no process, so there is nothing to kill: an entry still
 * pending past its grace means the shared host died or stalled → DELETE the entry. The sweep then
 * doubles as the host's supervisor: if any hosted entry is still pending afterwards it calls
 * ensureWakeHost, so a host killed out from under the registry is back within one tick.
 *
 * LEGACY per-wakeup sleeper entries (a `pid`, no payload) keep the original treatment:
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
 * Returns { swept, killed, pruned, hosted, undelivered } for observability/tests.
 */
function wakeupGraceMs() {
  const raw = Number(process.env.ORCH_WAKEUP_GRACE_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? raw : 5;
  return min * 60 * 1000;
}

function sweepStaleWakeups() {
  const registryPath = resolveRegistryPath();
  const GRACE_MS = wakeupGraceMs();
  const dropSession = (session) => {
    if (!session) return;
    const pf = pidFile(session);
    try { if (fs.existsSync(pf)) fs.unlinkSync(pf); } catch (_) {}
  };
  // As in the boot sweep, the whole reconcile is one locked read-modify-write so that a wakeup
  // armed or fired mid-pass is never judged — or overwritten — against a stale snapshot.
  let outcome;
  try {
    outcome = mutateRegistry(registryPath, (registry) => {
      const now = Date.now();
      let changed = false;
      let killed = 0;
      let pruned = 0;
      let undelivered = 0;
      for (const [key, entry] of Object.entries(registry)) {
        if (!entry) { delete registry[key]; changed = true; pruned++; continue; }
        const { pid, fireAt, session } = entry;
        if (isHostedEntry(entry)) {
          // No per-row process to probe or kill — only undelivered-past-grace is actionable.
          if (typeof fireAt === 'number' && (now - fireAt) > GRACE_MS) {
            delete registry[key];
            changed = true;
            pruned++;
            undelivered++;
            dropSession(session);
          }
          continue;
        }
        const alive = isPidAlive(pid);
        if (!alive) {
          // (a) dead → prune the dangling record.
          delete registry[key];
          changed = true;
          pruned++;
          dropSession(session);
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
          dropSession(session);
          continue;
        }
        // (c) pending / recent → leave.
      }
      return { changed, killed, pruned, undelivered, hosted: countHostedEntries(registry) };
    });
  } catch (_) {
    outcome = null;
  }
  // A registry we could not reconcile tells us nothing about hosting; leave the host alone.
  if (!outcome) return { swept: false, killed: 0, pruned: 0, hosted: 0, undelivered: 0 };
  // An undelivered row proves the recorded host is not doing its job — release the registration so
  // the ensure below starts a working one, rather than trusting a pid that may not even be a host.
  if (outcome.undelivered > 0) clearWakeHost(registryPath);
  if (outcome.hosted > 0) ensureWakeHost(registryPath);
  return {
    swept: outcome.changed,
    killed: outcome.killed,
    pruned: outcome.pruned,
    hosted: outcome.hosted,
    undelivered: outcome.undelivered,
  };
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
    const hostPid = readHostPid(registryPath);
    let pid;
    let hadEntry = false;

    // 1. Check legacy pid file
    if (fs.existsSync(pf)) {
      pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
      try { fs.unlinkSync(pf); } catch (_) {}
    }

    // 2. Check and clean registry. Read and delete are one locked step: reading the row outside
    // the lock and deleting it inside would let a concurrent re-arm's row be dropped instead.
    // A write failure here now propagates to the catch below rather than being swallowed —
    // reporting a cancel that did not actually remove the row is the exact silent-loss class this
    // lock exists to eliminate, and writeRegistry already retries the transient Windows case.
    const removed = mutateRegistry(registryPath, (registry) => {
      const entry = registry[key];
      if (!entry) return { changed: false, entry: null };
      delete registry[key];
      return { changed: true, entry };
    });
    if (removed.entry) {
      hadEntry = true;
      if (!pid || !Number.isInteger(pid)) pid = removed.entry.pid;
    }

    const canceled = hadEntry || (Number.isInteger(pid) && pid > 0);
    // Deleting the row IS the cancel for a hosted wake. The pid recorded for it is the SHARED
    // host, which owns every other session's pending wake — killing it here would cancel all of
    // them, so only a sleeper this session genuinely owns is ever killed.
    if (Number.isInteger(pid) && pid > 0 && pid !== hostPid) killPid(pid);

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

  // Row FIRST, host second. The host reads the registry, so a row that lands before the host is
  // ensured is always seen; the reverse order could strand the row behind a host that idle-exits
  // in the gap. The row is self-describing (payload + fire path) precisely so that ANY host — the
  // one started below, or one a later sweep starts — can deliver it.
  try {
    mutateRegistry(registryPath, (registry) => {
      registry[key] = { fireAt, session: key, payload, fire: firePath };
      return { changed: true };
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const host = ensureWakeHost(registryPath);

  // Legacy pid file (backward compat: the bash adapter and the docs both point at it). It records
  // the SHARED host, which is why every cancel path must refuse to kill the pid it reads there.
  atomicWrite(pidFile(session), host === null ? '' : String(host));

  return { ok: true, pid: host, host, hosted: true, fireAt, delaySeconds: delay, session };
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
  ensureWakeHost,
  hostPidPath,
  sweepOrphanWakeups,
  sweepStaleWakeups,
  sweepOrphanProcesses,
  // Used by lib/wake-host.js (single-source registry IO + row classification) and by tests.
  _hostPidPath: hostPidPath,
  _readHostPid: readHostPid,
  _clearWakeHost: clearWakeHost,
  _isHostedEntry: isHostedEntry,
  _writeRegistry: writeRegistry,
  _mutateRegistry: mutateRegistry,
  _probePidAlive: probePidAlive,
  // Exposed for testing
  _killPid: killPid,
  _isPidAlive: isPidAlive,
  _readRegistry: readRegistry,
  _matchesEphemeralAllowlist: matchesEphemeralAllowlist,
  _protectedPids: protectedPids,
  _noteKilledPid: noteKilledPid,
};
