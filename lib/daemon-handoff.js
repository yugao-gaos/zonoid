'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const runtimePaths = require('./runtime-paths');

const HEALTH_SIGNATURE = 'zonoid-orchestrator-health-v1';

function expectedDaemonIdentity(daemonPath, options = {}) {
  const sourceRoot = path.dirname(path.resolve(daemonPath));
  let head = null;
  try {
    head = (options.execFileSync || execFileSync)(
      'git', ['-C', sourceRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    ).trim() || null;
  } catch { /* packaged installs may not have Git metadata */ }

  let version = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    version = pkg.version || null;
  } catch { /* incomplete install: readiness will fail later */ }

  return {
    head,
    version,
    build: head ? `git:${head}` : version ? `package:${version}` : null,
  };
}

function requestJson(port, route, timeoutMs = 1500, options = {}) {
  const httpModule = options.http || http;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = httpModule.request(
      { hostname: options.hostname || '127.0.0.1', port, path: route, method: 'GET' },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let body = null;
          try { body = raw ? JSON.parse(raw) : {}; } catch { /* malformed response is not trusted */ }
          finish({ reachable: true, statusCode: res.statusCode, headers: res.headers || {}, body });
        });
      }
    );
    req.on('error', () => finish({ reachable: false }));
    req.setTimeout(timeoutMs, () => {
      finish({ reachable: true, timedOut: true });
      req.destroy();
    });
    req.end();
  });
}

async function probeDaemon(options = {}) {
  const port = options.port || 8787;
  const timeoutMs = options.timeoutMs || 1500;
  const health = await requestJson(port, '/health', timeoutMs, options);
  if (!health.reachable) return { reachable: false, identified: false, ready: false };

  const healthIdentified = health.headers
    && health.headers['x-zonoid-health-signature'] === HEALTH_SIGNATURE;
  if (!healthIdentified) {
    return { reachable: true, identified: false, ready: false, timedOut: health.timedOut === true };
  }

  const healthBody = health.body || {};
  const version = await requestJson(port, '/version', timeoutMs, options);
  const versionIdentified = version.reachable && version.headers
    && version.headers['x-zonoid-health-signature'] === HEALTH_SIGNATURE;
  const versionBody = versionIdentified && version.body ? version.body : {};
  return {
    reachable: true,
    identified: true,
    ownershipProof: versionIdentified === true,
    ready: health.statusCode === 200 && healthBody.ok === true && healthBody.phase === 'ready',
    statusCode: health.statusCode,
    head: versionBody.head || healthBody.head || null,
    build: versionBody.build || healthBody.build || null,
    version: versionBody.version || healthBody.version || null,
    pid: Number(versionBody.pid || healthBody.pid) || null,
    bootedAt: versionBody.bootedAt || healthBody.bootedAt || null,
    health: healthBody,
  };
}

function identityMatches(observed, expected) {
  if (!observed || !observed.identified) return false;
  if (expected && expected.head && observed.head) return expected.head === observed.head;
  if (expected && expected.build && observed.build) return expected.build === observed.build;
  // Older signed daemons did not expose every identity field. Preserve compatibility when there is
  // no positive mismatch; a future launch can replace them once both sides expose an identity.
  return true;
}

function processAlive(pid, signalProcess = process.kill) {
  try { signalProcess(pid, 0); return true; } catch { return false; }
}

function ownedDaemonPid(observed, options = {}) {
  if (!observed || !observed.identified || observed.ownershipProof !== true) return null;
  const pid = Number(observed.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  let advertised = null;
  try { advertised = Number(fs.readFileSync(options.pidFile, 'utf8').trim()); } catch { return null; }
  if (advertised !== pid) return null;
  const isAlive = options.isProcessAlive || ((candidate) => processAlive(candidate, options.signalProcess));
  return isAlive(pid) ? pid : null;
}

function acquireLaunchLock(lockFile, options = {}) {
  const now = options.now || Date.now;
  const isAlive = options.isProcessAlive || processAlive;
  const staleMs = options.lockStaleMs || 60000;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: now() }));
      } finally {
        fs.closeSync(fd);
      }
      return {
        release() {
          try {
            const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            if (current.token === token) fs.unlinkSync(lockFile);
          } catch { /* already released or replaced */ }
        },
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let incumbent = null;
      try { incumbent = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* malformed lock is stale */ }
      const incumbentPid = Number(incumbent && incumbent.pid);
      const age = now() - Number(incumbent && incumbent.createdAt || 0);
      const alive = Number.isInteger(incumbentPid) && incumbentPid > 0 && isAlive(incumbentPid);
      if (alive && age >= 0 && age < staleMs) return null;
      try { fs.unlinkSync(lockFile); } catch { return null; }
    }
  }
  return null;
}

