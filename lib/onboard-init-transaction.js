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

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function journalDir(registryFile) {
  return path.join(path.dirname(registryFile), JOURNAL_DIRNAME);
}

function journalFile(registryFile, id) {
  return path.join(journalDir(registryFile), `${id}.json`);
}

function createIntent({ repo, outDir, workspaceId, beforeStatus, desiredStatus, ensureRuntimeIgnore = false }) {
  const id = crypto.randomBytes(16).toString('hex');
  return {
    version: 1,
    id,
    repo,
    outDir,
    workspaceId,
    beforeStatusDigest: digest(beforeStatus),
    desiredStatus,
    ensureRuntimeIgnore: ensureRuntimeIgnore === true,
    createdAt: new Date().toISOString(),
  };
}

function validateIntent(intent) {
  if (!intent || intent.version !== 1 || !/^[a-f0-9]{32}$/.test(String(intent.id || ''))) {
    throw new Error('invalid onboarding init transaction journal');
  }
  if (!intent.workspaceId || typeof intent.workspaceId !== 'string') {
    throw new Error('invalid onboarding init transaction workspace');
  }
  if (!intent.desiredStatus || typeof intent.desiredStatus !== 'object') {
    throw new Error('invalid onboarding init transaction status');
  }
  const resolved = resolveOnboardPaths({
    repo: intent.repo,
    outDir: intent.outDir,
    registeredWorkspaces: [intent.repo],
  });
  if (resolved.repo !== intent.repo || resolved.outDir !== intent.outDir) {
    throw new Error('onboarding init transaction paths are not canonical');
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
  return Number(current.batchSize) > 0;
}

// Apply the status half idempotently. If the exact pre-image is still present, install the desired
// state. If a later accepted onboarding generation already replaced it, preserve that newer state.
function ensureIntentStatus(intent) {
  validateIntent(intent);
  const file = statusFile(intent.outDir);
  return withFileLock(file, () => {
    // The state lock proves no live writer owns these atomic temps. Reap leftovers from a process
    // killed between status-temp write and rename before installing/verifying the journaled state.
    let names = [];
    try { names = fs.readdirSync(intent.outDir); } catch { /* withFileLock created the directory */ }
    for (const name of names) {
      if (!/^onboard-drain-status\.json\.\d+\.[a-f0-9]+\.tmp$/.test(name)) continue;
      try { fs.unlinkSync(path.join(intent.outDir, name)); } catch { /* already removed */ }
    }
    const current = readJSON(file, {}) || {};
    if (digest(current) === digest(intent.desiredStatus)) return { applied: false, value: current };
    if (digest(current) !== intent.beforeStatusDigest && statusLooksAccepted(current, intent)) {
      return { applied: false, value: current };
    }
    writeJSONAtomic(file, intent.desiredStatus);
    return { applied: true, value: intent.desiredStatus };
  });
}

function verifyIntent(registryFile, intent) {
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
    const intent = readJSON(path.join(journalDir(registryFile), name), null);
    validateIntent(intent);
    intents.push(intent);
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
      ensureIntentStatus(intent);
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
  digest,
  journalDir,
  journalFile,
  createIntent,
  writeIntent,
  ensureIntentStatus,
  verifyIntent,
  removeIntent,
  readIntents,
  reconcilePending,
};
