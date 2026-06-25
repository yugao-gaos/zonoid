'use strict';

function isSubagentSession(sessionId, agents) {
  return agents.some((a) =>
    a.state === 'running' &&
    a.subagent_session &&
    a.subagent_session === sessionId &&
    a.subagent_session !== a.session
  );
}

function taskLabel(taskKey, g, harness) {
  if (!taskKey) return '';
  const t = g.tasks.find((x) => x.id === taskKey);
  if (t && t.label) return t.label;
  const slash = taskKey.indexOf('/');
  if (slash > 0 && harness && harness.tasks) {
    const sess = taskKey.slice(0, slash);
    const id = taskKey.slice(slash + 1);
    for (const nt of harness.tasks.readSessionTasksRaw(sess)) {
      if (String(nt.id) === id) return nt.subject || String(id);
    }
  }
  return '';
}

function listDispatcherChildren(parentSid, ctx) {
  if (!parentSid) return [];
  const { agentsArr, buildGraph, state, targetOverlay, harness, registeredWorkspaces } = ctx;
  const agents = agentsArr();
  // P3: there is no daemon-global workspace, and the gate queries /dispatcher/children with only a
  // session id (no ?workspace=). A child's task/claim lives in ONE workspace's overlay+graph, so
  // enumerate EVERY registered workspace and union — mirroring /active-claim. (The agent-registry
  // loop is workspace-independent; only the overlay/graph-backed task_key + claimSessions lookups
  // need the scan. An empty registry degrades gracefully to the agent-registry signal alone.)
  // registeredWorkspaces() returns a Set (see daemon.js) — normalize to an array before mapping.
  const wss = Array.from((typeof registeredWorkspaces === 'function' && registeredWorkspaces()) || []);
  const scopes = wss.map((ws) => {
    const T = targetOverlay({ workspace: ws }, { searchParams: new URLSearchParams() });
    return { ws, g: buildGraph(ws), ov: T.ov };
  });
  const labelFor = (taskKey) => {
    if (!taskKey) return '';
    for (const s of scopes) { const l = taskLabel(taskKey, s.g, harness); if (l) return l; }
    return taskLabel(taskKey, { tasks: [] }, harness);   // harness session-task fallback (no graph)
  };
  const children = [];
  const seen = new Set();

  for (const a of agents) {
    if (a.state !== 'running' || a.session !== parentSid) continue;
    if (!a.subagent_session || a.subagent_session === a.session) continue;
    const agentId = a.agent_id;
    if (seen.has(agentId)) continue;
    let taskKey = a.task || null;
    let taskWs = null;
    if (!taskKey) {
      for (const { ws, ov } of scopes) {
        for (const [key, aid] of Object.entries(ov.assignee || {})) {
          if (aid === agentId && ov.status[key] === 'in_progress') { taskKey = key; taskWs = ws; break; }
        }
        if (taskKey) break;
      }
    } else {
      // task_key came from the agent record — find which registered workspace actually owns it.
      for (const { ws, g, ov } of scopes) {
        if ((ov.assignee && ov.assignee[taskKey]) || g.tasks.some((t) => t.id === taskKey)) { taskWs = ws; break; }
      }
    }
    children.push({
      task_key: taskKey,
      workspace: taskWs,
      label: labelFor(taskKey),
      agent_id: agentId,
      worker_session: a.subagent_session,
    });
    seen.add(agentId);
  }

  for (const { ws, g, ov } of scopes) {
    const cs = ov.claimSessions || {};
    for (const t of g.tasks) {
      if (t.status !== 'in_progress' || cs[t.id] !== parentSid) continue;
      const agentId = t.agent_id || ov.assignee[t.id];
      if (!agentId || seen.has(agentId)) continue;
      const ag = state.agents[agentId];
      if (!ag || ag.state !== 'running') continue;
      children.push({
        task_key: t.id,
        workspace: ws,
        label: t.label || labelFor(t.id),
        agent_id: agentId,
        worker_session: ag.subagent_session || ag.session,
      });
      seen.add(agentId);
    }
  }

  return children;
}

function formatInflightWorkersBlock(children) {
  if (!children || !children.length) return '';
  const lines = children.map((c) =>
    `${c.task_key || '(no task)'}, ${c.label || '(no label)'}, ${c.agent_id || '(no agent)'}`
  );
  return `[In-flight workers]\n${lines.join('\n')}`;
}

function inflightWorkersContext(sessionId, ctx) {
  if (!sessionId || !ctx || !ctx.agentsArr) return '';
  if (isSubagentSession(sessionId, ctx.agentsArr())) return '';
  return formatInflightWorkersBlock(listDispatcherChildren(sessionId, ctx));
}

module.exports = {
  isSubagentSession,
  listDispatcherChildren,
  formatInflightWorkersBlock,
  inflightWorkersContext,
};
