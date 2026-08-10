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
    return { pid: parsed.pid, owner: parsed.owner };
  } catch { return null; }
}

function removeEmptyDir(dir, fsImpl) {
  try { fsImpl.rmdirSync(dir); } catch (err) {
    if (!err || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
  }
}

function recoverLegacyLock(lock, fsImpl, staleMs) {
  const incumbent = lockSnapshot(lock, fsImpl);
  const incumbentOwner = incumbent && lockOwner(incumbent);
  const stale = !!incumbent && Date.now() - incumbent.mtimeMs > staleMs;
  if (!stale && !(incumbentOwner && !pidAlive(incumbentOwner.pid))) return false;
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

function recoverHeldLock(held, fsImpl, staleMs) {
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
  // A valid live owner remains authoritative however long its synchronous critical section takes;
  // only dead owners are reclaimed. Staleness is solely the recovery clock for malformed records
  // left during create-before-owner-write.
  if (incumbentOwner ? pidAlive(incumbentOwner.pid) : !stale) return false;
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
          if (recoverLegacyLock(lock, fsImpl, staleMs)) continue;
          throw Object.assign(new Error('legacy onboarding lock is still owned'), { code: 'EEXIST' });
        }
      }
      try { fsImpl.mkdirSync(held); } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        if (recoverHeldLock(held, fsImpl, staleMs)) continue;
        throw err;
      }
      let claimedFd = null;
      try {
        claimedFd = fsImpl.openSync(ownerFile, 'wx');
        fsImpl.writeFileSync(claimedFd, JSON.stringify({ pid: process.pid, owner, at: Date.now() }));
        fsImpl.closeSync(claimedFd);
        claimedFd = null;
        const claimed = lockSnapshot(ownerFile, fsImpl);
        const recorded = claimed && lockOwner(claimed);
        if (!recorded || recorded.pid !== process.pid || recorded.owner !== owner) {
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
        // Current writers retain the reservation identity on a completed sparse slice. Accept the
        // older all-absent shape for crash recovery, but never accept a partial/tampered identity.
        const hasIdentity = ['generation', 'reservationId', 'completedAt']
          .some((key) => Object.prototype.hasOwnProperty.call(entry, key));
        if (hasIdentity && (entry.generation !== generation
            || typeof entry.reservationId !== 'string' || !entry.reservationId
            || !Number.isFinite(entry.completedAt) || entry.completedAt < 0)) {
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
  validateOnboardQueue,
  writeOnboardNotesArtifact,
  onboardNotesArtifactMatchesQueue,
  loadGenerationMatchedOnboardNotes,
  onboardNoteId,
  writeInjectionReceipt,
  confirmInjectedNote,
  confirmedInjectedCount,
};
