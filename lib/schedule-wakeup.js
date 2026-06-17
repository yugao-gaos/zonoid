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
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function resolveDataDir() {
  return process.env.ORCH_DATA
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'orchestrator');
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

// Send signal 0 to check liveness; returns true if alive.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
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
      spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (e) {
    // ESRCH = already dead; Windows errors = process gone — ignore both.
    if (e.code !== 'ESRCH') { /* swallow Windows errors */ }
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

  fs.mkdirSync(resolveWakeDir(), { recursive: true });

  const registryPath = resolveRegistryPath();
  const key = sessionSlug(session);
  const fireAt = Date.now() + delay * 1000;
  const payload = { delaySeconds: delay, reason: String(reason), prompt: String(prompt) };
  const firePath = fireFile(session);

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
  cancelWakeup,
  armWakeup,
  sweepOrphanWakeups,
  // Exposed for testing
  _killPid: killPid,
  _isPidAlive: isPidAlive,
  _readRegistry: readRegistry,
};
