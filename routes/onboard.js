'use strict';
const fs = require('fs');
const path = require('path');
const { defaultOnboardOutDir } = require('../lib/onboard-paths');

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
  const meta = { ...readDrainMeta(outDir), ...patch };
  const qs = queueStatus(outDir) || {};
  const autoInject = meta.autoInject !== false;
  const injected = meta.injected === true;
  const drainDone = qs.drainDone === true;
  const error = meta.error || null;
  const kept = typeof qs.kept === 'number' ? qs.kept : (meta.kept || 0);
  const injectedKept = Math.max(0, Number(meta.injectedKept) || (injected ? kept : 0));
  const processed = qs.processed || meta.processed || 0;
  const visualProcessed = Math.max(processed, qs.visualProcessed || meta.visualProcessed || 0);
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
    done: drainDone && (!autoInject || injected || !!error),
    error,
    autoInject,
    injected,
    injecting: meta.injecting === true,
    needsReview: drainDone && !autoInject && !injected,
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
    if (!b.force && existingStatus && existingStatus.total > 0 && existingStatus.drainDone && existingMeta.repo === repo) {
      send(res, 200, { ok: true, total: existingStatus.total, remaining: existingStatus.remaining, outDir, reused: true, completed: true });
      return true;
    }
    const { spawnSync } = require('child_process');
    const SCRIPTS = path.join(__dirname, '..', 'scripts');
    for (const s of ['onboard-mine-structure.js', 'onboard-mine-git.js', 'onboard-mine-docs.js', 'onboard-mine-assets.js', 'onboard-mine-config.js']) {
      spawnSync(process.execPath, [path.join(SCRIPTS, s), '--repo', repo, '--out', outDir], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
    }
    const enqR = spawnSync(process.execPath, [path.join(SCRIPTS, 'onboard-learn.js'), '--repo', repo, '--in', outDir, '--enqueue'], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
    if (enqR.status !== 0) { send(res, 500, { ok: false, error: `enqueue failed (exit ${enqR.status})` }); return true; }
    const statusR = spawnSync(process.execPath, [path.join(SCRIPTS, 'onboard-learn.js'), '--repo', repo, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
    let status = null;
    try { status = JSON.parse(statusR.stdout || ''); } catch { /* ignore */ }
    send(res, 200, { ok: true, total: status && status.total, remaining: status && status.remaining, outDir }); return true;
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
    if (!status) { send(res, 404, { ok: false, error: 'queue not found for this repo+outDir' }); return true; }
    writeDrainMeta(outDir, { repo, outDir, batchSize: batchSize || DEFAULT_DRAIN_BATCH_SIZE, autoInject, injecting: false, error: null });
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
      writeDrainMeta(outDir, { repo, outDir, injecting: false, injected: true, injectedAt: new Date().toISOString(), error: null });
    } catch (err) {
      writeDrainMeta(outDir, { repo, outDir, injecting: false, error: String(err && err.message || err) });
      send(res, 500, { ok: false, error: `inject failed: ${err && err.message ? err.message : err}` }); return true;
    }
    const jobKey = `${repo}::${outDir}`;
    if (drainJobs.has(jobKey)) {
      const job = drainJobs.get(jobKey);
      job.injected = true;
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
    if (!queueStatus(outDir) && (!global.__drainJobs || !global.__drainJobs.has(jobKey))) {
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
    const { spawnSync } = require('child_process');
    const learnScript = path.join(__dirname, '..', 'scripts', 'onboard-learn.js');
    const drainR = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--drain', '--batch', String(batchSize || DEFAULT_DRAIN_BATCH_SIZE)], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
    if (drainR.status !== 0) { send(res, 500, { ok: false, error: `drain failed (exit ${drainR.status})` }); return true; }
    const statusR = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
    let status = null;
    try { status = JSON.parse(statusR.stdout || ''); } catch { /* ignore */ }
    send(res, 200, { ok: true, status }); return true;
  }

  return false;
};
