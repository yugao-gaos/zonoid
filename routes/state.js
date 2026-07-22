'use strict';
const internalLanes = require('../lib/internal-lanes');

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, buildGraph, state, overlayStore, targetOverlay, respCacheGet, respCachePut,
    isTruthy, frontier, agentsArr } = ctx;

  if (p === '/state') {
    const T = targetOverlay(null, u);
    const stWs = T.graph_repo || T.ws;
    if (!stWs) { send(res, 400, { ok: false, error: 'graph_repo required (deprecated alias: workspace)' }); return true; }
    const stKey = `state|${stWs}|${u.searchParams.get('scope') || ''}|${u.searchParams.get('compact') || ''}|${u.searchParams.get('include_archived') || ''}|${u.searchParams.get('include_internal') || ''}|arch1`;
    const stHit = respCacheGet(stWs, stKey);
    if (stHit !== undefined) { send(res, 200, stHit); return true; }
    const ws = T.ws;
    const identity = { workspace_id: T.workspace_id, graph_repo: ws, workspace: ws };
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
      const body = { ...identity, scope: 'frontier', tasks: f.tasks, ghosts: f.ghosts, edges: f.edges, summary: { ...g.summary, archived: f.archived, frontier_kept: f.tasks.length } };
      if (archivedTasks) body.archived_tasks = archivedTasks;
      if (includeInternal) body.internal_lanes = internalLanes.buildInternalLaneProjection({ workspace: ws, graph: g, overlay: T.ov });
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
      const body = { ...identity, compact: true, tasks: slim, ghosts: g.ghosts, edges: edgesOut, summary, ...archField };
      if (includeInternal) body.internal_lanes = internalLanes.buildInternalLaneProjection({ workspace: ws, graph: g, overlay: T.ov });
      send(res, 200, respCachePut(stWs, stKey, body)); return true;
    }
    const body = { ...identity, tasks, ghosts: g.ghosts, edges: edgesOut, routes: state.routes, agents: agentsArr().filter((a) => a.workspace === ws), summary, config: T.ov.config || {}, ...archField };
    if (includeInternal) body.internal_lanes = internalLanes.buildInternalLaneProjection({ workspace: ws, graph: g, overlay: T.ov });
    send(res, 200, respCachePut(stWs, stKey, body)); return true;
  }

  return false;
};
