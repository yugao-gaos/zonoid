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
const { resolveOnboardPaths, ensureOnboardRuntimeIgnored } = require('./onboard-paths');

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
    desiredStatusDigest: intent.desiredStatusDigest,
    desiredStatus: intent.desiredStatus,
    ensureRuntimeIgnore: intent.ensureRuntimeIgnore,
    createdAt: intent.createdAt,
  };
}

function createIntent({ repo, outDir, workspaceId, beforeStatus, desiredStatus, ensureRuntimeIgnore = false }) {
  const id = crypto.randomBytes(16).toString('hex');
  const intent = {
    version: INTENT_VERSION,
    id,
    repo,
    outDir,
    workspaceId,
    beforeStatusDigest: digest(beforeStatus),
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
    const current = readJSON(file, {}) || {};
    if (digest(current) === digest(intent.desiredStatus)) return { applied: false, value: current };
    if (digest(current) !== intent.beforeStatusDigest && statusLooksAccepted(current, intent)) {
      return { applied: false, value: current };
    }
    if (digest(current) !== intent.beforeStatusDigest) {
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
      if (intent.ensureRuntimeIgnore) ensureOnboardRuntimeIgnored(intent.repo);
      removeIntent(registryFile, intent);
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
  removeIntent,
  quarantineIntent,
  readIntents,
  reconcilePending,
};
