'use strict';
const fs = require('fs');
const path = require('path');
const {
  defaultOnboardOutDir,
  onboardRuntimeRoot,
  ensureOnboardRuntimeIgnored,
} = require('../lib/onboard-paths');

const DRAIN_STATUS_FILE = 'onboard-drain-status.json';
const DEFAULT_DRAIN_BATCH_SIZE = 20;

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}

function writeJSONAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
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

function drainStatusFile(outDir) {
  return path.join(outDir, DRAIN_STATUS_FILE);
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
  return { total: q.total, processed, kept, keptNotes, remaining, drainDone: remaining === 0, ...summarizeInflight(q) };
}

function readDrainMeta(outDir) {
  return readJSON(drainStatusFile(outDir), null) || {};
}

function writeDrainMeta(outDir, patch) {
  const prev = readDrainMeta(outDir);
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  writeJSONAtomic(drainStatusFile(outDir), next);
  return next;
}

function buildDrainJob(repo, outDir, patch = {}) {
  // The headless learner persists progress independently of the route process. A cached POST job
  // is only a fallback; it must never overwrite a newer on-disk injection result or error.
  const meta = { ...patch, ...readDrainMeta(outDir) };
  const persistedQueue = queueStatus(outDir);
  const qs = persistedQueue || {};
  const autoInject = meta.autoInject !== false;
  const drainDone = qs.drainDone === true;
  const noCandidates = drainDone && qs.total === 0;
  const error = meta.error || null;
  const kept = typeof qs.kept === 'number' ? qs.kept : (meta.kept || 0);
  const injectedKept = Math.max(0, Number(meta.injectedKept) || (meta.injected === true ? kept : 0));
  // `meta.injected` means at least one injection pass succeeded. A later learner batch can add
  // more kept notes, so completion requires the injected watermark to cover the current queue.
  const injected = meta.injected === true && injectedKept >= kept;
  const processed = qs.processed || meta.processed || 0;
  const visualProcessed = Math.max(processed, qs.visualProcessed || meta.visualProcessed || 0);
  const preparationState = persistedQueue && meta.preparationForce !== true
    ? 'ready'
    : (meta.preparationState || (persistedQueue ? 'ready' : 'idle'));
  const preparing = preparationState === 'pending' || preparationState === 'running';
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
    done: (!!error && !persistedQueue) || (drainDone && (noCandidates || !autoInject || injected || !!error)),
    error,
    autoInject,
    injected,
    injecting: meta.injecting === true,
    preparing,
    preparationState,
    preparationStage: meta.preparationStage || null,
    preparationAttempts: Math.max(0, Number(meta.preparationAttempts) || 0),
    noCandidates,
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
        preparationState: 'pending',
        preparationStage: null,
        preparationRequestedAt: new Date().toISOString(),
        preparationForce: b.force === true,
        preparationPid: null,
        preparationLeaseExpiresAt: null,
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
    writeDrainMeta(outDir, {
      repo,
      outDir,
      batchSize: batchSize || DEFAULT_DRAIN_BATCH_SIZE,
      autoInject,
      injecting: false,
      // A failed preparation is terminal until /onboard/enqueue explicitly rearms it. Merely
      // polling/arming the drain must not erase the persisted failure and strand an idle queue.
      ...(status || meta.preparationState !== 'failed' ? { error: null } : {}),
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
    try {
      writeDrainMeta(outDir, { repo, outDir, injecting: true, error: null });
      await runNode([learnScript, '--repo', repo, '--in', outDir, '--inject', '--confirm']);
      const injectedKept = (queueStatus(outDir) || {}).kept || 0;
      writeDrainMeta(outDir, { repo, outDir, injecting: false, injected: true, injectedKept, injectedAt: new Date().toISOString(), error: null });
    } catch (err) {
      writeDrainMeta(outDir, { repo, outDir, injecting: false, error: String(err && err.message || err) });
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