function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof child.removeListener === 'function') {
        child.removeListener('exit', onExit);
        child.removeListener('error', onExit);
      }
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    if (typeof child.once === 'function') {
      child.once('exit', onExit);
      child.once('error', onExit);
    }
  });
}

async function terminateSpawnedChild(child, graceMs = 1000) {
  if (childExited(child)) return;
  try { child.kill('SIGTERM'); } catch { return; }
  if (await waitForChildExit(child, graceMs)) return;
  try { child.kill('SIGKILL'); } catch { return; }
  await waitForChildExit(child, graceMs);
}

function spawnDetachedDaemon(options) {
  const child = spawn(process.execPath, [options.daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: options.env,
  });
  // Spawn failures surface through readiness below; keep the detached child from emitting an
  // unhandled `error` event that would crash the launcher before it can report a bounded failure.
  child.on('error', () => {});
  child.unref();
  return child;
}

async function ensureCurrentDaemon(options = {}) {
  const daemonPath = options.daemonPath || path.join(__dirname, '..', 'daemon.js');
  const expected = options.expectedIdentity || expectedDaemonIdentity(daemonPath, options);
  const port = options.port || 8787;
  const pidFile = options.pidFile || runtimePaths.runtimePath('daemon.pid');
  const lockFile = options.lockFile || runtimePaths.runtimePath(
    port === 8787 ? 'daemon-handoff.lock' : `daemon-handoff-${port}.lock`
  );
  const healthTimeoutMs = options.healthTimeoutMs || 1500;
  const startupTimeoutMs = options.startupTimeoutMs || 15000;
  const handoffTimeoutMs = options.handoffTimeoutMs || 6000;
  const pollMs = options.pollMs || 100;
  const childCleanupGraceMs = options.childCleanupGraceMs || 1000;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const probe = options.probe || (() => probeDaemon({ port, timeoutMs: healthTimeoutMs }));
  const signalProcess = options.signalProcess || process.kill;
  // SIGTERM on every platform. `process.kill` goes through libuv's uv_kill, which on Windows accepts
  // only SIGTERM/SIGKILL/SIGINT (plus 0 for liveness) and rejects everything else with ENOSYS —
  // measured: process.kill(pid, 'SIGBREAK') throws ENOSYS on win32. SIGBREAK is deliverable ONLY as a
  // CTRL_BREAK_EVENT to one's own process group (that is how bench/zonoid_bench/daemon.py stops a
  // daemon it started, and why daemon.js still listens for it), never from an unrelated launcher such
  // as this one. Sending it here made EVERY Windows handoff fail closed at `stale_daemon_signal_failed`,
  // so a stale daemon could never be retired. SIGTERM is graceful on POSIX and maps to TerminateProcess
  // on Windows, which releases the port — exactly the condition the shutdown poll below waits for.
  const gracefulSignal = options.gracefulSignal || 'SIGTERM';
  const isProcessAlive = options.isProcessAlive || ((pid) => processAlive(pid, signalProcess));
  const spawnDaemon = options.spawnDaemon || ((spawnOptions) => spawnDetachedDaemon(spawnOptions));
  const acquireLock = options.acquireLock || (() => acquireLaunchLock(lockFile, { now, isProcessAlive }));

  const current = (observation) => observation && observation.identified && identityMatches(observation, expected);
  let observation = await probe();
  if (current(observation) && observation.ready) return { ok: true, action: 'reused', identity: observation };
  if (observation.reachable && !observation.identified) {
    return { ok: false, action: 'failed', reason: 'unrelated_listener' };
  }

  // A matching build that is still loading already owns the port. Wait for it; never spawn a
  // duplicate merely because boot work temporarily makes readiness lag behind reachability.
  if (current(observation)) {
    const deadline = now() + startupTimeoutMs;
    while (now() < deadline) {
      await sleep(pollMs);
      observation = await probe();
      if (current(observation) && observation.ready) return { ok: true, action: 'reused', identity: observation };
      if (!observation.reachable || !current(observation)) break;
    }
    if (current(observation)) return { ok: false, action: 'failed', reason: 'current_daemon_startup_timeout' };
  }

  // Serialize all stale-owner retirement and cold startup. Contenders that lose this lock only
  // observe and join the winner; they never signal or spawn a second daemon.
  const lockDeadline = now() + startupTimeoutMs;
  let lock = null;
  while (!lock && now() < lockDeadline) {
    lock = acquireLock();
    if (lock) break;
    await sleep(pollMs);
    observation = await probe();
    if (current(observation) && observation.ready) return { ok: true, action: 'joined', identity: observation };
    if (observation.reachable && !observation.identified) {
      return { ok: false, action: 'failed', reason: 'unrelated_listener' };
    }
  }
  if (!lock) return { ok: false, action: 'failed', reason: 'launch_lock_timeout' };

  let spawnedChild = null;
  let replacing = false;
  try {
    // State may have changed while this contender waited for the lock.
    observation = await probe();
    if (current(observation) && observation.ready) return { ok: true, action: 'joined', identity: observation };
    if (observation.reachable && !observation.identified) {
      return { ok: false, action: 'failed', reason: 'unrelated_listener' };
    }

    if (observation.reachable && observation.identified && !current(observation)) {
      const pid = ownedDaemonPid(observation, { pidFile, isProcessAlive, signalProcess });
      if (!pid) return { ok: false, action: 'failed', reason: 'stale_daemon_unowned' };
      try {
        signalProcess(pid, gracefulSignal);
      } catch (error) {
        if (!error || error.code !== 'ESRCH') {
          return { ok: false, action: 'failed', reason: 'stale_daemon_signal_failed' };
        }
      }
      replacing = true;

      const shutdownDeadline = now() + handoffTimeoutMs;
      while (now() < shutdownDeadline) {
        await sleep(pollMs);
        observation = await probe();
        if (!observation.reachable) break;
        if (current(observation) && observation.ready) {
          return { ok: true, action: 'joined', identity: observation };
        }
        if (!observation.identified) {
          return { ok: false, action: 'failed', reason: 'unrelated_listener_during_handoff' };
        }
      }
      if (observation.reachable) {
        return { ok: false, action: 'failed', reason: 'stale_daemon_shutdown_timeout' };
      }
    }

    const daemonEnv = { ...process.env, ...(options.env || {}), ORCH_PORT: String(port) };
    try {
      spawnedChild = spawnDaemon({ daemonPath, env: daemonEnv, port });
    } catch {
      return { ok: false, action: 'failed', reason: 'daemon_spawn_failed' };
    }

    const readyDeadline = now() + startupTimeoutMs;
    while (now() < readyDeadline) {
      await sleep(pollMs);
      observation = await probe();
      if (current(observation) && observation.ready) {
        return { ok: true, action: replacing ? 'replaced' : 'started', identity: observation };
      }
      if (observation.reachable && !observation.identified) {
        await terminateSpawnedChild(spawnedChild, childCleanupGraceMs);
        return { ok: false, action: 'failed', reason: 'unrelated_listener_after_spawn' };
      }
    }
    await terminateSpawnedChild(spawnedChild, childCleanupGraceMs);
    return { ok: false, action: 'failed', reason: 'daemon_startup_timeout' };
  } finally {
    lock.release();
  }
}

module.exports = {
  HEALTH_SIGNATURE,
  expectedDaemonIdentity,
  requestJson,
  probeDaemon,
  identityMatches,
  ownedDaemonPid,
  acquireLaunchLock,
  terminateSpawnedChild,
  ensureCurrentDaemon,
};
