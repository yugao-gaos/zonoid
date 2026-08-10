'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const workspaceRegistry = require('./workspace-registry');
const {
  readJSON,
  writeJSONAtomic,
  withFileLock,
  statusFile,
} = require('./onboard-state');
const {
  resolveOnboardPaths,
  defaultOnboardOutDir,
  ensureOnboardRuntimeIgnored,
} = require('./onboard-paths');

const JOURNAL_DIRNAME = 'onboard-init-transactions';
const INTENT_VERSION = 2;
const SHA256_RE = /^[a-f0-9]{64}$/;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function journalDir(registryFile) {
  return path.join(path.dirname(registryFile), JOURNAL_DIRNAME);
}

function journalFile(registryFile, id) {
  return path.join(journalDir(registryFile), `${id}.json`);
}

function desiredStatusGeneration(status) {
  if (!status || typeof status !== 'object') return null;
  const candidate = ['pending', 'running'].includes(status.preparationState)
    ? status.preparationGeneration
    : (status.queueGeneration || status.preparationGeneration || status.injectionGeneration);
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function intentPayload(intent) {
  return {
    version: intent.version,
    id: intent.id,
    repo: intent.repo,
    outDir: intent.outDir,
    workspaceId: intent.workspaceId,
    beforeStatusDigest: intent.beforeStatusDigest,
    beforeStatusSnapshotDigest: intent.beforeStatusSnapshotDigest,
    desiredStatusDigest: intent.desiredStatusDigest,
    desiredStatus: intent.desiredStatus,
    ensureRuntimeIgnore: intent.ensureRuntimeIgnore,
    createdAt: intent.createdAt,
  };
}

function createIntent({ repo, outDir, workspaceId, beforeStatus, beforeStatusSnapshot, desiredStatus, ensureRuntimeIgnore = false }) {
  const id = crypto.randomBytes(16).toString('hex');
  const intent = {
    version: INTENT_VERSION,
    id,
    repo,
    outDir,
    workspaceId,
    beforeStatusDigest: digest(beforeStatus),
    ...(beforeStatusSnapshot ? { beforeStatusSnapshotDigest: fileSnapshotDigest(beforeStatusSnapshot) } : {}),
    desiredStatusDigest: digest(desiredStatus),
    desiredStatus,
    ensureRuntimeIgnore: ensureRuntimeIgnore === true,
    createdAt: new Date().toISOString(),
  };
  intent.intentDigest = digest(intentPayload(intent));
  return intent;
}

function validateIntent(intent, expectedId = null) {
  const supportedVersion = intent && (intent.version === 1 || intent.version === INTENT_VERSION);
  if (!supportedVersion || !/^[a-f0-9]{32}$/.test(String(intent.id || ''))
      || (expectedId && intent.id !== expectedId)) {
    throw new Error('invalid onboarding init transaction journal');
  }
  if (!intent.workspaceId || typeof intent.workspaceId !== 'string') {
    throw new Error('invalid onboarding init transaction workspace');
  }
  if (!intent.desiredStatus || typeof intent.desiredStatus !== 'object' || Array.isArray(intent.desiredStatus)
      || !SHA256_RE.test(String(intent.beforeStatusDigest || ''))
      || (intent.beforeStatusSnapshotDigest !== undefined
        && !SHA256_RE.test(String(intent.beforeStatusSnapshotDigest || '')))
      || !Number.isFinite(Date.parse(intent.createdAt))
      || typeof intent.ensureRuntimeIgnore !== 'boolean') {
    throw new Error('invalid onboarding init transaction status');
  }
  if (intent.version === INTENT_VERSION
      && (!SHA256_RE.test(String(intent.desiredStatusDigest || ''))
        || digest(intent.desiredStatus) !== intent.desiredStatusDigest
        || !SHA256_RE.test(String(intent.intentDigest || ''))
        || digest(intentPayload(intent)) !== intent.intentDigest)) {
    throw new Error('invalid onboarding init transaction digest');
  }
  const resolved = resolveOnboardPaths({
    repo: intent.repo,
    outDir: intent.outDir,
    registeredWorkspaces: [intent.repo],
  });
  if (resolved.repo !== intent.repo || resolved.outDir !== intent.outDir) {
    throw new Error('onboarding init transaction paths are not canonical');
  }
  const desired = intent.desiredStatus;
  if (desired.repo !== intent.repo || desired.outDir !== intent.outDir || desired.autoInject !== true
      || !Number.isInteger(desired.batchSize) || desired.batchSize <= 0
      || !['pending', 'running', 'ready'].includes(desired.preparationState)
      || !desiredStatusGeneration(desired)) {
    throw new Error('invalid onboarding init transaction status invariant');
  }
  if (['pending', 'running'].includes(desired.preparationState)
      && (typeof desired.preparationGeneration !== 'string' || !desired.preparationGeneration.trim())) {
    throw new Error('invalid onboarding init transaction preparation generation');
  }
  if (desired.preparationState === 'ready'
      && (typeof desired.queueGeneration !== 'string' || !desired.queueGeneration.trim())) {
    throw new Error('invalid onboarding init transaction queue generation');
  }
  return intent;
}

function writeIntent(registryFile, intent) {
  validateIntent(intent);
  const file = journalFile(registryFile, intent.id);
  writeJSONAtomic(file, intent);
  return file;
}

function statusLooksAccepted(current, intent) {
  if (!current || typeof current !== 'object') return false;
  if (path.resolve(current.repo || '') !== path.resolve(intent.repo)) return false;
  if (path.resolve(current.outDir || '') !== path.resolve(intent.outDir)) return false;
  if (current.autoInject !== true) return false;
  if (!Number.isInteger(current.batchSize) || current.batchSize <= 0) return false;
  if (!['pending', 'running', 'ready'].includes(current.preparationState)) return false;
  return desiredStatusGeneration(current) === desiredStatusGeneration(intent.desiredStatus);
}

// Apply the status half idempotently. If the exact pre-image is still present, install the desired
// state. If a later accepted onboarding generation already replaced it, preserve that newer state.
function ensureIntentStatus(intent) {
  validateIntent(intent);
  const file = statusFile(intent.outDir);
  return withFileLock(file, () => {
    const currentSnapshot = snapshotStatusFile(file);
    const current = readJSON(file, {}) || {};
    const desiredSnapshot = statusValueSnapshot(intent.desiredStatus);
    if (digest(current) === digest(intent.desiredStatus)
        && sameFileSnapshot(currentSnapshot, desiredSnapshot)) return { applied: false, value: current };
    if (digest(current) !== intent.beforeStatusDigest && statusLooksAccepted(current, intent)) {
      return { applied: false, value: current };
    }
    const exactSnapshot = intent.beforeStatusSnapshotDigest
      ? fileSnapshotDigest(currentSnapshot) === intent.beforeStatusSnapshotDigest
      : digest(current) === intent.beforeStatusDigest;
    if (!exactSnapshot) {
      const stale = new Error('stale onboarding init transaction journal');
      stale.code = 'STALE_ONBOARD_INIT_INTENT';
      throw stale;
    }
    // The state lock proves no live writer owns these atomic temps. Reap leftovers from a process
    // killed between status-temp write and rename only after the intent and exact pre-image passed.
    let names = [];
    try { names = fs.readdirSync(intent.outDir); } catch { /* withFileLock created the directory */ }
    for (const name of names) {
      if (!/^onboard-drain-status\.json\.\d+\.[a-f0-9]+\.tmp$/.test(name)) continue;
      try { fs.unlinkSync(path.join(intent.outDir, name)); } catch { /* already removed */ }
    }
    writeJSONAtomic(file, intent.desiredStatus);
    return { applied: true, value: intent.desiredStatus };
  });
}

function verifyIntent(registryFile, intent) {
  validateIntent(intent);
  const current = readJSON(statusFile(intent.outDir), {}) || {};
  if (!statusLooksAccepted(current, intent)) {
    throw new Error('onboarding intent was not durably persisted');
  }
  const registry = workspaceRegistry.loadRegistry(registryFile, { locked: true });
  if (!registry.workspaces[intent.workspaceId]
      || !registry.workspaces[intent.workspaceId].repos.includes(intent.repo)) {
    throw new Error('workspace registration was not durably persisted');
  }
  return { status: current, registry };
}

function removeIntent(registryFile, intent) {
  const file = journalFile(registryFile, intent.id);
  try { fs.unlinkSync(file); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
  try { fs.rmdirSync(journalDir(registryFile)); } catch { /* other transactions or already absent */ }
}

// Runtime Git exclusion is advisory. A durable status + registry commit must never remain a live
// publication transaction merely because Git metadata is missing, malformed, or read-only.
function tryRuntimeIgnore(repo, opts = {}) {
  try {
    return { ok: true, applied: ensureOnboardRuntimeIgnored(repo) === true };
  } catch (error) {
    if (typeof opts.onError === 'function') {
      try { opts.onError(error, repo); } catch { /* logging must stay advisory too */ }
    }
    return { ok: false, applied: false, error };
  }
}

// A crash can happen after the journal is settled but before the advisory ignore is warmed. The
// default onboarding status is the durable retry signal; no second transaction journal is needed.
function retryRegisteredRuntimeIgnore(repo, opts = {}) {
  let outDir;
  try { outDir = defaultOnboardOutDir(repo); } catch { return { ok: true, attempted: false }; }
  const current = readJSON(statusFile(outDir), null);
  if (!current || current.repo !== repo || current.outDir !== outDir || current.autoInject !== true) {
    return { ok: true, attempted: false };
  }
  return { ...tryRuntimeIgnore(repo, opts), attempted: true };
}

function snapshotStatusValue(snapshot) {
  if (!snapshot || snapshot.exists !== true) return {};
  if (snapshot.kind && snapshot.kind !== 'file') return {};
  const raw = Buffer.isBuffer(snapshot.bytes) ? snapshot.bytes.toString('utf8') : String(snapshot.bytes || '');
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return {}; }
}

function statusValueSnapshot(value) {
  return {
    exists: true,
    kind: 'file',
    bytes: Buffer.from(JSON.stringify(value, null, 2) + '\n'),
    mode: null,
  };
}

function snapshotMetadata(stat) {
  if (!stat) return {};
  return {
    mode: stat.mode & 0o7777,
    size: stat.size,
    uid: stat.uid,
    gid: stat.gid,
    mtimeMs: stat.mtimeMs,
  };
}

// Status snapshots are deliberately total. A corrupt JSON file is still an ordinary exact byte
// image; directories and unreadable/special files retain enough metadata for a no-op CAS without
// turning rollback of the primary init error into a second exception.
function snapshotStatusFile(file) {
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, kind: 'absent', bytes: null };
    return { exists: true, kind: 'unreadable', bytes: null, errorCode: err && err.code || 'UNKNOWN' };
  }
  const metadata = snapshotMetadata(stat);
  if (!stat.isFile()) {
    return {
      exists: true,
      kind: stat.isDirectory() ? 'directory' : (stat.isSymbolicLink() ? 'symlink' : 'special'),
      bytes: null,
      ...metadata,
    };
  }
  try {
    return { exists: true, kind: 'file', bytes: fs.readFileSync(file), ...metadata };
  } catch (err) {
    return {
      exists: true,
      kind: 'unreadable',
      bytes: null,
      errorCode: err && err.code || 'UNKNOWN',
      ...metadata,
    };
  }
}

