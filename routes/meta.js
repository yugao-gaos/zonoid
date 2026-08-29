'use strict';
const fs = require('fs');
const path = require('path');
const mcpCore = require('../lib/mcp-core');
const workspaceRegistry = require('../lib/workspace-registry');

// Package identity for /version — resolved once at module load; tolerant of a broken checkout.
const PKG_VERSION = (() => {
  try { return require('../package.json').version || null; } catch { return null; }
})();

const NATIVE_FORMAT_HEALTH_TTL_MS = 10_000;
const nativeFormatHealthCache = new Map();

function nativeFormatHealth(harness, workspace) {
  if (!workspace) return null;
  const hit = nativeFormatHealthCache.get(workspace);
  const nowMs = Date.now();
  if (hit && nowMs - hit.ts < NATIVE_FORMAT_HEALTH_TTL_MS) return hit.value;
  const value = harness.tasks.formatHealth(workspace);
  nativeFormatHealthCache.set(workspace, { ts: nowMs, value });
  return value;
}

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, state, setState, setWorkspace,
    GIT_HEAD, DAEMON_BUILD_ID, BOOTED_AT, FEATURES, sseClients, overlayStore, harness, analytics,
    analyticsState, analyticsFlush, PUBLIC, loops, taskTranscript, usageCached,
    staleClaimKeys, releaseClaim, reapAgent, saveAgents, cache, targetOverlay, buildGraph,
    embedStatus, isTruthy, sessionCount,
    WORKSPACES_FILE, graphStore, loadRegistry, repoToWorkspace, repoRoot, registrationRepoRoot } = ctx;

  if (p === '/ping') { send(res, 200, { ok: true, sessions: sessionCount() }); return true; }

  if (p === '/version') {
    // Existing fields (head/bootedAt/features) are load-bearing: hooks/restart-daemon.sh compares
    // /version.head against the on-disk HEAD to decide "restart required" — only ADD fields here.
    const daemonLog = ctx.daemonLog || require('../lib/daemon-log');
    send(res, 200, {
      ok: true,
      head: GIT_HEAD,
      build: DAEMON_BUILD_ID,
      bootedAt: BOOTED_AT,
      features: FEATURES,
      version: PKG_VERSION,
      node: process.version,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      log_path: typeof daemonLog.logPath === 'function' ? daemonLog.logPath() : null,
    });
    return true;
  }

  if (p === '/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 3000\n\ndata: changed\n\n');
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 25000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return true;
  }

  if (p === '/reset' && m === 'POST') {
    // P3: state no longer holds a global workspace/overlay — reset only the genuinely global
    // registries (agents/routes), preserving per-session bindings. Overlays live in the per-
    // workspace cache, untouched here.
    setState({ routes: [], agents: {}, sessions: state.sessions || {} });
    send(res, 200, { ok: true }); return true;
  }

  if (p === '/sweep' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const ws = T.ws;
    const ovWs = T.ov;
    const staleMins = b.stale_minutes != null ? Number(b.stale_minutes) : 1;
    const nowMs = Date.now();
    const cutoff = nowMs - staleMins * 60000;
    let released = 0;
    let agentsDirty = false;
    const stWsSweep = { ...state, overlay: ovWs };
    if (b.force) {
      for (const [key, st] of Object.entries(ovWs.status)) {
        if (st !== 'in_progress') continue;
        const agentId = ovWs.assignee[key];
        const ts = ovWs.timestamps[key];
        if (ts && Date.parse(ts.lastChanged) > cutoff) continue;
        const tp = taskTranscript(key, null, true, stWsSweep);
        const tokenUsage = tp ? usageCached(tp) : null;
        if (releaseClaim(key, `sweep: worker '${agentId || '?'}' idle >${staleMins}m (force=true)`, ovWs, { agentId, mins: staleMins, tokenUsage }, ws)) {
          released++;
          // Reap the owning agent in lockstep with the claim, same as sweepStaleClaims: this key was
          // selected for release (force bypasses vouchedLive), so its 'running' record is a zombie —
          // drop it out of /health's running count now instead of waiting for sweepStaleAgents' 60s pass.
          if (reapAgent(agentId)) agentsDirty = true;
        }
      }
    } else {
      const sweepOv = staleMins !== (ovWs.config.stale_minutes ?? (ctx.STALE_MINUTES_DEFAULT ?? 60))
        ? { ...ovWs, config: { ...ovWs.config, stale_minutes: staleMins } } : ovWs;
      for (const { key, agentId, mins } of staleClaimKeys(sweepOv, state.agents, nowMs)) {
        const tp = taskTranscript(key, null, true, stWsSweep);
        const tokenUsage = tp ? usageCached(tp) : null;
        if (releaseClaim(key, `sweep: worker '${agentId || '?'}' idle >${mins}m`, ovWs, { agentId, mins, tokenUsage }, ws)) {
          released++;
          if (reapAgent(agentId)) agentsDirty = true;
        }
      }
    }
    if (agentsDirty) saveAgents();
    if (released) { overlayStore.save(ws, ovWs); notifyChange(ws); cache.agg.delete(ws); cache.aggAt.delete(ws); }
    send(res, 200, { ok: true, released }); return true;
  }

  if (p === '/workspace' && m === 'POST') {
    const b = await readBody(req);
    const requestedGraphRepo = b.graph_repo || b.path;
    if (!requestedGraphRepo) { send(res, 400, { ok: false, error: 'graph_repo required (deprecated alias: path)' }); return true; }
    // P3: setWorkspace REGISTERS + BINDS the workspace (no global default to flip), so the old
    // "skip when a different workspace is already pinned" guard is gone — each call just registers
    // and binds its own path.
    // Workspace model (U3): a workspace is a NAMED group of repos. `b.path` is a repo; if a deep cwd
    // was passed (a subdir BELOW an existing .graph/.git repo), resolve UP to the containing repo so
    // we register the REPO, not a subdir. The optional `b.workspace` names the group it joins
    // (setWorkspace defaults it to basename(repoRoot) — a single-repo workspace — when absent).
    //
    // Resolution is conservative: a path that is ALREADY a repo root (has its own .graph or .git) is
    // used verbatim, and a brand-new workspace dir with NO marker is registered AS GIVEN (setWorkspace
    // creates its .graph). We only substitute repoRoot's result when it CLIMBED to a STRICT ANCESTOR
    // — i.e. b.path is genuinely nested inside an existing repo — so a fresh top-level workspace dir is
    // never silently re-homed onto a stray ancestor marker.
    const repoRootPath = (registrationRepoRoot || require('../lib/workspace-registry').registrationRepoRoot)(requestedGraphRepo);
    const workspaceId = b.workspace_id || b.workspace || path.basename(repoRootPath);
    try {
      setWorkspace(repoRootPath, { ...b, path: repoRootPath, workspace: workspaceId });
    } catch (e) {
      send(res, 500, { ok: false, error: `workspace registration failed: ${String(e && e.message || e)}` });
      return true;
    }
    send(res, 200, { ok: true, workspace_id: workspaceId, graph_repo: repoRootPath, workspace: repoRootPath }); return true;
  }

  if (p === '/workspace/add-repo' && m === 'POST') {
    // Explicit "register this repo under this NAMED workspace group" op — no session bind, no SSE
    // pin. Distinct from POST /workspace (which binds the caller's session). Resolves a deep cwd to
    // its repo root, registers via the registry (idempotent, atomic v2 write), and warms the same
    // per-repo machinery setWorkspace does so the repo is immediately usable (overlay + merge driver).
    const b = await readBody(req);
    const workspaceId = b.workspace_id || b.workspace;
    if (!workspaceId || typeof workspaceId !== 'string') { send(res, 400, { ok: false, error: 'workspace_id required (deprecated alias: workspace)' }); return true; }
    const requestedGraphRepo = b.graph_repo || b.repo;
    if (!requestedGraphRepo || typeof requestedGraphRepo !== 'string') { send(res, 400, { ok: false, error: 'graph_repo required (deprecated alias: repo)' }); return true; }
    const repoPath = repoRoot(requestedGraphRepo) || requestedGraphRepo;
    try {
      fs.mkdirSync(ctx.BASE, { recursive: true });
      require('../lib/workspace-registry').addRepo(WORKSPACES_FILE, { workspace: workspaceId, repo: repoPath });
    } catch (e) { send(res, 500, { ok: false, error: String(e && e.message || e) }); return true; }
    // Warm overlay + merge driver for the repo (same side-effects setWorkspace performs), so the
    // freshly registered repo is ready for graph ops without a separate /workspace bind.
    try {
      ctx.overlayFor(repoPath);
      graphStore.open(path.join(repoPath, '.graph'));
      graphStore.initGitAttributes(repoPath);
      ctx.git.ensureMergeDriver(repoPath);
    } catch { /* best effort warm — registration already persisted */ }
    notifyChange(repoPath);
    send(res, 200, { ok: true, workspace_id: workspaceId, graph_repo: repoPath, workspace: workspaceId, repo: repoPath }); return true;
  }

  if (p === '/analytics/tool-call' && m === 'POST') {
    const b = await readBody(req);
    if (!b.tool || typeof b.tool !== 'string') { send(res, 400, { ok: false, error: 'tool required' }); return true; }
    analytics.record(analyticsState, b.tool, !!b.error, b.workspace || null);
    analyticsFlush.soon();
    send(res, 200, { ok: true }); return true;
  }
  if (p === '/analytics/tools' && m === 'GET') {
    const tools = analytics.report(analyticsState, mcpCore.TOOLS.map((t) => t.name));
    send(res, 200, { ok: true, total_calls: tools.reduce((s2, t) => s2 + t.total, 0), tools }); return true;
  }
  if (p === '/analytics' && m === 'GET') { send(res, 200, fs.readFileSync(path.join(PUBLIC, 'analytics.html'), 'utf8'), 'text/html; charset=utf-8'); return true; }

  if (p === '/health') {
    // Boot-phase fields lead: /health is whitelisted through the 503 loading gate, so during
    // startup the dashboard polls it for {phase, step, progress, bootedAt} (boot-overlay contract).
    const boot = ctx.bootState || { phase: 'ready', step: 'ready', progress: 1 };
    const allLoops = [...loops.values()];
    const loopHealth = { count: allLoops.length, active: allLoops.filter((L) => L.active).length, iterations: allLoops.reduce((s, L) => s + L.iterations, 0), spent: allLoops.reduce((s, L) => s + L.spent, 0) };
    // P3: no global current workspace. `workspace`/`native_format` reflect the OPTIONAL ?workspace=
    // the dashboard passes (null when absent — health is otherwise workspace-agnostic).
    const hwWs = u.searchParams.get('workspace') || null;
    send(res, 200, { ok: true, phase: boot.phase, step: boot.step, progress: boot.progress, bootedAt: BOOTED_AT, head: GIT_HEAD, build: DAEMON_BUILD_ID, pid: process.pid, workspace: hwWs, sessions: sessionCount(), loops: loopHealth, embedding: embedStatus(), native_format: nativeFormatHealth(harness, hwWs) }); return true;
  }

  if (p === '/ready') {
    const ws = u.searchParams.get('workspace');
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const g = buildGraph(ws);
    const sessionParam = u.searchParams.get('session');
    const rootsParam = u.searchParams.get('roots');
    let ready = g.tasks.filter((t) => t.status === 'ready');
    if (sessionParam || rootsParam) {
      const seeds = new Set();
      if (rootsParam) for (const k of rootsParam.split(',').map((s) => s.trim()).filter(Boolean)) seeds.add(k);
      if (sessionParam) for (const t of g.tasks) { if (t.session === sessionParam) seeds.add(t.id); }
      const children = {};
      for (const t of g.tasks) for (const dep of t.deps) { (children[dep] = children[dep] || []).push(t.id); }
      const descendants = new Set(seeds);
      const queue = [...seeds];
      while (queue.length) { const n = queue.shift(); for (const c of (children[n] || [])) { if (!descendants.has(c)) { descendants.add(c); queue.push(c); } } }
      ready = ready.filter((t) => descendants.has(t.id) && !seeds.has(t.id));
    }
    send(res, 200, { ready: ready.map((t) => ({ key: t.id, label: t.label })) }); return true;
  }

  if (p === '/workspaces' && m === 'GET') {
    // Build the union of all known REPOS for the dashboard workspace switcher, GROUPED by their
    // named workspace (U3 workspace model: a workspace is a NAMED group of repos; each repo keeps its
    // own .graph). Sources (all deduped): v2 registry (ctx.loadRegistry, migrates legacy v1) +
    // sessions + agents + graphStore known dirs. (P3: no daemon-global current workspace to seed.)
    // Cheap: NO buildGraph per repo — just path enumeration + basename + the repo->workspace index.
    const seenPaths = new Set();
    // Normalize to the OS-native separator and resolve any trailing sep — so Windows paths with
    // forward-slash variants (stored e.g. from ?workspace= URL decode) dedup against backslash ones.
    const normPath = (p2) => p2.replace(/[/\\]+$/, '').replace(/\//g, path.sep);
    const addPath = (p2) => { if (p2 && typeof p2 === 'string') seenPaths.add(normPath(p2)); };

    // 1. Registry file (persisted across restarts) — v2 grouped registry via ctx.loadRegistry, which
    //    lazily migrates a legacy v1 flat array. Build the repo->workspace reverse index from it; all
    //    member repos are registry-known repos that join their named group.
    const reg = loadRegistry();
    const repoWs = repoToWorkspace(reg);            // Map<normalizedRepoPath, workspaceName>
    const registeredRepos = workspaceRegistry.allRepos(reg);
    // Registry history keeps raw mount paths. Re-key active entries by their canonical repo root so
    // a linked worktree resolves to its primary checkout while absent paths remain history-only.
    const repoWsNorm = new Map();
    for (const [repo, name] of repoWs) {
      const activeRepo = workspaceRegistry.activeRepoRoot(repo, { registeredRepos });
      if (!activeRepo) continue;
      const normalized = normPath(activeRepo);
      repoWsNorm.set(normalized, workspaceRegistry.preferWorkspaceId(repoWsNorm.get(normalized), name));
      addPath(activeRepo);
    }

    // 2. (P3) No daemon-global current workspace — sessions/agents/registry are the sources.

    // 3. Distinct session workspaces (repos)
    for (const s of Object.values(state.sessions || {})) addPath(s.workspace);

    // 4. Distinct agent workspaces (repos)
    for (const a of Object.values(state.agents || {})) addPath(a.workspace);

    // 5. graphStore opened dirs (strip /.graph suffix) — these contribute REPOS too.
    for (const store of graphStore.allStores()) {
      const dir = store.dir;
      if (dir && dir.endsWith(path.sep + '.graph')) addPath(dir.slice(0, -(path.sep.length + 6)));
      else if (dir && dir.endsWith('/.graph')) addPath(dir.slice(0, -7));
    }

    // P3: no daemon-global current workspace; the dashboard tracks its own selected workspace
    // client-side. Reflect back the OPTIONAL ?workspace= the caller passed (else null). `current` on a
    // repo entry = that repo path matching ?workspace=.
    const current = u.searchParams.get('workspace') || null;
    const currentNorm = current ? normPath(current) : null;
    // Filter: keep only paths that still exist on disk AND have a .graph dir (are real repos),
    // AND are not git worktrees (orchestrator attempt/feature branches where .git is a FILE, not a
    // directory — a gitdir-pointer file written by `git worktree add`). Worktrees accumulate in
    // graphStore._stores via ?workspace= reads but should never appear in the user-facing switcher.
    const repoEntries = [...seenPaths]
      .filter((wsPath) => {
        if (!workspaceRegistry.isActiveRepoPath(wsPath)) return false;
        if (!fs.existsSync(path.join(wsPath, '.graph'))) return false;
        // Exclude git worktrees: in a worktree .git is a regular file (gitdir pointer), not a dir.
        try { if (fs.statSync(path.join(wsPath, '.git')).isFile()) return false; } catch { /* no .git = not a repo clone, allow */ }
        return true;
      })
      .map((wsPath) => ({
        path: wsPath,
        name: path.basename(wsPath),
        current: wsPath === currentNorm,
      }));

    // ?flat=1 — legacy OLD flat shape [{path,name,current}] for U6 rollout compatibility.
    if (isTruthy(u.searchParams.get('flat'))) {
      send(res, 200, { ok: true, current, workspaces: repoEntries }); return true;
    }

    // GROUPED shape: [{ name, repos:[{path,name,current}], current }]. Each repo attaches to its
    // workspace via the registry reverse index; repos present on disk but NOT in the registry
    // (graphStore/session/agent dirs that were never `addRepo`'d) bucket under a synthetic
    // "(unregistered)" group. A group's `current` = it owns the repo matching ?workspace=.
    const ORPHAN = '(unregistered)';
    const groups = new Map();   // name -> { name, repos:[], current }
    const groupFor = (name) => {
      let g = groups.get(name);
      if (!g) { g = { name, repos: [], current: false }; groups.set(name, g); }
      return g;
    };
    for (const repo of repoEntries) {
      const name = repoWsNorm.get(repo.path) || ORPHAN;
      const g = groupFor(name);
      g.repos.push(repo);
      if (repo.current) g.current = true;
    }
    const workspaces = [...groups.values()];

    send(res, 200, { ok: true, current, workspaces }); return true;
  }

  return false;
};
