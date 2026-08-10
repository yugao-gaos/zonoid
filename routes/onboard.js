'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  defaultOnboardOutDir,
  onboardRuntimeRoot,
  ensureOnboardRuntimeIgnored,
} = require('../lib/onboard-paths');
const {
  readOnboardStatus,
  patchOnboardStatus,
  mutateOnboardStatus,
  confirmedInjectedCount,
} = require('../lib/onboard-state');

const DEFAULT_DRAIN_BATCH_SIZE = 20;
const DEFAULT_INJECTION_MAX_ATTEMPTS = 3;

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}

function newQueueGeneration() {
  return `onboard-${crypto.randomBytes(12).toString('hex')}`;
}

function queueGeneration(q) {
  if (!q || typeof q !== 'object') return null;
  if (typeof q.generation === 'string' && q.generation.trim()) return q.generation.trim();
  // Legacy queues predate explicit generations. Their candidate set is immutable while cursor,
  // kept, and inflight progress change, so it is a safe compatibility fingerprint.
  const stable = JSON.stringify({ total: Number(q.total) || 0, pending: Array.isArray(q.pending) ? q.pending : [] });
  return `legacy-${crypto.createHash('sha1').update(stable).digest('hex')}`;
}

function countOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function injectionMaxAttempts() {
  return Math.max(1, Number(process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS) || DEFAULT_INJECTION_MAX_ATTEMPTS);
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function summarizeInflight(q) {
  const liveRanges = [];
  let liveCount = 0;
  let staleCount = 0;
  let maxLiveEnd = Math.max(0, Number(q && q.cursor) || 0);
  const now = Date.now();
  for (const [startKey, entry] of Object.entries((q && q.inflight) || {})) {
    const start = Number(startKey);
    const count = Math.max(0, Number(entry && entry.count) || 0);
    if (!Number.isFinite(start) || count <= 0) continue;
    const expiresAt = Number(entry && entry.expiresAt) || 0;
    const expired = expiresAt > 0 && expiresAt <= now;
    const deadOwner = entry && entry.pid && !isPidAlive(entry.pid);
    if (expired || deadOwner) {
      staleCount += count;
      continue;
    }
    const end = start + count;
    liveCount += count;
    maxLiveEnd = Math.max(maxLiveEnd, end);
    liveRanges.push({ start, count, end });
  }
  return {
    inflight: liveCount,
    staleInflight: staleCount,
    inflightRanges: liveRanges,
    visualProcessed: maxLiveEnd,
  };
}

function queueStatus(outDir) {
  const q = readJSON(path.join(outDir, 'onboard-queue.json'), null);
  if (!q || typeof q.total !== 'number' || typeof q.cursor !== 'number') return null;
  const processed = q.cursor;
  const remaining = Math.max(0, q.total - q.cursor);
  const kept = Array.isArray(q.kept) ? q.kept.length : 0;
  const keptNotes = (Array.isArray(q.kept) ? q.kept : []).slice(0, 64).map((n, i) => ({
    title: String(n && n.title || '').trim() || `Kept note ${i + 1}`,
    summary: String(n && n.summary || '').trim(),
    kind: String(n && n.kind || 'note').trim() || 'note',
  }));
  return {
    total: q.total,
    processed,
    kept,
    keptNotes,
    remaining,
    drainDone: remaining === 0,
    queueGeneration: queueGeneration(q),
    ...summarizeInflight(q),
  };
}

function readDrainMeta(outDir) {
  return readOnboardStatus(outDir);
}

function writeDrainMeta(outDir, patch) {
  return patchOnboardStatus(outDir, patch).value;
}

function buildDrainJob(repo, outDir, patch = {}) {
  // The headless learner persists progress independently of the route process. A cached POST job
  // is only a fallback; it must never overwrite a newer on-disk injection result or error.
  const persistedMeta = readDrainMeta(outDir);
  const meta = Object.keys(persistedMeta).length ? persistedMeta : patch;
  const persistedQueue = queueStatus(outDir);
  const qs = persistedQueue || {};
  const autoInject = meta.autoInject !== false;
  const drainDone = qs.drainDone === true;
  const noCandidates = drainDone && qs.total === 0;
  const kept = typeof qs.kept === 'number' ? qs.kept : (meta.kept || 0);
  const processed = qs.processed || meta.processed || 0;
  const visualProcessed = Math.max(processed, qs.visualProcessed || meta.visualProcessed || 0);
  const preparationState = persistedQueue && meta.preparationForce !== true
    ? 'ready'
    : (meta.preparationState || (persistedQueue ? 'ready' : 'idle'));
  const preparing = preparationState === 'pending' || preparationState === 'running';
  const queueGen = qs.queueGeneration || meta.queueGeneration || null;
  const injectionGen = typeof meta.injectionGeneration === 'string'
    ? meta.injectionGeneration
    : ((meta.injected === true || meta.injecting === true || meta.injectionState) ? queueGen : null);
  const generationMatches = !!queueGen && injectionGen === queueGen;
  // An explicit zero is a real watermark. Do not replace it with the current kept count merely
  // because zero is falsy; that was the original stale-completion bug.
  const injectedKept = generationMatches && Object.prototype.hasOwnProperty.call(meta, 'injectedKept')
    ? countOrZero(meta.injectedKept)
    : 0;
  const legacyInjectionError = meta.error && /^inject(?:ion)?\b/i.test(String(meta.error));
  const inferredInjectionState = meta.injecting === true
    ? 'running'
    : (meta.injected === true ? 'succeeded' : ((meta.injectionError || legacyInjectionError) ? 'failed' : null));
  let injectionState = generationMatches ? (meta.injectionState || inferredInjectionState) : null;
  const noNotesToInject = drainDone && qs.total > 0 && kept === 0;
  if (preparing) injectionState = 'blocked';
  else if (!injectionState) injectionState = autoInject && kept > 0 ? 'pending' : (noNotesToInject ? 'not_needed' : 'idle');
  const injecting = generationMatches && (meta.injecting === true || injectionState === 'running');
  const injectionError = generationMatches
    ? (meta.injectionError || ((['backoff', 'failed'].includes(injectionState) || legacyInjectionError) ? meta.error : null))
    : null;
  const hasInjectionErrorMetadata = !!meta.injectionError || legacyInjectionError
    || ['backoff', 'failed'].includes(meta.injectionState);
  const error = injectionError || (hasInjectionErrorMetadata ? null : meta.error) || null;
  const injected = !preparing
    && !injecting
    && !injectionError
    && generationMatches
    && (injectionState === 'succeeded' || (!meta.injectionState && meta.injected === true))
    && injectedKept >= kept;
  const attempts = generationMatches ? countOrZero(meta.injectionAttempts) : 0;
  const maxAttempts = injectionMaxAttempts();
  const retryAt = generationMatches ? countOrZero(meta.injectionRetryAt) : 0;
  const retryCapped = generationMatches && (meta.injectionRetryCapped === true || (injectionState === 'failed' && attempts >= maxAttempts));
  const retryPending = generationMatches && injectionState === 'backoff' && !retryCapped && retryAt > Date.now();
  const successfulTerminal = noCandidates || noNotesToInject || !autoInject || injected;
  return {
    repo,
    outDir,
    total: qs.total || meta.total || 0,
    processed,
    visualProcessed,
    remaining: qs.remaining || 0,
    kept,
    keptNotes: Array.isArray(qs.keptNotes) ? qs.keptNotes : [],
    inflight: qs.inflight || 0,
    staleInflight: qs.staleInflight || 0,
    inflightRanges: Array.isArray(qs.inflightRanges) ? qs.inflightRanges : [],
    injectedKept,
    queueGeneration: queueGen,
    done: (!!error && !persistedQueue) || (!preparing && drainDone && successfulTerminal),
    error,
    autoInject,
    injected,
    injecting,
    injectionState,
    injectionAttempts: attempts,
    injectionMaxAttempts: maxAttempts,
    injectionRetryAt: retryAt || null,
    injectionRetryPending: retryPending,
    injectionRetryCapped: retryCapped,
    injectionError,
    preparing,
    preparationState,
    preparationStage: meta.preparationStage || null,
    preparationAttempts: Math.max(0, Number(meta.preparationAttempts) || 0),
    noCandidates,
    noNotesToInject,
    needsReview: drainDone && !noCandidates && !autoInject && !injected,
  };
}

function runNode(args) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  });
}

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange } = ctx;

  if (p === '/onboard/enqueue' && m === 'POST') {
    const b = await readBody(req);
    const repo = b.repo;
    if (!repo) { send(res, 400, { ok: false, error: 'repo required' }); return true; }
    const outDir = b.outDir || defaultOnboardOutDir(repo);
    const existingStatus = queueStatus(outDir);
    const existingMeta = readDrainMeta(outDir);
    const sameRepo = existingMeta.repo
      ? path.resolve(existingMeta.repo) === path.resolve(repo)
      : path.resolve(outDir) === path.resolve(defaultOnboardOutDir(repo));
    // Repeated init/dashboard requests must resume an existing queue at its current cursor. Re-mining
    // an incomplete queue would discard already-kept notes and make normal idempotent setup destructive.
    if (!b.force && existingStatus && sameRepo) {
      send(res, 200, {
        ok: true,
        total: existingStatus.total,
        remaining: existingStatus.remaining,
        outDir,
        reused: true,
        completed: existingStatus.drainDone,
      });
      return true;
    }
    if (!b.force && sameRepo && ['pending', 'running'].includes(existingMeta.preparationState)) {
      const job = buildDrainJob(repo, outDir);
      send(res, 200, {
        ok: true,
        total: job.total,
        remaining: job.remaining,
        outDir,
        reused: true,
        preparing: true,
        preparationState: job.preparationState,
      });
      return true;
    }

    try {
      const resolvedOutDir = path.resolve(outDir);
      const runtimeRoot = path.resolve(onboardRuntimeRoot(repo));
      if (resolvedOutDir === runtimeRoot || resolvedOutDir.startsWith(runtimeRoot + path.sep)) {
        ensureOnboardRuntimeIgnored(repo);
      }
      writeDrainMeta(outDir, {
        repo,
        outDir,
        preparationGeneration: newQueueGeneration(),
        preparationState: 'pending',
        preparationStage: null,
        preparationRequestedAt: new Date().toISOString(),
        preparationForce: b.force === true,
        preparationPid: null,
        preparationLeaseExpiresAt: null,
        queueGeneration: null,
        injected: false,
        injectedGeneration: null,
        injectedKept: 0,
        injectionGeneration: null,
        injectionState: 'idle',
        injectionAttempts: 0,
        injectionRetryAt: null,
        injectionRetryCapped: false,
        injectionError: null,
        injecting: false,
        error: null,
      });
    } catch (err) {
      send(res, 500, { ok: false, error: `could not persist onboarding request: ${err && err.message ? err.message : err}` });
      return true;
    }
    if (notifyChange) notifyChange();
    send(res, 200, {
      ok: true,
      total: 0,
      remaining: 0,
      outDir,
      queued: true,
      preparing: true,
      preparationState: 'pending',
    });
    return true;
  }

  if (!global.__drainJobs) global.__drainJobs = new Map();
  const drainJobs = global.__drainJobs;

  if (p === '/onboard/drain-queue' && m === 'POST') {
    const b = await readBody(req);
    const { repo, outDir, batchSize } = b;
    const autoInject = b.autoInject !== false;
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir required' }); return true; }
    const jobKey = `${repo}::${outDir}`;
    if (drainJobs.has(jobKey)) {
      const existing = drainJobs.get(jobKey);
      if (!existing.done && !existing.error) {
        send(res, 200, { ok: true, status: existing, message: 'drain already in progress' }); return true;
      }
    }
    const status = queueStatus(outDir);
    const meta = readDrainMeta(outDir);
    const preparationKnown = ['pending', 'running', 'failed', 'ready'].includes(meta.preparationState);
    if (!status && !preparationKnown) { send(res, 404, { ok: false, error: 'queue not found for this repo+outDir' }); return true; }
    const queueGen = status && status.queueGeneration;
    const injectionGen = typeof meta.injectionGeneration === 'string'
      ? meta.injectionGeneration
      : ((meta.injected === true || meta.injecting === true || meta.injectionState) ? queueGen : null);
    const currentInjection = !!queueGen && injectionGen === queueGen;
    const injectionManaged = currentInjection && ['running', 'backoff', 'failed'].includes(meta.injectionState);
    writeDrainMeta(outDir, {
      repo,
      outDir,
      batchSize: batchSize || DEFAULT_DRAIN_BATCH_SIZE,
      autoInject,
      ...(currentInjection && (meta.injecting === true || meta.injectionState === 'running') ? {} : { injecting: false }),
      // A failed preparation is terminal until /onboard/enqueue explicitly rearms it. Merely
      // polling/arming the drain must not erase preparation or injection retry state.
      ...(injectionManaged ? {} : (status || meta.preparationState !== 'failed' ? { error: null } : {})),
    });
    const job = buildDrainJob(repo, outDir);
    drainJobs.set(jobKey, job);
    if (notifyChange) notifyChange();
    send(res, 200, { ok: true, status: job, message: job.done ? 'queue already empty' : 'queued for headless drain' }); return true;
  }

  if (p === '/onboard/inject' && m === 'POST') {
    const b = await readBody(req);
    const { repo, outDir } = b;
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir required' }); return true; }
    const learnScript = path.join(__dirname, '..', 'scripts', 'onboard-learn.js');
    const status = queueStatus(outDir);
    if (!status) { send(res, 404, { ok: false, error: 'queue not found for this repo+outDir' }); return true; }
    const generation = status.queueGeneration;
    const previous = readDrainMeta(outDir);
    const attempt = countOrZero(previous.injectionAttempts) + 1;
    const owner = `inject-route-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      const claimed = mutateOnboardStatus(outDir, (meta) => {
        const current = queueStatus(outDir);
        if (!current || current.queueGeneration !== generation) return undefined;
        if (meta.preparationGeneration && meta.preparationGeneration !== generation) return undefined;
        return {
          ...meta,
          repo, outDir, injecting: true, injectionGeneration: generation, injectionState: 'running',
          injectionOwner: owner, injectionPid: process.pid,
          injectionAttempts: attempt, injectionRetryAt: null, injectionRetryCapped: false,
          injectionError: null, error: null,
        };
      });
      if (!claimed.applied) {
        send(res, 409, { ok: false, stale: true, error: 'onboarding generation was replaced before injection started' });
        return true;
      }
      await runNode([learnScript, '--repo', repo, '--in', outDir, '--inject', '--confirm', '--generation', generation]);
      const notes = (readJSON(path.join(outDir, 'onboard-notes.json'), {}) || {}).kept || [];
      const injectedKept = confirmedInjectedCount(outDir, generation, notes);
      if (injectedKept < notes.length) throw new Error(`inject confirmed ${injectedKept} of ${notes.length} current-generation notes`);
      const committed = mutateOnboardStatus(outDir, (meta) => {
        const current = queueStatus(outDir);
        if (!current || current.queueGeneration !== generation
            || meta.injectionGeneration !== generation || meta.injectionOwner !== owner) return undefined;
        return {
          ...meta,
          repo, outDir, injecting: false, injected: true, injectedGeneration: generation,
          injectionGeneration: generation, injectionState: 'succeeded', injectionOwner: null, injectionPid: null,
          injectionAttempts: 0, injectionRetryAt: null, injectionRetryCapped: false, injectionError: null,
          injectedKept, injectedAt: new Date().toISOString(), error: null,
        };
      });
      if (!committed.applied) {
        send(res, 409, { ok: false, stale: true, error: 'onboarding generation was replaced during injection' });
        return true;
      }
    } catch (err) {
      const error = String(err && err.message || err);
      const notes = (readJSON(path.join(outDir, 'onboard-notes.json'), {}) || {}).kept || [];
      const injectedKept = confirmedInjectedCount(outDir, generation, notes);
      const committed = mutateOnboardStatus(outDir, (meta) => {
        const current = queueStatus(outDir);
        if (!current || current.queueGeneration !== generation
            || meta.injectionGeneration !== generation || meta.injectionOwner !== owner) return undefined;
        return {
          ...meta,
          repo, outDir, injecting: false, injected: false, injectedKept,
          injectionGeneration: generation, injectionState: 'failed', injectionOwner: null, injectionPid: null,
          injectionAttempts: attempt, injectionRetryAt: null, injectionRetryCapped: true,
          injectionError: error, error,
        };
      });
      if (!committed.applied) {
        send(res, 409, { ok: false, stale: true, error: 'onboarding generation was replaced during injection' });
        return true;
      }
      send(res, 500, { ok: false, error: `inject failed: ${err && err.message ? err.message : err}` }); return true;
    }
    const jobKey = `${repo}::${outDir}`;
    if (drainJobs.has(jobKey)) {
      const job = drainJobs.get(jobKey);
      job.injected = true;
      job.injectedKept = (queueStatus(outDir) || {}).kept || 0;
      job.needsReview = false;
      job.done = true;
    }
    if (notifyChange) notifyChange();
    send(res, 200, { ok: true, injected: true }); return true;
  }

  if (p === '/onboard/retry-inject' && m === 'POST') {
    const b = await readBody(req);
    const { repo, outDir } = b;
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir required' }); return true; }
    const status = queueStatus(outDir);
    if (!status) { send(res, 404, { ok: false, error: 'queue not found for this repo+outDir' }); return true; }
    const meta = readDrainMeta(outDir);
    const generation = status.queueGeneration;
    const injectedGeneration = meta.injectedGeneration === generation ? generation : null;
    writeDrainMeta(outDir, {
      repo,
      outDir,
      autoInject: true,
      injected: injectedGeneration !== null,
      injectionGeneration: generation,
      injectionState: 'pending',
      injectionAttempts: 0,
      injectionRetryAt: null,
      injectionRetryCapped: false,
      injectionError: null,
      injecting: false,
      error: null,
    });
    const job = buildDrainJob(repo, outDir);
    drainJobs.set(`${repo}::${outDir}`, job);
    if (notifyChange) notifyChange();
    send(res, 200, { ok: true, status: job, message: 'injection retry queued' });
    return true;
  }

  if (p === '/onboard/drain-queue' && m === 'GET') {
    const repo = u.searchParams.get('repo');
    const outDir = u.searchParams.get('outDir');
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir query params required' }); return true; }
    const jobKey = `${repo}::${outDir}`;
    const meta = readDrainMeta(outDir);
    const preparationKnown = ['pending', 'running', 'failed', 'ready'].includes(meta.preparationState);
    if (!queueStatus(outDir) && !preparationKnown && (!global.__drainJobs || !global.__drainJobs.has(jobKey))) {
      send(res, 404, { ok: false, error: 'no drain job found for this repo+outDir' }); return true;
    }
    const job = buildDrainJob(repo, outDir, global.__drainJobs && global.__drainJobs.get(jobKey));
    drainJobs.set(jobKey, job);
    send(res, 200, { ok: true, status: job }); return true;
  }

  if (p === '/onboard/drain-next' && m === 'POST') {
    const b = await readBody(req);
    const { repo, outDir, batchSize } = b;
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir required' }); return true; }
    const learnScript = path.join(__dirname, '..', 'scripts', 'onboard-learn.js');
    try {
      await runNode([learnScript, '--repo', repo, '--in', outDir, '--drain', '--batch', String(batchSize || DEFAULT_DRAIN_BATCH_SIZE)]);
    } catch (err) {
      writeDrainMeta(outDir, { repo, outDir, error: `drain failed: ${err && err.message ? err.message : err}` });
      send(res, 500, { ok: false, error: `drain failed: ${err && err.message ? err.message : err}` });
      return true;
    }
    send(res, 200, { ok: true, status: queueStatus(outDir) }); return true;
  }

  return false;
};