function fileSnapshotIdentity(snapshot) {
  const exists = !!(snapshot && snapshot.exists);
  if (!exists) return { exists: false, kind: 'absent' };
  const bytes = snapshot && Buffer.isBuffer(snapshot.bytes) ? snapshot.bytes : null;
  return {
    exists: true,
    kind: String(snapshot.kind || (bytes ? 'file' : 'unknown')),
    bytesDigest: bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null,
    mode: Number.isInteger(snapshot.mode) ? snapshot.mode : null,
    size: Number.isFinite(snapshot.size) ? snapshot.size : (bytes ? bytes.length : null),
    errorCode: snapshot.errorCode || null,
  };
}

function fileSnapshotDigest(snapshot) {
  return digest(fileSnapshotIdentity(snapshot));
}

function sameFileSnapshot(left, right) {
  if (!!(left && left.exists) !== !!(right && right.exists)) return false;
  if (!left || !left.exists) return true;
  if (String(left.kind || 'file') !== String(right.kind || 'file')) return false;
  if (Buffer.isBuffer(left.bytes) || Buffer.isBuffer(right.bytes)) {
    return Buffer.isBuffer(left.bytes) && Buffer.isBuffer(right.bytes)
      && left.bytes.equals(right.bytes);
  }
  return fileSnapshotDigest(left) === fileSnapshotDigest(right);
}

