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
    WORKSPACES_FILE, graphStore } = ctx;

  if (p === '/ping') { send(res, 200, { ok: true, workspace: state.workspace, sessions: sessionCount() }); return true; }

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
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version', 'Access-Control-Expose-Headers': 'mcp-session-id' };
    if (m === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    if (m === 'GET') { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); res.write(': connected\n\n'); return true; }
    if (m === 'POST') {
      const msg = await readBody(req);
      const session = req.headers['mcp-session-id'] || null;
      const resp = await mcpCore.handleRpc(msg, { call: MCP_CALL, uiHtml: mcpCore.uiHtml, session });
      if (resp === undefined) { res.writeHead(202, cors); res.end(); return true; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'orchestrator', 'Connection': 'close' });
      res.end(JSON.stringify(resp));
      return true;
    }
    send(res, 405, { error: 'method not allowed' }); return true;
  }

  if (p === '/reset' && m === 'POST') {
    setState({ workspace: state.workspace, overlay: state.workspace ? overlayStore.load(state.workspace) : overlayStore.EMPTY(), routes: [], agents: {}, sessions: state.sessions || {} });
    send(res, 200, { ok: true }); return true;
  }

  if (p === '/sweep' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    const ws = T.ws;
    const ovWs = T.ov;
    const staleMins = b.stale_minutes != null ? Number(b.stale_minutes) : 1;
    const nowMs = Date.now();
    const cutoff = nowMs - staleMins * 60000;
    let released = 0;
    let agentsDirty = false;
    const stWsSweep = ws === state.workspace ? state : { ...state, overlay: ovWs };
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
      const sweepOv = staleMins !== (ovWs.config.stale_minutes ?? 10)
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
    if (!b.force && state.workspace && state.workspace !== b.path) {
      send(res, 200, { ok: true, workspace: state.workspace, skipped: true }); return true;
    }
    setWorkspace(b.path, b);
    send(res, 200, { ok: true, workspace: state.workspace }); return true;
  }

  if (p === '/analytics/tool-call' && m === 'POST') {
    const b = await readBody(req);
    if (!b.tool || typeof b.tool !== 'string') { send(res, 400, { ok: false, error: 'tool required' }); return true; }
    analytics.record(analyticsState, b.tool, !!b.error, b.workspace || state.workspace || null);
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
    send(res, 200, { ok: true, phase: boot.phase, step: boot.step, progress: boot.progress, bootedAt: BOOTED_AT, head: GIT_HEAD, workspace: state.workspace, sessions: sessionCount(), loops: loopHealth, embedding: embedStatus(), native_format: state.workspace ? harness.tasks.formatHealth(state.workspace) : null }); return true;
  }

  if (p === '/ready') {
    const ws = u.searchParams.get('workspace') || state.workspace;
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
    const stWs = u.searchParams.get('workspace') || state.workspace;
    const stKey = `state|${stWs}|${u.searchParams.get('scope') || ''}|${u.searchParams.get('compact') || ''}|${u.searchParams.get('include_archived') || ''}|arch1`;
    const stHit = respCacheGet(stWs, stKey);
    if (stHit !== undefined) { send(res, 200, stHit); return true; }
    const T = targetOverlay(null, u);
    const ws = T.ws;
    const g = buildGraph(ws);
    const edgesOut = T.ov.edges.map((e) => (e.kind === 'context' ? { ...e, weight: overlayStore.edgeWeight(e) } : e));
    const includeArchived = isTruthy(u.searchParams.get('include_archived'));
    const cfgDays = Number((T.ov.config || {}).archive_after_days);
    const windowMs = includeArchived ? Infinity : (cfgDays > 0 ? cfgDays : frontier.DEFAULT_ARCHIVE_DAYS) * 864e5;
    const keep = frontier.frontierKeep(g.tasks);
    const arch = isFinite(windowMs) ? frontier.archivedIds(g.tasks, { windowMs, keep }) : new Set();
    const archivedTasks = arch.size ? frontier.archivedTaskList(g.tasks, arch) : null;
    if (u.searchParams.get('scope') === 'frontier') {
      const f = frontier.projectFrontier(g.tasks, g.ghosts, edgesOut, { windowMs });
      const body = { workspace: ws, scope: 'frontier', tasks: f.tasks, ghosts: f.ghosts, edges: f.edges, summary: { ...g.summary, archived: f.archived, frontier_kept: f.tasks.length } };
      if (archivedTasks) body.archived_tasks = archivedTasks;
      send(res, 200, respCachePut(stWs, stKey, body)); return true;
    }
    let tasks = g.tasks;
    const archived = arch.size;
    if (archived) tasks = tasks.filter((t) => !arch.has(t.id));
    const summary = { ...g.summary, archived };
    const archField = archivedTasks ? { archived_tasks: archivedTasks } : {};
    if (u.searchParams.get('compact')) {
      const slim = tasks.map((t) => {
        const o = { id: t.id, label: t.label, status: t.status, deps: t.deps };
        if (t.kind) o.kind = t.kind;
        if (t.agent_id) o.assignee = t.agent_id;
        if (t.git && t.git.merged) o.merged = true;
        return o;
      });
      send(res, 200, respCachePut(stWs, stKey, { workspace: ws, compact: true, tasks: slim, ghosts: g.ghosts, edges: edgesOut, summary, ...archField })); return true;
    }
    send(res, 200, respCachePut(stWs, stKey, { workspace: ws, tasks, ghosts: g.ghosts, edges: edgesOut, routes: state.routes, agents: agentsArr().filter((a) => a.workspace === ws), summary, ...archField })); return true;
  }

  if (p === '/workspaces' && m === 'GET') {
    // Build the union of all known workspaces for the dashboard workspace switcher.
    // Sources (all deduped): workspaces.json registry + state.workspace + sessions + agents + graphStore known dirs.
    // Cheap: NO buildGraph per workspace — just path enumeration + basename.
    const seenPaths = new Set();
    const addPath = (p2) => { if (p2 && typeof p2 === 'string') seenPaths.add(p2); };

    // 1. Registry file (persisted across restarts)
    try {
      const stored = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
      if (Array.isArray(stored)) stored.forEach(addPath);
    } catch { /* file may not exist yet */ }

    // 2. Current pinned workspace
    addPath(state.workspace);

    // 3. Distinct session workspaces
    for (const s of Object.values(state.sessions || {})) addPath(s.workspace);

    // 4. Distinct agent workspaces
    for (const a of Object.values(state.agents || {})) addPath(a.workspace);

    // 5. graphStore opened dirs (strip /.graph suffix)
    for (const store of graphStore.allStores()) {
      const dir = store.dir;
      if (dir && dir.endsWith(path.sep + '.graph')) addPath(dir.slice(0, -(path.sep.length + 6)));
      else if (dir && dir.endsWith('/.graph')) addPath(dir.slice(0, -7));
    }

    const current = state.workspace;
    const workspaces = [...seenPaths].map((wsPath) => ({
      path: wsPath,
      name: path.basename(wsPath),
      current: wsPath === current,
    }));

    send(res, 200, { ok: true, current, workspaces }); return true;
  }

  return false;
};
