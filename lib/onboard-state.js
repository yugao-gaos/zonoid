'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATUS_FILE = 'onboard-drain-status.json';
const INJECTION_RECEIPT_FILE = 'onboard-injection-receipt.json';
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}

function writeJSONAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
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

function liveOnboardInjectionLease(meta, now = Date.now()) {
  if (!meta || (meta.injectionState !== 'running' && meta.injecting !== true)) {
    return { live: false, expiresAt: null };
  }
  const expiresAt = Math.max(0, Number(meta.injectionLeaseExpiresAt) || 0);
  // A route claim persists its owner before the child pid is available. During that short window the
  // unexpired owner/lease is still authoritative and another daemon must not replace it.
  const ownerAlive = meta.injectionPid ? pidAlive(meta.injectionPid) : true;
  const live = ownerAlive && (expiresAt > now || (!expiresAt && !!meta.injectionOwner));
  return { live, expiresAt: expiresAt || null };
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        const owner = readJSON(lock, {});
        const stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
        if (stale || (owner.pid && !pidAlive(owner.pid))) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch { /* lock disappeared; retry */ }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for onboarding state lock ${lock}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
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
  return readJSON(statusFile(outDir), {}) || {};
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
  readJSON,
  writeJSONAtomic,
  pidAlive,
  liveOnboardInjectionLease,
  withFileLock,
  mutateJSONAtomic,
  statusFile,
  readOnboardStatus,
  mutateOnboardStatus,
  patchOnboardStatus,
  onboardNoteId,
  writeInjectionReceipt,
  confirmInjectedNote,
  confirmedInjectedCount,
};
