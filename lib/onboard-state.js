'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { readStableRegularFile } = require('./onboard-paths');

const STATUS_FILE = 'onboard-drain-status.json';
const INJECTION_RECEIPT_FILE = 'onboard-injection-receipt.json';
const PUBLICATION_INTENT_FILE = 'onboard-publication-intent.json';
const PUBLICATION_INTENT_VERSION = 1;
const PUBLICATION_FILES = new Set([
  'onboard-queue.json',
  'structure.json',
  'git-notes.json',
  'doc-notes.json',
  'doc-structure.json',
  'asset-notes.json',
  'config-notes.json',
  'onboard-notes.json',
  INJECTION_RECEIPT_FILE,
]);
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
const PUBLICATION_INTENT_MAX_BYTES = 64 * 1024 * 1024;
const PUBLICATION_QUEUE_MAX_BYTES = 64 * 1024 * 1024;
const ONBOARD_STATUS_MAX_BYTES = 4 * 1024 * 1024;

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}

function readStableJSON(file, def, maxBytes) {
  let snapshot;
  try {
    snapshot = readStableRegularFile(file, maxBytes);
  } catch (error) {
    return { ok: false, value: def, error, reason: error && error.code || 'read_failed' };
  }
  if (!snapshot.ok) {
    return {
      ok: false,
      value: def,
      absent: snapshot.absent === true,
      unsafe: snapshot.unsafe === true,
      reason: snapshot.reason,
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(snapshot.bytes.toString('utf8').replace(/^\uFEFF/, '')),
      reason: null,
    };
  } catch (error) {
    return { ok: false, value: def, error, reason: 'invalid_json' };
  }
}

function readPublicationQueue(file) {
  return readStableJSON(file, null, PUBLICATION_QUEUE_MAX_BYTES);
}

function writeJSONAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function valueDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicationIntentFile(outDir) {
  return path.join(outDir, PUBLICATION_INTENT_FILE);
}

function publicationOperationDigest(generation, files) {
  return valueDigest({ generation, files });
}

function publicationBoundary(name, detail, options = {}) {
  if (process.env.ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER === name) process.exit(87);
  if (typeof options.onBoundary === 'function') options.onBoundary(name, detail);
}

function publicationIntentPayload(intent) {
  return {
    version: intent.version,
    id: intent.id,
    generation: intent.generation,
    expectedStatusDigest: intent.expectedStatusDigest,
    expectedPreparationGeneration: intent.expectedPreparationGeneration || null,
    expectedPreparationOwner: intent.expectedPreparationOwner || null,
    desiredStatus: intent.desiredStatus,
    files: intent.files,
    cleanupDirs: intent.cleanupDirs || [],
    createdAt: intent.createdAt,
  };
}

function validatePublicationIntent(intent) {
  if (!intent || intent.version !== PUBLICATION_INTENT_VERSION
      || !/^[a-f0-9]{32}$/.test(String(intent.id || ''))
      || typeof intent.generation !== 'string' || !intent.generation.trim()
      || !/^[a-f0-9]{64}$/.test(String(intent.expectedStatusDigest || ''))
      || !intent.desiredStatus || typeof intent.desiredStatus !== 'object' || Array.isArray(intent.desiredStatus)
      || !intent.files || typeof intent.files !== 'object' || Array.isArray(intent.files)
      || !Number.isFinite(Date.parse(intent.createdAt))
      || !/^[a-f0-9]{64}$/.test(String(intent.intentDigest || ''))
      || valueDigest(publicationIntentPayload(intent)) !== intent.intentDigest) {
    throw new Error('invalid onboarding publication intent');
  }
  const names = Object.keys(intent.files);
  if (!names.includes('onboard-queue.json') || names.some((name) => !PUBLICATION_FILES.has(name))) {
    throw new Error('invalid onboarding publication file set');
  }
  for (const [name, value] of Object.entries(intent.files)) {
    if (value !== null && (!value || typeof value !== 'object')) {
      throw new Error(`invalid onboarding publication value for ${name}`);
    }
  }
  if (!Array.isArray(intent.cleanupDirs)
      || intent.cleanupDirs.some((name) => typeof name !== 'string'
        || !/^\.prepare-\d+-\d+$/.test(name) || path.basename(name) !== name)) {
    throw new Error('invalid onboarding publication cleanup directories');
  }
  const queue = intent.files['onboard-queue.json'];
  if (!validateOnboardQueue(queue, { expectedGeneration: intent.generation }).ok
      || intent.desiredStatus.preparationState !== 'ready'
      || intent.desiredStatus.queueGeneration !== intent.generation
      || intent.desiredStatus.injectionGeneration !== intent.generation) {
    throw new Error('invalid onboarding publication generation invariant');
  }
  return intent;
}

function makePublicationIntent({ generation, expectedStatus, desiredStatus, files, cleanupDirs = [] }) {
  const intent = {
    version: PUBLICATION_INTENT_VERSION,
    id: crypto.randomBytes(16).toString('hex'),
    generation,
    expectedStatusDigest: valueDigest(expectedStatus || {}),
    expectedPreparationGeneration: expectedStatus && expectedStatus.preparationGeneration || null,
    expectedPreparationOwner: expectedStatus && expectedStatus.preparationOwner || null,
    desiredStatus,
    files,
    cleanupDirs: cleanupDirs.map((dir) => path.basename(dir)),
    createdAt: new Date().toISOString(),
  };
  intent.intentDigest = valueDigest(publicationIntentPayload(intent));
  return validatePublicationIntent(intent);
}

