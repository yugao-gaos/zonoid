'use strict';
const fs = require('fs');
const path = require('path');
const mcpCore = require('../lib/mcp-core');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, buildGraph, state, setState, setWorkspace,
    GIT_HEAD, BOOTED_AT, FEATURES, sseClients, overlayStore, harness, analytics,
    analyticsState, analyticsFlush, PUBLIC, loops, taskTranscript, usageCached,
    staleClaimKeys, releaseClaim, reapAgent, saveAgents, cache, targetOverlay, MCP_CALL,
    embedStatus, respCacheGet, respCachePut, isTruthy, frontier, agentsArr, sessionCount,
    WORKSPACES_FILE, graphStore, loadRegistry, repoToWorkspace, repoRoot } = ctx;

  if (p === '/ping') { send(res, 200, { ok: true, sessions: sessionCount() }); return true; }

  if (p === '/version') { send(res, 200, { head: GIT_HEAD, bootedAt: BOOTED_AT, features: FEATURES }); return true; }

  if (p === '/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 3000\n\ndata: changed\n\n');
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 25000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return true;
  }

  if (p === '/mcp') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version, x-orch-workspace', 'Access-Control-Expose-Headers': 'mcp-session-id' };
    if (m === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    if (m === 'GET') { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); res.write(': connected\n\n'); return true; }
    if (m === 'POST') {
      const msg = await readBody(req);
      const session = req.headers['mcp-session-id'] || null;
      const rpcArgs = msg && msg.params && msg.params.arguments;
      const rpcWorkspace = rpcArgs && typeof rpcArgs.workspace === 'string' ? rpcArgs.workspace : null;
      const reqWorkspace = u.searchParams.get('workspace') || req.headers['x-orch-workspace'] || rpcWorkspace || null;
      const call = reqWorkspace ? mcpCore.makeCall(Number(process.env.ORCH_PORT || 8787), reqWorkspace) : MCP_CALL;
      const resp = await mcpCore.handleRpc(msg, { call, uiHtml: mcpCore.uiHtml, session, workspace: reqWorkspace || undefined });
      if (resp === undefined) { res.writeHead(202, cors); res.end(); return true; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'orchestrator', 'Connection': 'close' });
      res.end(JSON.stringify(resp));
      return true;
    }
    send(res, 405, { error: 'method not allowed' }); return true;
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
    if (released) { overlayStore.save(ws, ovWs); notifyChange(); cache.agg.delete(ws); cache.aggAt.delete(ws); }
    send(res, 200, { ok: true, released }); return true;
  }

  if (p === '/workspace' && m === 'POST') {
    const b = await readBody(req);
    if (!b.path) { send(res, 400, { ok: false, error: 'path required' }); return true; }
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
    const resolvedRoot = repoRoot(b.path);
    const norm = (s) => {
      const resolved = path.resolve(s).replace(/[/\\]+$/, '');
      try { return fs.realpathSync(resolved).replace(/[/\\]+$/, ''); }
      catch { return resolved; }
    };
    // Climb ONLY when repoRoot found a STRICT ancestor (b.path is genuinely nested in a repo) and that
    // ancestor is not a filesystem "container" root (system temp / home / fs root) — an incidental
    // `.graph`/`.git` left in such a container must never re-home a fresh top-level workspace dir.
    // NOTE (U7, note note-mqj20ekamwy): the container-root guard is now ALSO enforced inside
    // lib/workspace-registry.repoRoot itself (so hooks + CLI callers benefit), meaning repoRoot can no
    // longer return a container root and this local `containers` check is redundant. It is kept as
    // cheap defense-in-depth at the climb seam (the climb decision is route-specific and reads clearer
    // with the guard inline); both layers agree, so the behavior is unchanged.
    const os = require('os');
    const containers = new Set([norm(os.tmpdir()), norm(os.homedir())]);
    const climbed = resolvedRoot
      && norm(resolvedRoot) !== norm(b.path)
      && !containers.has(norm(resolvedRoot))
      && path.dirname(norm(resolvedRoot)) !== norm(resolvedRoot); // not the fs root
    const repoRootPath = climbed ? resolvedRoot : b.path;
    setWorkspace(repoRootPath, { ...b, path: repoRootPath, workspace: b.workspace });
    send(res, 200, { ok: true, workspace: repoRootPath }); return true;
  }

  if (p === '/workspace/add-repo' && m === 'POST') {
    // Explicit "register this repo under this NAMED workspace group" op — no session bind, no SSE
    // pin. Distinct from POST /workspace (which binds the caller's session). Resolves a deep cwd to
    // its repo root, registers via the registry (idempotent, atomic v2 write), and warms the same
    // per-repo machinery setWorkspace does so the repo is immediately usable (overlay + merge driver).
    const b = await readBody(req);
    if (!b.workspace || typeof b.workspace !== 'string') { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    if (!b.repo || typeof b.repo !== 'string') { send(res, 400, { ok: false, error: 'repo required' }); return true; }
    const repoPath = repoRoot(b.repo) || b.repo;
    try {
      fs.mkdirSync(ctx.BASE, { recursive: true });
      require('../lib/workspace-registry').addRepo(WORKSPACES_FILE, { workspace: b.workspace, repo: repoPath });
    } catch (e) { send(res, 500, { ok: false, error: String(e && e.message || e) }); return true; }
    // Warm overlay + merge driver for the repo (same side-effects setWorkspace performs), so the
    // freshly registered repo is ready for graph ops without a separate /workspace bind.
    try {
      ctx.overlayFor(repoPath);
      graphStore.open(path.join(repoPath, '.graph'));
      graphStore.initGitAttributes(repoPath);
      ctx.git.ensureMergeDriver(repoPath);
    } catch { /* best effort warm — registration already persisted */ }
    notifyChange();
    send(res, 200, { ok: true, workspace: b.workspace, repo: repoPath }); return true;
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
    send(res, 200, { ok: true, phase: boot.phase, step: boot.step, progress: boot.progress, bootedAt: BOOTED_AT, head: GIT_HEAD, workspace: hwWs, sessions: sessionCount(), loops: loopHealth, embedding: embedStatus(), native_format: hwWs ? harness.tasks.formatHealth(hwWs) : null }); return true;
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

  if (p === '/state') {
    const stWs = u.searchParams.get('workspace');
    if (!stWs) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const stKey = `state|${stWs}|${u.searchParams.get('scope') || ''}|${u.searchParams.get('compact') || ''}|${u.searchParams.get('include_archived') || ''}|${u.searchParams.get('include_internal') || ''}|arch1`;
    const stHit = respCacheGet(stWs, stKey);
    if (stHit !== undefined) { send(res, 200, stHit); return true; }
    const T = targetOverlay(null, u);
    const ws = T.ws;
    const g = buildGraph(ws);
    const includeInternal = isTruthy(u.searchParams.get('include_internal'));
    const hiddenInternal = includeInternal ? new Set() : frontier.internalTaskIds(g.tasks);
    const graphTasks = includeInternal ? g.tasks : frontier.withoutInternalTasks(g.tasks, hiddenInternal);
    const edgesOut = frontier.withoutInternalEdges(
      T.ov.edges.map((e) => (e.kind === 'context' ? { ...e, weight: overlayStore.edgeWeight(e) } : e)),
      hiddenInternal,
    );
    const includeArchived = isTruthy(u.searchParams.get('include_archived'));
    const cfgDays = Number((T.ov.config || {}).archive_after_days);
    const windowMs = includeArchived ? Infinity : (cfgDays > 0 ? cfgDays : frontier.DEFAULT_ARCHIVE_DAYS) * 864e5;
    const keep = frontier.frontierKeep(graphTasks, { includeInternal: true });
    const arch = isFinite(windowMs) ? frontier.archivedIds(graphTasks, { windowMs, keep }) : new Set();
    const archivedTasks = arch.size ? frontier.archivedTaskList(graphTasks, arch) : null;
    if (u.searchParams.get('scope') === 'frontier') {
      const f = frontier.projectFrontier(graphTasks, g.ghosts, edgesOut, { windowMs, includeInternal: true });
      const body = { workspace: ws, scope: 'frontier', tasks: f.tasks, ghosts: f.ghosts, edges: f.edges, summary: { ...g.summary, archived: f.archived, frontier_kept: f.tasks.length } };
      if (archivedTasks) body.archived_tasks = archivedTasks;
      send(res, 200, respCachePut(stWs, stKey, body)); return true;
    }
    let tasks = graphTasks;
    const archived = arch.size;
    if (archived) tasks = tasks.filter((t) => !arch.has(t.id));
    const summary = { ...g.summary, archived };
    const archField = archivedTasks ? { archived_tasks: archivedTasks } : {};
    if (u.searchParams.get('compact')) {
      const slim = tasks.map((t) => {
        const o = { id: t.id, label: t.label, status: t.status, deps: t.deps };
        if (t.kind) o.kind = t.kind;
        if (t.agent_id) o.assignee = t.agent_id;
        frontier.copyReviewStateFields(o, t);
        if (t.git && t.git.merged) o.merged = true;
        return o;
      });
      send(res, 200, respCachePut(stWs, stKey, { workspace: ws, compact: true, tasks: slim, ghosts: g.ghosts, edges: edgesOut, summary, ...archField })); return true;
    }
    send(res, 200, respCachePut(stWs, stKey, { workspace: ws, tasks, ghosts: g.ghosts, edges: edgesOut, routes: state.routes, agents: agentsArr().filter((a) => a.workspace === ws), summary, config: T.ov.config || {}, ...archField })); return true;
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
    // repoToWorkspace keys are the raw stored paths; re-key by normPath so lookups match seenPaths.
    const repoWsNorm = new Map();
    for (const [repo, name] of repoWs) { repoWsNorm.set(normPath(repo), name); addPath(repo); }

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
        if (!fs.existsSync(wsPath)) return false;
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