function samePersistedIntent(registryFile, intent) {
  const persisted = readJSON(journalFile(registryFile, intent.id), null);
  try { validateIntent(persisted, intent.id); } catch { return false; }
  if (intent.version === INTENT_VERSION) return persisted.intentDigest === intent.intentDigest;
  return digest(persisted) === digest(intent);
}

function cleanupStatusTemps(file) {
  let names = [];
  try { names = fs.readdirSync(path.dirname(file)); } catch { return; }
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${base}\\.\\d+\\.[a-f0-9]+\\.tmp$`);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try { fs.unlinkSync(path.join(path.dirname(file), name)); } catch { /* already removed */ }
  }
}

// Roll back only the exact status image installed by this still-live journal. The status lock makes
// the compare and restore/delete one operation: an enqueue or recovered init that has already
// published another generation wins, and this failed transaction leaves its bytes, lock, and temps
// untouched. Atomic-write leftovers are reaped only while we own the lock and the current image is
// still either this intent's desired image or its exact pre-image.
function rollbackIntentStatus(registryFile, intent, beforeSnapshot) {
  try { validateIntent(intent); } catch (err) {
    return { applied: false, owned: false, reason: 'invalid_intent', error: String(err && err.message || err) };
  }
  const beforeValue = snapshotStatusValue(beforeSnapshot);
  if (intent.beforeStatusSnapshotDigest
      ? fileSnapshotDigest(beforeSnapshot) !== intent.beforeStatusSnapshotDigest
      : digest(beforeValue) !== intent.beforeStatusDigest) {
    return { applied: false, owned: false, reason: 'preimage_mismatch' };
  }
  const file = statusFile(intent.outDir);
  try {
    return withFileLock(file, () => {
    if (!samePersistedIntent(registryFile, intent)) {
      return { applied: false, owned: false, reason: 'intent_replaced' };
    }
    const currentSnapshot = snapshotStatusFile(file);
    const current = readJSON(file, {}) || {};
    const currentDigest = digest(current);
    const desiredDigest = intent.desiredStatusDigest || digest(intent.desiredStatus);
    const desiredSnapshot = statusValueSnapshot(intent.desiredStatus);
    const exactDesired = currentDigest === desiredDigest && sameFileSnapshot(currentSnapshot, desiredSnapshot);
    const exactBefore = currentDigest === intent.beforeStatusDigest
      && sameFileSnapshot(currentSnapshot, beforeSnapshot || { exists: false, bytes: null });
    if (!exactDesired && !exactBefore) {
      return { applied: false, owned: true, stale: true, reason: 'status_replaced', value: current };
    }
    cleanupStatusTemps(file);
    if (exactBefore) {
      return { applied: false, owned: true, preimage: true, value: current };
    }
    if (beforeSnapshot && beforeSnapshot.exists === true && (beforeSnapshot.kind || 'file') === 'file') {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, beforeSnapshot.bytes);
        if (Number.isInteger(beforeSnapshot.mode)) fs.chmodSync(tmp, beforeSnapshot.mode);
        fs.renameSync(tmp, file);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* renamed or already removed */ }
      }
    } else if (!beforeSnapshot || beforeSnapshot.exists !== true) {
      try { fs.unlinkSync(file); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
    } else {
      // An unsupported pre-image can only reach this branch if the exact desired bytes replaced it.
      // Remove just those journal-owned bytes from the canonical path; retain them as quarantined
      // evidence instead of inventing data for a directory/unreadable/special pre-image.
      const quarantine = `${file}.rollback-${intent.id}.invalid`;
      fs.renameSync(file, quarantine);
      return { applied: true, owned: true, quarantined: true, value: beforeValue };
    }
    return { applied: true, owned: true, value: beforeValue };
    });
  } catch (err) {
    return { applied: false, owned: true, reason: 'rollback_error', error: String(err && err.message || err) };
  }
}

function quarantineIntent(registryFile, id) {
  const file = journalFile(registryFile, id);
  const target = `${file}.invalid`;
  try { fs.renameSync(file, target); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
}

function readIntents(registryFile) {
  let names;
  try { names = fs.readdirSync(journalDir(registryFile)); } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const intents = [];
  for (const name of names.sort()) {
    // A kill before the journal rename cannot have reached any project/registry write. The temp is
    // therefore an exact rolled-back transaction and may be removed deterministically on boot.
    if (/^[a-f0-9]{32}\.json\.\d+\.[a-f0-9]+\.tmp$/.test(name)) {
      try { fs.unlinkSync(path.join(journalDir(registryFile), name)); } catch { /* already removed */ }
      continue;
    }
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    const id = name.slice(0, -5);
    const intent = readJSON(path.join(journalDir(registryFile), name), null);
    try {
      validateIntent(intent, id);
      intents.push(intent);
    } catch {
      quarantineIntent(registryFile, id);
    }
  }
  if (!intents.length) {
    try { fs.rmdirSync(journalDir(registryFile)); } catch { /* unknown files or already absent */ }
  }
  return intents;
}

function reconcilePending(registryFile, opts = {}) {
  const reconcile = () => {
    const recovered = [];
    for (const intent of readIntents(registryFile)) {
      try { ensureIntentStatus(intent); } catch (err) {
        if (err && err.code === 'STALE_ONBOARD_INIT_INTENT') {
          quarantineIntent(registryFile, intent.id);
          continue;
        }
        throw err;
      }
      workspaceRegistry.addRepo(registryFile, {
        workspace: intent.workspaceId,
        repo: intent.repo,
      }, { locked: true });
      verifyIntent(registryFile, intent);
      // Settlement is part of the durable transaction. The Git exclude is not: remove the journal
      // first so an advisory failure cannot replay status/registry or abort daemon loadState().
      removeIntent(registryFile, intent);
      if (intent.ensureRuntimeIgnore) tryRuntimeIgnore(intent.repo, { onError: opts.onRuntimeIgnoreError });
      recovered.push(intent);
    }
    return recovered;
  };
  return opts.locked ? reconcile() : workspaceRegistry.withRegistryLock(registryFile, reconcile);
}

module.exports = {
  JOURNAL_DIRNAME,
  INTENT_VERSION,
  digest,
  journalDir,
  journalFile,
  createIntent,
  writeIntent,
  ensureIntentStatus,
  verifyIntent,
  rollbackIntentStatus,
  snapshotStatusFile,
  removeIntent,
  tryRuntimeIgnore,
  retryRegisteredRuntimeIgnore,
  quarantineIntent,
  readIntents,
  reconcilePending,
};