function writePublicationJSON(file, value, intent, options = {}) {
  const tmp = `${file}.publish-${intent.id}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  publicationBoundary(`${path.basename(file)}_temp`, { file, tmp, intent }, options);
  fs.renameSync(tmp, file);
  publicationBoundary(path.basename(file), { file, intent }, options);
}

function writePublicationIntent(outDir, intent, options = {}) {
  const file = publicationIntentFile(outDir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(intent, null, 2) + '\n');
  publicationBoundary('journal_temp', { file, tmp, intent }, options);
  fs.renameSync(tmp, file);
  publicationBoundary('journal', { file, intent }, options);
}

function cleanupPublicationTemps(outDir, intentId = null) {
  let names = [];
  try { names = fs.readdirSync(outDir); } catch { return; }
  const journalPattern = /^onboard-publication-intent\.json\.\d+\.[a-f0-9]+\.tmp$/;
  const publicationPattern = intentId
    ? new RegExp(`^(?:${Array.from(PUBLICATION_FILES).join('|').replace(/\./g, '\\.')}|${STATUS_FILE.replace(/\./g, '\\.')})\\.publish-${intentId}\\.tmp$`)
    : /^(?:onboard-queue\.json|structure\.json|git-notes\.json|doc-notes\.json|doc-structure\.json|asset-notes\.json|config-notes\.json|onboard-notes\.json|onboard-injection-receipt\.json|onboard-drain-status\.json)\.publish-[a-f0-9]{32}\.tmp$/;
  const invalidStatusPattern = /^onboard-drain-status\.json\.invalid-\d+-[a-f0-9]+\.tmp$/;
  for (const name of names) {
    if (!journalPattern.test(name) && !publicationPattern.test(name)
        && !invalidStatusPattern.test(name)) continue;
    try { fs.unlinkSync(path.join(outDir, name)); } catch { /* retry on the next reconciliation */ }
  }
}

function cleanupPublicationDirs(outDir, intent) {
  for (const name of intent.cleanupDirs || []) {
    const dir = path.join(outDir, name);
    let stat;
    try { stat = fs.lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const marker = readJSON(path.join(dir, '.onboard-preparation.json'), null);
    if (!marker || marker.generation !== intent.generation
        || (intent.expectedPreparationOwner && marker.owner !== intent.expectedPreparationOwner)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* journal remains retryable */ }
  }
}

function publicationResult(intent, result) {
  return {
    ...result,
    generation: intent.generation,
    intentId: intent.id,
    intentDigest: intent.intentDigest,
    operationDigest: publicationOperationDigest(intent.generation, intent.files),
  };
}

function recoveredPublicationMatches(result, generation, files) {
  return !!result && result.settled === 'committed'
    && result.generation === generation
    && /^[a-f0-9]{32}$/.test(String(result.intentId || ''))
    && /^[a-f0-9]{64}$/.test(String(result.intentDigest || ''))
    && result.operationDigest === publicationOperationDigest(generation, files);
}

function readPublicationIntent(file) {
  const persisted = readStableJSON(file, null, PUBLICATION_INTENT_MAX_BYTES);
  if (persisted.absent) return { exists: false, raw: null, error: null };
  if (!persisted.ok) {
    return {
      exists: true,
      raw: null,
      error: persisted.error || new Error(
        `unsafe onboarding publication intent (${persisted.reason || 'unstable_file'})`
      ),
    };
  }
  return { exists: true, raw: persisted.value, error: null };
}

function quarantineInvalidPublicationLocked(outDir, reason, options = {}) {
  const file = publicationIntentFile(outDir);
  const currentStatus = readOnboardStatus(outDir);
  const queueFile = path.join(outDir, 'onboard-queue.json');
  const queueRead = readPublicationQueue(queueFile);
  const currentQueue = queueRead.value;
  const validatedQueue = validateOnboardQueue(currentQueue);
  const currentGenerationSafe = queueRead.ok && validatedQueue.ok
    && currentStatus.preparationState === 'ready'
    && currentStatus.queueGeneration === validatedQueue.generation
    && currentStatus.injectionGeneration === validatedQueue.generation;
  const quarantineSuffix = `invalid-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const quarantine = `${file}.${quarantineSuffix}`;

  // The invalid journal is the fail-closed fence: while it remains canonical every route/headless
  // discovery pass must reconcile before it may consume a queue. Move an unsafe queue first, then
  // durably publish a safe pending/failed status, and move the poison journal only after both have
  // succeeded. Any error therefore leaves the fence in place for the next daemon/retry pass.
  if (!currentGenerationSafe) {
    publicationBoundary('invalid_queue_quarantine', { file: queueFile, reason }, options);
    try { fs.renameSync(queueFile, `${queueFile}.${quarantineSuffix}`); } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const retryPreparation = typeof currentStatus.preparationGeneration === 'string'
      && currentStatus.preparationGeneration.trim();
    const error = `invalid onboarding publication intent quarantined: ${reason}`;
    const safeStatus = {
      ...currentStatus,
      preparationState: retryPreparation ? 'pending' : 'failed',
      preparationStage: null,
      preparationOwner: null,
      preparationPid: null,
      preparationLeaseExpiresAt: null,
      queueGeneration: null,
      injectionGeneration: null,
      injectionState: 'idle',
      injectionOwner: null,
      injectionPid: null,
      injectionProcessIdentity: null,
      injectionLeaseExpiresAt: null,
      injectionCancelRequestedOwner: null,
      injectionCancelRequestedAt: null,
      injecting: false,
      injected: false,
      injectedGeneration: null,
      injectedAt: null,
      injectedKept: 0,
      error,
      lastError: error,
      publicationRecoveryAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const safeStatusFile = statusFile(outDir);
    const statusTmp = `${safeStatusFile}.${quarantineSuffix}.tmp`;
    publicationBoundary('invalid_status_temp', { file: safeStatusFile, tmp: statusTmp, reason }, options);
    fs.writeFileSync(statusTmp, JSON.stringify(safeStatus, null, 2) + '\n');
    publicationBoundary('invalid_status_commit', { file: safeStatusFile, tmp: statusTmp, reason }, options);
    fs.renameSync(statusTmp, safeStatusFile);
  }

  publicationBoundary('invalid_journal_quarantine', { file, quarantine, reason }, options);
  fs.renameSync(file, quarantine);
  cleanupPublicationTemps(outDir);
  return {
    ok: true,
    settled: 'invalid_quarantined',
    hadIntent: true,
    quarantined: true,
    quarantine,
    reprepare: !currentGenerationSafe && !!currentStatus.preparationGeneration,
  };
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

// A PID alone is not an owner identity: after a crash the OS may reuse it for an unrelated
// process. Persist a kernel/process-table start token with every new injection claim so recovery
// can distinguish the original writer from a reused PID. Platforms without a usable start token
// deliberately return null; callers then preserve legacy safety by treating a still-live PID as
// authoritative until it exits.
function processIncarnation(pid, options = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || !pidAlive(n)) return null;
  const platform = options.platform || process.platform;
  const readFileSync = options.readFileSync || fs.readFileSync.bind(fs);
  const execFileSync = options.execFileSync || require('child_process').execFileSync;
  try {
    if (platform === 'linux') {
      const raw = String(readFileSync(`/proc/${n}/stat`, 'utf8'));
      const close = raw.lastIndexOf(')');
      if (close < 0) return null;
      // Fields after the command begin at proc field 3; starttime is field 22 (index 19 here).
      const startTicks = raw.slice(close + 1).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(startTicks || '')) return null;
      let bootId = '';
      try { bootId = String(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch { /* optional */ }
      return `linux:${bootId || 'boot'}:${n}:${startTicks}`;
    }
    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
      const started = String(execFileSync('ps', ['-o', 'lstart=', '-p', String(n)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      })).trim().replace(/\s+/g, ' ');
      return started ? `${platform}:${n}:${started}` : null;
    }
    if (platform === 'win32') {
      const script = `(Get-Process -Id ${n} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const ticks = String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      })).trim();
      return /^\d+$/.test(ticks) ? `win32:${n}:${ticks}` : null;
    }
  } catch { return null; }
  return null;
}

function liveOnboardInjectionLease(meta, now = Date.now(), options = {}) {
  if (!meta || (meta.injectionState !== 'running' && meta.injecting !== true)) {
    return { live: false, expiresAt: null, retryAt: null, ownerAlive: false, identityMatches: false };
  }
  const expiresAt = Math.max(0, Number(meta.injectionLeaseExpiresAt) || 0);
  // A route claim persists its owner before the child pid is available. During that short window the
  // unexpired owner/lease is still authoritative and another daemon must not replace it.
  if (!meta.injectionPid) {
    const live = !!meta.injectionOwner && (expiresAt > now || !expiresAt);
    return {
      live,
      expiresAt: expiresAt || null,
      retryAt: expiresAt > now ? expiresAt : null,
      ownerAlive: live,
      identityMatches: live,
    };
  }
  const ownerAlive = pidAlive(meta.injectionPid);
  const expectedIdentity = typeof meta.injectionProcessIdentity === 'string'
    && meta.injectionProcessIdentity ? meta.injectionProcessIdentity : null;
  const currentIdentity = ownerAlive
    ? (options.processIncarnation || processIncarnation)(meta.injectionPid, options)
    : null;
  // New claims compare an exact process incarnation, so a reused PID never inherits ownership.
  // Legacy claims have no start token; fail closed while that PID is alive because reclaiming it
  // on wall-clock age could let its still-running injector write a stale graph note.
  const identityMatches = ownerAlive
    && (!expectedIdentity || !currentIdentity || currentIdentity === expectedIdentity);
  return {
    live: identityMatches,
    expiresAt: expiresAt || null,
    retryAt: identityMatches && expiresAt <= now ? null : (expiresAt || null),
    ownerAlive,
    identityMatches,
    expired: !!expiresAt && expiresAt <= now,
  };
}

function liveOnboardPreparationLease(meta, now = Date.now()) {
  if (!meta || meta.preparationState !== 'running') {
    return { live: false, expiresAt: null };
  }
  const expiresAt = Math.max(0, Number(meta.preparationLeaseExpiresAt) || 0);
  const live = pidAlive(meta.preparationPid) && expiresAt > now;
  return { live, expiresAt: expiresAt || null };
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function lockSnapshot(file, fsImpl = fs) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, 'r');
    const before = fsImpl.fstatSync(fd);
    const raw = fsImpl.readFileSync(fd, 'utf8');
    const after = fsImpl.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    return {
      raw,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } catch { return null; }
  finally { if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } } }
}

function sameLockSnapshot(a, b) {
  return !!a && !!b && a.raw === b.raw && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function lockOwner(snapshot) {
  try {
    const parsed = JSON.parse(snapshot.raw);
    if (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.pid) || parsed.pid <= 0
        || typeof parsed.owner !== 'string' || !parsed.owner) return null;
    return {
      pid: parsed.pid,
      owner: parsed.owner,
      processIncarnation: typeof parsed.processIncarnation === 'string' && parsed.processIncarnation
        ? parsed.processIncarnation
        : null,
    };
  } catch { return null; }
}

function lockOwnerAlive(owner, options = {}) {
  if (!owner) return false;
  const isPidAlive = options.pidAlive || pidAlive;
  if (!isPidAlive(owner.pid)) return false;
  // Legacy/tokenless owner records remain fail-closed while their PID is live. For a new record,
  // a different observable process incarnation proves PID reuse and makes the dead lock reclaimable.
  // If this platform cannot read the current incarnation, preserve the same fail-closed posture.
  if (!owner.processIncarnation) return true;
  const current = (options.processIncarnation || processIncarnation)(owner.pid, options);
  return !current || current === owner.processIncarnation;
}

function removeEmptyDir(dir, fsImpl) {
  try { fsImpl.rmdirSync(dir); } catch (err) {
    if (!err || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
  }
}

function recoverLegacyLock(lock, fsImpl, staleMs, options = {}) {
  const incumbent = lockSnapshot(lock, fsImpl);
  const incumbentOwner = incumbent && lockOwner(incumbent);
  const stale = !!incumbent && Date.now() - incumbent.mtimeMs > staleMs;
  // A well-formed exact live owner remains authoritative regardless of mtime. Age is only evidence
  // for malformed create-before-owner-write debris; a valid record is reclaimed after owner death
  // or when the PID now names a different observable process incarnation.
  if (incumbentOwner ? lockOwnerAlive(incumbentOwner, options) : !stale) return false;
  const latest = lockSnapshot(lock, fsImpl);
  if (!sameLockSnapshot(incumbent, latest)) return false;
  try {
    fsImpl.unlinkSync(lock);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    throw err;
  }
}

function recoverHeldLock(held, fsImpl, staleMs, options = {}) {
  let stat;
  let names;
  try {
    stat = fsImpl.statSync(held);
    names = fsImpl.readdirSync(held);
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    return false;
  }
  if (!stat.isDirectory()) return false;
  if (names.length === 0) {
    if (Date.now() - stat.mtimeMs <= staleMs) return false;
    removeEmptyDir(held, fsImpl);
    return true;
  }
  if (names.length !== 1 || !/^owner-[a-f0-9]{32}\.json$/.test(names[0])) return false;
  const ownerFile = path.join(held, names[0]);
  const snapshot = lockSnapshot(ownerFile, fsImpl);
  const incumbentOwner = snapshot && lockOwner(snapshot);
  const stale = !!snapshot && Date.now() - snapshot.mtimeMs > staleMs;
  // A valid exact live owner remains authoritative however long its synchronous critical section
  // takes; dead or reused-PID owners are reclaimed. Staleness is solely the recovery clock for
  // malformed records left during create-before-owner-write.
  if (incumbentOwner ? lockOwnerAlive(incumbentOwner, options) : !stale) return false;
  const latest = lockSnapshot(ownerFile, fsImpl);
  if (!sameLockSnapshot(snapshot, latest)) return false;
  try { fsImpl.unlinkSync(ownerFile); } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    return true;
  }
  // `held` cannot be replaced until it is removed. If another actor already removed this exact
  // owner, our unique owner pathname is absent and we deliberately do not touch the directory.
  removeEmptyDir(held, fsImpl);
  return true;
}

// The lock root is a directory and acquisition is the atomic creation of its `held` child.
// Ownership lives at a random, unique pathname inside `held`. Release and stale recovery first
// remove only that exact pathname and only then attempt rmdir, so an older owner can never unlink a
// replacement owner, including when replacement happens between any two cleanup operations.
function withFileLock(file, fn, opts = {}) {
  if (!file || typeof file !== 'string') throw new Error('onboarding state lock: file is required');
  const fsImpl = opts.fsImpl || fs;
  const lock = `${file}.lock`;
  const owner = crypto.randomBytes(16).toString('hex');
  const held = path.join(lock, 'held');
  const ownerFile = path.join(held, `owner-${owner}.json`);
  const waitMs = Math.max(0, opts.waitMs == null ? LOCK_WAIT_MS : (Number(opts.waitMs) || 0));
  const staleMs = Math.max(1, opts.staleMs == null ? LOCK_STALE_MS : (Number(opts.staleMs) || 0));
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  let acquired = false;
  while (!acquired) {
    try {
      try { fsImpl.mkdirSync(lock); } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        let lockStat;
        try { lockStat = fsImpl.statSync(lock); } catch { lockStat = null; }
        if (!lockStat || !lockStat.isDirectory()) {
          if (recoverLegacyLock(lock, fsImpl, staleMs, opts)) continue;
          throw Object.assign(new Error('legacy onboarding lock is still owned'), { code: 'EEXIST' });
        }
      }
      try { fsImpl.mkdirSync(held); } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        if (recoverHeldLock(held, fsImpl, staleMs, opts)) continue;
        throw err;
      }
      let claimedFd = null;
      try {
        const observedIncarnation = (opts.processIncarnation || processIncarnation)(process.pid, opts);
        const ownerIncarnation = typeof observedIncarnation === 'string' && observedIncarnation
          ? observedIncarnation
          : null;
        claimedFd = fsImpl.openSync(ownerFile, 'wx');
        fsImpl.writeFileSync(claimedFd, JSON.stringify({
          pid: process.pid,
          processIncarnation: ownerIncarnation,
          owner,
          at: Date.now(),
        }));
        fsImpl.closeSync(claimedFd);
        claimedFd = null;
        const claimed = lockSnapshot(ownerFile, fsImpl);
        const recorded = claimed && lockOwner(claimed);
        if (!recorded || recorded.pid !== process.pid || recorded.owner !== owner
            || recorded.processIncarnation !== ownerIncarnation) {
          throw new Error('onboarding state lock owner record was replaced');
        }
      } catch (writeErr) {
        if (claimedFd != null) { try { fsImpl.closeSync(claimedFd); } catch { /* ignore */ } }
        try { fsImpl.unlinkSync(ownerFile); } catch { /* preserve write error */ }
        removeEmptyDir(held, fsImpl);
        removeEmptyDir(lock, fsImpl);
        throw writeErr;
      }
      acquired = true;
    } catch (err) {
      // The previous owner may remove the now-empty root between our EEXIST observation and held
      // creation. That is a normal hand-off boundary: retry from root creation.
      if (err && err.code === 'ENOENT') {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for onboarding state lock ${lock}`);
        continue;
      }
      if (!err || err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for onboarding state lock ${lock}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    let removedOwnRecord = false;
    try { fsImpl.unlinkSync(ownerFile); removedOwnRecord = true; } catch { /* reclaimed or already removed */ }
    if (removedOwnRecord) removeEmptyDir(held, fsImpl);
    removeEmptyDir(lock, fsImpl);
  }
}

function mutateJSONAtomic(file, def, mutator) {
  return withFileLock(file, () => {
    const previous = readJSON(file, def);
    const next = mutator(previous);
    if (next === undefined) return { applied: false, value: previous };
    writeJSONAtomic(file, next);
    return { applied: true, value: next };
  });
}

function statusFile(outDir) {
  return path.join(outDir, STATUS_FILE);
}

function readOnboardStatus(outDir) {
  return readStableJSON(statusFile(outDir), {}, ONBOARD_STATUS_MAX_BYTES).value || {};
}

function mutateOnboardStatus(outDir, mutator) {
  return mutateJSONAtomic(statusFile(outDir), {}, (previous) => {
    const next = mutator(previous || {});
    return next === undefined ? undefined : { ...next, updatedAt: new Date().toISOString() };
  });
}

function patchOnboardStatus(outDir, patch) {
  return mutateOnboardStatus(outDir, (previous) => ({ ...previous, ...patch }));
}

function statusAcceptsPublication(status, intent) {
  return !!status && status.preparationState === 'ready'
    && status.queueGeneration === intent.generation
    && status.injectionGeneration === intent.generation;
}

function cleanupPublicationIntent(outDir, intent, options = {}) {
  cleanupPublicationTemps(outDir, intent.id);
  cleanupPublicationDirs(outDir, intent);
  const remainingDir = (intent.cleanupDirs || []).some((name) => {
    try { return fs.existsSync(path.join(outDir, name)); } catch { return true; }
  });
  if (remainingDir) return { cleanupPending: true };
  publicationBoundary('before_journal_cleanup', { intent }, options);
  try {
    fs.unlinkSync(publicationIntentFile(outDir));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return { cleanupPending: true, cleanupError: err };
  }
  publicationBoundary('journal_cleanup', { intent }, options);
  return { cleanupPending: false };
}

function applyPublicationIntentLocked(outDir, intent, options = {}) {
  const currentStatus = readOnboardStatus(outDir);
  const currentQueue = readPublicationQueue(path.join(outDir, 'onboard-queue.json')).value;
  if (statusAcceptsPublication(currentStatus, intent)
      && validateOnboardQueue(currentQueue, { expectedGeneration: intent.generation }).ok) {
    const cleanup = cleanupPublicationIntent(outDir, intent, options);
    return publicationResult(intent, { ok: true, settled: 'committed', ...cleanup });
  }

  const exactStatus = valueDigest(currentStatus || {}) === intent.expectedStatusDigest;
  const ownedPreparation = !!intent.expectedPreparationGeneration
    && currentStatus.preparationGeneration === intent.expectedPreparationGeneration
    && currentStatus.preparationOwner === intent.expectedPreparationOwner;
  if (!exactStatus && !ownedPreparation) {
    const cleanup = cleanupPublicationIntent(outDir, intent, options);
    return publicationResult(intent, { ok: true, settled: 'abandoned', ...cleanup });
  }

  // Artifacts become durable before the queue, and status is always last. A consumer either keeps
  // using the prior status/queue or, after reconciliation, observes the complete new generation.
  const orderedNames = Object.keys(intent.files)
    .filter((name) => name !== 'onboard-queue.json')
    .concat('onboard-queue.json');
  for (const name of orderedNames) {
    const file = path.join(outDir, name);
    const value = intent.files[name];
    if (value === null) {
      try { fs.unlinkSync(file); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
      publicationBoundary(`${name}_removed`, { file, intent }, options);
    } else {
      writePublicationJSON(file, value, intent, options);
    }
  }
  writePublicationJSON(statusFile(outDir), intent.desiredStatus, intent, options);

  const committedStatus = readOnboardStatus(outDir);
  const committedQueue = readPublicationQueue(path.join(outDir, 'onboard-queue.json')).value;
  if (!statusAcceptsPublication(committedStatus, intent)
      || !validateOnboardQueue(committedQueue, { expectedGeneration: intent.generation }).ok) {
    throw new Error('onboarding publication did not commit its generation');
  }
  const cleanup = cleanupPublicationIntent(outDir, intent, options);
  return publicationResult(intent, { ok: true, settled: 'committed', ...cleanup });
}

function reconcilePublicationLocked(outDir, options = {}) {
  const file = publicationIntentFile(outDir);
  const persisted = readPublicationIntent(file);
  if (!persisted.exists) {
    cleanupPublicationTemps(outDir);
    return { ok: true, settled: 'none', hadIntent: false };
  }
  let intent;
  try {
    if (persisted.error) throw persisted.error;
    intent = validatePublicationIntent(persisted.raw);
  } catch (err) {
    try {
      return quarantineInvalidPublicationLocked(
        outDir, err && err.message ? err.message : String(err), options
      );
    } catch (quarantineError) {
      return {
        ok: false,
        settled: 'invalid',
        hadIntent: true,
        error: `could not quarantine invalid onboarding publication intent: ${quarantineError && quarantineError.message ? quarantineError.message : quarantineError}`,
      };
    }
  }
  try {
    return { ...applyPublicationIntentLocked(outDir, intent, options), hadIntent: true };
  } catch (err) {
    cleanupPublicationTemps(outDir, intent.id);
    return { ok: false, settled: 'pending', hadIntent: true, generation: intent.generation, error: err.message };
  }
}

function reconcileOnboardPublication(outDir, options = {}) {
  const resolvedOutDir = path.resolve(outDir);
  if (!fs.existsSync(resolvedOutDir)) return { ok: true, settled: 'none', hadIntent: false };
  const queueFile = path.join(resolvedOutDir, 'onboard-queue.json');
  return withFileLock(queueFile, () => withFileLock(statusFile(resolvedOutDir), () => (
    reconcilePublicationLocked(resolvedOutDir, options)
  )));
}

function publicationFiles(queue, files = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(files)) {
    if (!PUBLICATION_FILES.has(name) || name === 'onboard-queue.json') {
      throw new Error(`unsupported onboarding publication file ${name}`);
    }
    normalized[name] = value;
  }
  normalized['onboard-queue.json'] = queue;
  return normalized;
}

function publishOnboardGeneration({ outDir, queue, files = {}, statusMutator, cleanupDirs = [] }, options = {}) {
  const resolvedOutDir = path.resolve(outDir);
  const validated = validateOnboardQueue(queue);
  if (!validated.ok) throw new Error(`cannot publish invalid onboarding queue (${validated.reason})`);
  if (typeof statusMutator !== 'function') throw new Error('onboarding publication status mutator is required');
  const queueFile = path.join(resolvedOutDir, 'onboard-queue.json');
  const requestedFiles = publicationFiles(queue, files);

  return withFileLock(queueFile, () => withFileLock(statusFile(resolvedOutDir), () => {
    const recovered = reconcilePublicationLocked(resolvedOutDir);
    if (!recovered.ok) throw new Error(`cannot reconcile onboarding publication (${recovered.error})`);
    // A command retry after a hard exit completes the already-journaled publication instead of
    // allocating another replacement generation for the same user action. Cleanup ownership alone
    // is not operation identity: a different generation must still publish even when unlinking the
    // previous committed journal is temporarily failing.
    if (recovered.hadIntent && recoveredPublicationMatches(
      recovered, validated.generation, requestedFiles
    )) {
      return { applied: true, recovered: true, generation: recovered.generation, reconciliationPending: recovered.cleanupPending === true };
    }

    const previous = readOnboardStatus(resolvedOutDir);
    const next = statusMutator(previous || {});
    if (next === undefined) return { applied: false, stale: true };
    const desiredStatus = { ...next, updatedAt: new Date().toISOString() };
    const intent = makePublicationIntent({
      generation: validated.generation,
      expectedStatus: previous || {},
      desiredStatus,
      files: requestedFiles,
      cleanupDirs,
    });

    try {
      writePublicationIntent(resolvedOutDir, intent, options);
      const committed = applyPublicationIntentLocked(resolvedOutDir, intent, options);
      return {
        applied: committed.settled === 'committed',
        generation: intent.generation,
        reconciliationPending: committed.cleanupPending === true,
      };
    } catch (err) {
      // A one-shot filesystem failure is repaired synchronously. If the desired queue/status pair
      // is already committed (including a cleanup-only failure), the caller receives success.
      const retried = reconcilePublicationLocked(resolvedOutDir);
      if (retried.ok && recoveredPublicationMatches(retried, intent.generation, intent.files)
          && retried.intentId === intent.id && retried.intentDigest === intent.intentDigest) {
        return {
          applied: true,
          recovered: true,
          generation: intent.generation,
          reconciliationPending: retried.cleanupPending === true,
        };
      }
      const currentStatus = readOnboardStatus(resolvedOutDir);
      const currentQueue = readPublicationQueue(queueFile).value;
      if (statusAcceptsPublication(currentStatus, intent)
          && validateOnboardQueue(currentQueue, { expectedGeneration: intent.generation }).ok) {
        return { applied: true, recovered: true, generation: intent.generation, reconciliationPending: true };
      }
      // The queue is the final data file and status is the only later commit boundary. Once the
      // journal and exact new queue are durable, the replacement is accepted even if a persistent
      // status rename failure needs the next daemon/discovery pass to finish it. Reporting failure
      // here would cause callers to enqueue a duplicate generation despite a recoverable commit.
      const pendingRead = readPublicationIntent(publicationIntentFile(resolvedOutDir));
      let pendingIntent = pendingRead.exists && !pendingRead.error ? pendingRead.raw : null;
      try { pendingIntent = validatePublicationIntent(pendingIntent); } catch { pendingIntent = null; }
      if (pendingIntent && pendingIntent.id === intent.id
          && validateOnboardQueue(currentQueue, { expectedGeneration: intent.generation }).ok) {
        return { applied: true, recovered: true, generation: intent.generation, reconciliationPending: true };
      }
      throw err;
    }
  }));
}

function onboardQueueGeneration(queue) {
  if (!queue || typeof queue !== 'object') return null;
  if (typeof queue.generation === 'string' && queue.generation.trim()) return queue.generation.trim();
  const stable = JSON.stringify({
    total: Number(queue.total) || 0,
    pending: Array.isArray(queue.pending) ? queue.pending : [],
  });
  return `legacy-${crypto.createHash('sha1').update(stable).digest('hex')}`;
}

function validateOnboardQueue(queue, options = {}) {
  const invalid = (reason) => ({ ok: false, reason, queue, generation: null });
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return invalid('queue_not_object');
  if (!Number.isInteger(queue.total) || queue.total < 0) return invalid('invalid_total');
  if (!Number.isInteger(queue.cursor) || queue.cursor < 0 || queue.cursor > queue.total) {
    return invalid('invalid_cursor');
  }
  for (const field of ['pending', 'kept', 'rejected']) {
    if (!Array.isArray(queue[field])) return invalid(`invalid_${field}`);
  }
  const explicitGeneration = Object.prototype.hasOwnProperty.call(queue, 'generation');
  if (!explicitGeneration && options.allowLegacy !== true) return invalid('legacy_queue_requires_opt_in');
  // Every current writer classifies every processed candidate. Only an explicitly opted-in legacy
  // queue may omit old rejection rows; neither shape may claim more outcomes than its cursor.
  const outcomeCount = queue.kept.length + queue.rejected.length;
  if (outcomeCount > queue.cursor || (explicitGeneration && outcomeCount !== queue.cursor)) {
    return invalid('outcome_cursor_mismatch');
  }
  if (explicitGeneration
      && (typeof queue.generation !== 'string' || !queue.generation.trim())) {
    return invalid('invalid_generation');
  }
  const generation = onboardQueueGeneration(queue);
  if (!generation || (options.expectedGeneration && generation !== options.expectedGeneration)) {
    return invalid(options.expectedGeneration ? 'generation_replaced' : 'invalid_generation');
  }
  // A partial queue still indexes candidates by their original absolute position, so it must keep
  // the complete candidate vector. Completed legacy queues may retain it or compact it to [].
  if (queue.cursor < queue.total && queue.pending.length !== queue.total) {
    return invalid('invalid_pending_coverage');
  }
  if (queue.cursor < queue.total
      && queue.pending.some((candidate) => !candidate || typeof candidate !== 'object' || Array.isArray(candidate))) {
    return invalid('invalid_pending_candidate');
  }
  if (queue.cursor === queue.total && queue.pending.length !== 0 && queue.pending.length !== queue.total) {
    return invalid('invalid_pending_coverage');
  }

  const ranges = [];
  for (const field of ['inflight', 'completed']) {
    const entries = queue[field];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return invalid(`invalid_${field}`);
    for (const [startKey, entry] of Object.entries(entries)) {
      const start = Number(startKey);
      const count = entry && entry.count;
      if (!Number.isInteger(start) || String(start) !== startKey || start < queue.cursor
          || !Number.isInteger(count) || count <= 0 || start + count > queue.total) {
        return invalid(`invalid_${field}_range`);
      }
      if (field === 'inflight') {
        if (typeof entry.generation !== 'string' || entry.generation !== generation
            || typeof entry.reservationId !== 'string' || !entry.reservationId
            || !Number.isInteger(entry.pid) || entry.pid <= 0) {
          return invalid('invalid_inflight_owner');
        }
        if (!Number.isFinite(entry.startedAt) || entry.startedAt < 0
            || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= entry.startedAt) {
          return invalid('invalid_inflight_lease');
        }
      } else if (!Array.isArray(entry.kept) || !Array.isArray(entry.rejected)
          || entry.kept.length + entry.rejected.length !== count) {
        return invalid('invalid_completed_outcomes');
      } else {
        // Every explicit-generation writer retains the full reservation identity. The older
        // all-absent shape is compatible only when the queue itself is legacy and the caller opted
        // in; accepting it inside an explicit generation lets unauthenticated stale results flush.
        const hasIdentity = ['generation', 'reservationId', 'completedAt']
          .some((key) => Object.prototype.hasOwnProperty.call(entry, key));
        if ((!hasIdentity && explicitGeneration) || (hasIdentity && (entry.generation !== generation
            || typeof entry.reservationId !== 'string' || !entry.reservationId
            || !Number.isFinite(entry.completedAt) || entry.completedAt < 0))) {
          return invalid('invalid_completed_owner');
        }
      }
      ranges.push({ start, end: start + count });
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) return invalid('overlapping_queue_ranges');
  }
  return {
    ok: true,
    reason: null,
    queue,
    generation,
    total: queue.total,
    cursor: queue.cursor,
    remaining: queue.total - queue.cursor,
    complete: queue.cursor === queue.total,
  };
}

function canonicalOnboardNotes(queue, generation = onboardQueueGeneration(queue)) {
  const validated = validateOnboardQueue(queue, { expectedGeneration: generation, allowLegacy: true });
  if (!validated.ok) return null;
  return { generation, kept: queue.kept, rejected: queue.rejected };
}

function writeOnboardNotesArtifact(outDir, queue, generation = onboardQueueGeneration(queue)) {
  const artifact = canonicalOnboardNotes(queue, generation);
  if (!artifact) return null;
  writeJSONAtomic(path.join(outDir, 'onboard-notes.json'), artifact);
  return artifact;
}

function onboardNotesArtifactMatchesQueue(artifact, queue, generation = onboardQueueGeneration(queue), options = {}) {
  const validated = validateOnboardQueue(queue, { expectedGeneration: generation, allowLegacy: true });
  if (!validated.ok || !artifact || !generation || !queue
      || !Array.isArray(artifact.kept) || !Array.isArray(artifact.rejected)
      || !Array.isArray(queue.kept) || !Array.isArray(queue.rejected)) return false;
  const artifactGeneration = typeof artifact.generation === 'string' ? artifact.generation.trim() : null;
  const generationMatches = artifactGeneration === generation
    || (options.allowLegacy === true && !artifactGeneration);
  return generationMatches
    && isDeepStrictEqual(artifact.kept, queue.kept)
    && isDeepStrictEqual(artifact.rejected, queue.rejected);
}

// Read injection input while holding the queue lock used by learner reservations. A completed
// queue is the canonical crash journal, so its duplicate notes artifact may be rebuilt exactly.
// An incomplete queue is never used to invent data: only an already-exact legacy/current artifact
// is accepted until a learner batch publishes the next queue+artifact pair under this same lock.
function loadGenerationMatchedOnboardNotes(outDir, expectedGeneration) {
  const queueFile = path.join(outDir, 'onboard-queue.json');
  const notesFile = path.join(outDir, 'onboard-notes.json');
  return withFileLock(queueFile, () => {
    const queue = readJSON(queueFile, null);
    const validated = validateOnboardQueue(queue, { expectedGeneration, allowLegacy: true });
    const generation = validated.ok ? validated.generation : onboardQueueGeneration(queue);
    if (!validated.ok) {
      return {
        ok: false,
        stale: true,
        reason: validated.reason === 'generation_replaced' ? validated.reason : 'invalid_queue_artifact',
        generation,
        queue,
      };
    }

    let artifact = readJSON(notesFile, null);
    const artifactGeneration = artifact && typeof artifact.generation === 'string'
      ? artifact.generation.trim()
      : null;
    const exactCurrent = onboardNotesArtifactMatchesQueue(artifact, queue, generation);
    const exactLegacy = onboardNotesArtifactMatchesQueue(artifact, queue, generation, { allowLegacy: true });
    const complete = Number(queue.cursor) === Number(queue.total);

    if (complete && !exactCurrent) {
      artifact = writeOnboardNotesArtifact(outDir, queue, generation);
      return { ok: true, repaired: true, complete, generation, queue, artifact };
    }
    // Legacy partial artifacts predate the generation field. Exact queue contents make them safe
    // to consume during an upgrade, but corrupt/mismatched partial data must wait for the learner.
    if (!exactLegacy || (artifactGeneration && artifactGeneration !== generation)) {
      return { ok: false, stale: true, reason: 'artifact_not_generation_matched', generation, queue };
    }
    if (!exactCurrent) {
      artifact = writeOnboardNotesArtifact(outDir, queue, generation);
      return { ok: true, repaired: false, upgraded: true, complete, generation, queue, artifact };
    }
    return { ok: true, repaired: false, complete, generation, queue, artifact };
  });
}

function onboardNoteId(note, index) {
  const stable = JSON.stringify({
    index: Math.max(0, Number(index) || 0),
    title: String(note && note.title || ''),
    summary: String(note && note.summary || ''),
    kind: String(note && note.kind || ''),
    evidence: String(note && note.evidence || ''),
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function receiptFile(outDir) {
  return path.join(outDir, INJECTION_RECEIPT_FILE);
}

function writeInjectionReceipt(outDir, generation, confirmed) {
  const unique = Array.from(new Set(Array.isArray(confirmed) ? confirmed.filter(Boolean) : []));
  writeJSONAtomic(receiptFile(outDir), {
    generation,
    confirmed: unique,
    updatedAt: new Date().toISOString(),
  });
}

function confirmInjectedNote(outDir, generation, note, index) {
  const id = onboardNoteId(note, index);
  return mutateJSONAtomic(receiptFile(outDir), {}, (previous) => {
    const confirmed = previous && previous.generation === generation && Array.isArray(previous.confirmed)
      ? previous.confirmed.slice()
      : [];
    if (!confirmed.includes(id)) confirmed.push(id);
    return { generation, confirmed, updatedAt: new Date().toISOString() };
  });
}

function confirmedInjectedCount(outDir, generation, notes) {
  if (!generation) return 0;
  const receipt = readJSON(receiptFile(outDir), null);
  if (!receipt || receipt.generation !== generation || !Array.isArray(receipt.confirmed)) return 0;
  const confirmed = new Set(receipt.confirmed);
  return (Array.isArray(notes) ? notes : []).reduce(
    (count, note, index) => count + (confirmed.has(onboardNoteId(note, index)) ? 1 : 0),
    0
  );
}

module.exports = {
  STATUS_FILE,
  INJECTION_RECEIPT_FILE,
  PUBLICATION_INTENT_FILE,
  readJSON,
  writeJSONAtomic,
  pidAlive,
  processIncarnation,
  liveOnboardInjectionLease,
  liveOnboardPreparationLease,
  withFileLock,
  mutateJSONAtomic,
  statusFile,
  readOnboardStatus,
  mutateOnboardStatus,
  patchOnboardStatus,
  reconcileOnboardPublication,
  publishOnboardGeneration,
  onboardQueueGeneration,
  validateOnboardQueue,
  writeOnboardNotesArtifact,
  onboardNotesArtifactMatchesQueue,
  loadGenerationMatchedOnboardNotes,
  onboardNoteId,
  writeInjectionReceipt,
  confirmInjectedNote,
  confirmedInjectedCount,
};
