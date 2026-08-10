'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

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

function onboardQueueGeneration(queue) {
  if (!queue || typeof queue !== 'object') return null;
  if (typeof queue.generation === 'string' && queue.generation.trim()) return queue.generation.trim();
  const stable = JSON.stringify({
    total: Number(queue.total) || 0,
    pending: Array.isArray(queue.pending) ? queue.pending : [],
  });
  return `legacy-${crypto.createHash('sha1').update(stable).digest('hex')}`;
}

function canonicalOnboardNotes(queue, generation = onboardQueueGeneration(queue)) {
  if (!generation || !queue || !Array.isArray(queue.kept) || !Array.isArray(queue.rejected)) return null;
  return { generation, kept: queue.kept, rejected: queue.rejected };
}

function writeOnboardNotesArtifact(outDir, queue, generation = onboardQueueGeneration(queue)) {
  const artifact = canonicalOnboardNotes(queue, generation);
  if (!artifact) return null;
  writeJSONAtomic(path.join(outDir, 'onboard-notes.json'), artifact);
  return artifact;
}

function onboardNotesArtifactMatchesQueue(artifact, queue, generation = onboardQueueGeneration(queue), options = {}) {
  if (!artifact || !generation || !queue
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
    const generation = onboardQueueGeneration(queue);
    if (!queue || !generation || generation !== expectedGeneration) {
      return { ok: false, stale: true, reason: 'generation_replaced', generation, queue };
    }
    if (!Number.isInteger(Number(queue.total)) || Number(queue.total) < 0
        || !Number.isInteger(Number(queue.cursor)) || Number(queue.cursor) < 0
        || Number(queue.cursor) > Number(queue.total)
        || !Array.isArray(queue.kept) || !Array.isArray(queue.rejected)) {
      return { ok: false, stale: true, reason: 'invalid_queue_artifact', generation, queue };
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
  onboardQueueGeneration,
  writeOnboardNotesArtifact,
  onboardNotesArtifactMatchesQueue,
  loadGenerationMatchedOnboardNotes,
  onboardNoteId,
  writeInjectionReceipt,
  confirmInjectedNote,
  confirmedInjectedCount,
};
