'use strict';
const path = require('path');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody } = ctx;

  if (p === '/onboard/enqueue' && m === 'POST') {
    const b = await readBody(req);
    const repo = b.repo;
    if (!repo) { send(res, 400, { ok: false, error: 'repo required' }); return true; }
    const outDir = b.outDir || path.join(__dirname, '..', 'bench', 'onboard', path.basename(repo));
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
    const autoInject = b.autoInject === true;
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir required' }); return true; }
    const jobKey = `${repo}::${outDir}`;
    if (drainJobs.has(jobKey)) {
      const existing = drainJobs.get(jobKey);
      if (!existing.done && !existing.error) {
        send(res, 200, { ok: true, status: existing, message: 'drain already in progress' }); return true;
      }
    }
    const { spawnSync, spawn } = require('child_process');
    const learnScript = path.join(__dirname, '..', 'scripts', 'onboard-learn.js');
    const statusR = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
    let initStatus = null;
    try { initStatus = JSON.parse(statusR.stdout || ''); } catch { /* ignore */ }
    const total = (initStatus && initStatus.total) || 0;
    const remaining = (initStatus && initStatus.remaining) || 0;
    const job = { repo, outDir, total, processed: total - remaining, remaining, done: remaining === 0, error: null, autoInject, injected: false, needsReview: remaining === 0 };
    drainJobs.set(jobKey, job);
    if (job.done) {
      if (autoInject) {
        const inj = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--inject', '--confirm'], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
        if (inj.status !== 0) { send(res, 500, { ok: false, error: `inject failed (exit ${inj.status})`, status: job }); return true; }
        job.injected = true;
        job.needsReview = false;
      }
      send(res, 200, { ok: true, status: job, message: 'queue already empty' }); return true;
    }
    const bs = String(batchSize || 50);
    (async () => {
      try {
        while (true) {
          await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--drain', '--batch', bs], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
            child.on('close', code => code === 0 ? resolve() : reject(new Error(`drain exited ${code}`)));
          });
          const stR = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
          let st = null;
          try { st = JSON.parse(stR.stdout || ''); } catch { /* ignore */ }
          if (st) { job.total = st.total || job.total; job.remaining = st.remaining || 0; job.processed = job.total - job.remaining; }
          if (!st || job.remaining === 0) break;
        }
        job.needsReview = true;
        if (autoInject) {
          const inj = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--inject', '--confirm'], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
          if (inj.status !== 0) throw new Error(`inject exited ${inj.status}`);
          job.injected = true;
          job.needsReview = false;
        }
        job.done = true; job.remaining = 0; job.processed = job.total;
      } catch (err) {
        job.error = String(err && err.message || err); job.done = true;
      }
    })();
    send(res, 200, { ok: true, status: job }); return true;
  }

  if (p === '/onboard/inject' && m === 'POST') {
    const b = await readBody(req);
    const { repo, outDir } = b;
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir required' }); return true; }
    const { spawnSync } = require('child_process');
    const learnScript = path.join(__dirname, '..', 'scripts', 'onboard-learn.js');
    const inj = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--inject', '--confirm'], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
    if (inj.status !== 0) { send(res, 500, { ok: false, error: `inject failed (exit ${inj.status})` }); return true; }
    const jobKey = `${repo}::${outDir}`;
    if (drainJobs.has(jobKey)) {
      const job = drainJobs.get(jobKey);
      job.injected = true;
      job.needsReview = false;
    }
    send(res, 200, { ok: true, injected: true }); return true;
  }

  if (p === '/onboard/drain-queue' && m === 'GET') {
    const repo = u.searchParams.get('repo');
    const outDir = u.searchParams.get('outDir');
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir query params required' }); return true; }
    const jobKey = `${repo}::${outDir}`;
    if (!global.__drainJobs || !global.__drainJobs.has(jobKey)) {
      send(res, 404, { ok: false, error: 'no drain job found for this repo+outDir' }); return true;
    }
    send(res, 200, { ok: true, status: global.__drainJobs.get(jobKey) }); return true;
  }

  if (p === '/onboard/drain-next' && m === 'POST') {
    const b = await readBody(req);
    const { repo, outDir, batchSize } = b;
    if (!repo || !outDir) { send(res, 400, { ok: false, error: 'repo and outDir required' }); return true; }
    const { spawnSync } = require('child_process');
    const learnScript = path.join(__dirname, '..', 'scripts', 'onboard-learn.js');
    const drainR = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--drain', '--batch', String(batchSize || 50)], { stdio: 'inherit', cwd: path.join(__dirname, '..'), windowsHide: true });
    if (drainR.status !== 0) { send(res, 500, { ok: false, error: `drain failed (exit ${drainR.status})` }); return true; }
    const statusR = spawnSync(process.execPath, [learnScript, '--repo', repo, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true });
    let status = null;
    try { status = JSON.parse(statusR.stdout || ''); } catch { /* ignore */ }
    send(res, 200, { ok: true, status }); return true;
  }

  return false;
};
