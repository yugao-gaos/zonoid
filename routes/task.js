'use strict';
const overlayStore = require('../lib/overlay');
const measure = require('../lib/measure');
const git = require('../lib/git');

function isAdmissibleOverlayTaskKey(key) {
  return typeof key === 'string'
    && (/^[^/\s]+\/[^/\s]+$/.test(key) || /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key));
}

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, buildGraph, state, targetOverlay, nodeExistsInGraph,
    validateMetricSpec, validateBenchmark, resolveRepo, taskTranscript, usageCached } = ctx;
  const graphHasKey = (ws, key) => {
    if (typeof nodeExistsInGraph !== 'function') return true;
    return nodeExistsInGraph(buildGraph(ws), key);
  };
  const acceptsTaskKey = (T, key) => graphHasKey(T.ws, key) || isAdmissibleOverlayTaskKey(key);
  const ensureTaskSnapshot = (T, key) => {
    if (!isAdmissibleOverlayTaskKey(key)) return;
    if (T.ov.snapshots && T.ov.snapshots[key]) return;
    overlayStore.setSnapshot(T.ov, key, {
      subject: key,
      description: '',
      status: T.ov.status[key] || 'pending',
      blockedBy: [],
      owner: null,
      metadata: { synthetic_overlay_task: true },
    });
    if (!T.ov.timestamps) T.ov.timestamps = {};
    if (!T.ov.timestamps[key]) {
      const ts = new Date().toISOString();
      T.ov.timestamps[key] = { firstSeen: ts, lastChanged: ts, lastStatus: T.ov.status[key] || 'pending' };
    }
    if (ctx.cache) {
      if (ctx.cache.agg) ctx.cache.agg.delete(T.ws);
      if (ctx.cache.aggAt) ctx.cache.aggAt.delete(T.ws);
    }
  };

  if (p === '/task/metric' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!nodeExistsInGraph(buildGraph(T.ws), b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    if (b.spec) {
      const err = validateMetricSpec(b.spec);
      if (err) { send(res, 400, { ok: false, error: err }); return true; }
    }
    overlayStore.setMetricSpec(T.ov, b.key, b.spec || null);
    T.save(); ctx.notifyChange();
    send(res, 200, { ok: true, key: b.key, metric: T.ov.metrics[b.key] || null }); return true;
  }

  if (p === '/task/benchmark' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!nodeExistsInGraph(buildGraph(T.ws), b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    if (b.benchmark) {
      const err = validateBenchmark(b.benchmark);
      if (err) { send(res, 400, { ok: false, error: err }); return true; }
    }
    overlayStore.setBenchmark(T.ov, b.key, b.benchmark || null);
    T.save(); ctx.notifyChange();
    send(res, 200, { ok: true, key: b.key, benchmark: T.ov.benchmarks[b.key] || null }); return true;
  }

  if (p === '/task/measure' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!nodeExistsInGraph(buildGraph(T.ws), b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    const spec = T.ov.metrics && T.ov.metrics[b.key];
    if (!spec) { send(res, 409, { ok: false, error: 'no metric spec on task: set one with configure_task (metric) first' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov);
    if (!repo || !git.isRepo(repo)) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const cwd = b.baseline ? repo : git.createWorktree(repo, b.key).worktree;
    let result;
    try { result = measure.runMeasure(cwd, spec); }
    catch (e) { send(res, 422, { ok: false, error: String(e.message || e) }); return true; }
    const record = { ...result, command: spec.measure_command, measured_at: new Date().toISOString() };
    overlayStore.setMeasurement(T.ov, b.key, b.baseline ? { baseline: record } : record);
    T.save(); ctx.notifyChange();
    send(res, 200, { ok: true, key: b.key, baseline: !!b.baseline, repo, measurement: T.ov.measurements[b.key] }); return true;
  }

  if (p === '/task/context') {
    const T = targetOverlay(null, u);
    const g = buildGraph(T.ws);
    const t = g.tasks.find((x) => x.id === u.searchParams.get('key'));
    if (!t) { send(res, 404, { ok: false, error: 'unknown task' }); return true; }
    const mk = (d, kind) => { const dep = g.tasks.find((x) => x.id === d); return { key: d, label: dep ? dep.label : d, status: dep ? dep.status : '?', summary: (dep && dep.summary) || T.ov.summaries[d] || '', via: kind }; };
    const cw = t.context_weights || {};
    const blockingSummaries = t.deps.filter((d) => !d.startsWith('ghost:')).map((d) => mk(d, 'blocking'));
    const contextSummaries = t.context_deps.filter((d) => !d.startsWith('ghost:')).map((d) => {
      const weight = cw[d] != null ? cw[d] : overlayStore.DEFAULT_CONTEXT_WEIGHT;
      return { ...mk(d, 'context'), weight };
    });
    contextSummaries.sort((a, b) => b.weight - a.weight);
    const summaries = [...blockingSummaries, ...contextSummaries];
    const allGhostRefs = [...t.deps, ...t.context_deps];
    const ghost = g.ghosts.filter((gh) => allGhostRefs.includes(`ghost:${gh.workspace}|${gh.key}`)).map((gh) => ({ workspace: gh.workspace, key: gh.key, label: gh.label, status: gh.status }));
    send(res, 200, { task: { id: t.id, label: t.label, status: t.status }, dependencySummaries: summaries, ghostDependencies: ghost }); return true;
  }

  if (p === '/task/suggest') {
    const ws = u.searchParams.get('workspace');
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const g = buildGraph(ws);
    const key = u.searchParams.get('key');
    const target = g.tasks.find((x) => x.id === key);
    if (!target) { send(res, 404, { ok: false, error: 'unknown task' }); return true; }
    const { suggestions, duplicates, hint } = await ctx.suggestForTask(g, target);
    send(res, 200, { task: { id: target.id, label: target.label }, suggestions, duplicates, hint }); return true;
  }

  if (p === '/task/tree') {
    const key = u.searchParams.get('key');
    const maxDepth = Math.min(parseInt(u.searchParams.get('depth') || '6', 10) || 6, 25);
    const T = targetOverlay(null, u);
    const g = buildGraph(T.ws);
    const byId = Object.fromEntries(g.tasks.map((t) => [t.id, t]));
    const root = byId[key];
    if (!root) { send(res, 404, { ok: false, error: 'unknown task' }); return true; }
    const ancestors = [], ghostFrontier = [], seen = new Set([key]);
    let frontier2 = [{ key, depth: 0 }];
    while (frontier2.length) {
      const next = [];
      for (const { key: k, depth } of frontier2) {
        if (depth >= maxDepth) continue;
        const t = byId[k];
        if (!t) continue;
        for (const d of t.deps) {
          if (d.startsWith('ghost:')) {
            const gh = g.ghosts.find((x) => `${x.workspace}|${x.key}` === d.slice('ghost:'.length));
            if (gh) ghostFrontier.push({ workspace: gh.workspace, key: gh.key, label: gh.label, status: gh.status, via: k, depth: depth + 1 });
            continue;
          }
          if (seen.has(d)) continue;
          seen.add(d);
          const dep = byId[d];
          if (!dep) continue;
          ancestors.push({ key: dep.id, label: dep.label, status: dep.status, summary: T.ov.summaries[dep.id] || '', depth: depth + 1, via: k });
          next.push({ key: d, depth: depth + 1 });
        }
      }
      frontier2 = next;
    }
    send(res, 200, { root: { key: root.id, label: root.label, status: root.status }, maxDepth, ancestors, ghostFrontier }); return true;
  }

  if (p === '/task/detail') {
    const key = u.searchParams.get('key');
    const T = targetOverlay(null, u);
    const g = buildGraph(T.ws);
    const t = g.tasks.find((x) => x.id === key);
    if (!t) { send(res, 404, { ok: false, error: 'unknown task' }); return true; }
    const assignee = T.ov.assignee[key] || null;
    const agent = assignee ? state.agents[assignee] : null;
    send(res, 200, {
      task: t,
      summary: T.ov.summaries[key] || '',
      knowledge: T.ov.knowledge[key] || [],
      git: T.ov.git[key] || null,
      repo: (T.ov.repos && T.ov.repos[key]) || null,
      test_cmd: overlayStore.testCmdFor(T.ov, (T.ov.repos && T.ov.repos[key]) || null),
      metric: (T.ov.metrics && T.ov.metrics[key]) || null,
      measurement: (T.ov.measurements && T.ov.measurements[key]) || null,
      benchmark: (T.ov.benchmarks && T.ov.benchmarks[key]) || null,
      assignee,
      cancel_requested: T.ov.cancel_requested[key] || null,
      blocked: (T.ov.blocked && T.ov.blocked[key]) || null,
      tokenUsage: (() => { const tp = taskTranscript(key, t.session, true); return tp ? usageCached(tp) : null; })(),
      transcript: (() => { const tp = taskTranscript(key, t.session, true); return tp || null; })(),
    }); return true;
  }

  if (p === '/task/adjacent') {
    const key = u.searchParams.get('key');
    const ws = u.searchParams.get('workspace');
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const g = buildGraph(ws);
    const t = g.tasks.find((x) => x.id === key);
    if (!t) { send(res, 404, { ok: false, error: 'unknown task', key }); return true; }
    const deps = g.tasks.filter((x) => t.deps.includes(x.id));
    const ghostDeps = g.ghosts.filter((gh) => t.deps.includes(`ghost:${gh.workspace}|${gh.key}`));
    const dependents = g.tasks.filter((x) => x.deps.includes(key));
    send(res, 200, { task: t, dependencies: deps, ghostDependencies: ghostDeps, dependents }); return true;
  }

  if (p === '/mark-root' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    const key = b.task_key || b.key;
    if (!key) { send(res, 400, { ok: false, error: 'task_key required' }); return true; }
    if (!acceptsTaskKey(T, key)) {
      send(res, 404, { ok: false, error: `unknown task: ${key}` }); return true;
    }
    ensureTaskSnapshot(T, key);
    const wasUnwired = !!(T.ov.unwired && T.ov.unwired[key]);
    if (T.ov.unwired) delete T.ov.unwired[key];
    T.ov.notes[key] = `root: ${b.reason || 'declared standalone root'}`.slice(0, 280);
    T.save(); ctx.notifyChange();
    send(res, 200, { ok: true, key, was_unwired: wasUnwired }); return true;
  }

  if (p === '/attempt/diff') {
    const key = u.searchParams.get('key');
    if (!key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const T = targetOverlay(null, u);
    const repo = resolveRepo(key, u.searchParams.get('repo_path'), T.ov, T.ws);
    if (!repo || !git.isRepo(repo)) { send(res, 409, { ok: false, error: 'target repo is not a git repo' }); return true; }
    const r = git.attemptDiff(repo, key);
    if (!r.ok) { send(res, 404, { ok: false, error: r.reason, key }); return true; }
    send(res, 200, { ok: true, key, branch: r.branch, base: r.base, stat: r.stat, diff: r.diff }); return true;
  }

  if (p === '/peek') {
    const ws = u.searchParams.get('workspace');
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    send(res, 200, buildGraph(ws)); return true;
  }

  return false;
};
