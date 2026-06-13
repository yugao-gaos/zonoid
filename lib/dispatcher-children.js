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
  const { agentsArr, buildGraph, state, targetOverlay, harness } = ctx;
  const agents = agentsArr();
  const g = buildGraph(state.workspace);
  const T = targetOverlay(null, { searchParams: new URLSearchParams() });
  const ov = T.ov;
  const children = [];
  const seen = new Set();

  for (const a of agents) {
    if (a.state !== 'running' || a.session !== parentSid) continue;
    if (!a.subagent_session || a.subagent_session === a.session) continue;
    const agentId = a.agent_id;
    if (seen.has(agentId)) continue;
    let taskKey = a.task || null;
    if (!taskKey) {
      for (const [key, aid] of Object.entries(ov.assignee || {})) {
        if (aid === agentId && ov.status[key] === 'in_progress') {
          taskKey = key;
          break;
        }
      }
    }
    children.push({
      task_key: taskKey,
      label: taskLabel(taskKey, g, harness),
      agent_id: agentId,
      worker_session: a.subagent_session,
    });
    seen.add(agentId);
  }

  const cs = ov.claimSessions || {};
  for (const t of g.tasks) {
    if (t.status !== 'in_progress' || cs[t.id] !== parentSid) continue;
    const agentId = t.agent_id || ov.assignee[t.id];
    if (!agentId || seen.has(agentId)) continue;
    const ag = state.agents[agentId];
    if (!ag || ag.state !== 'running') continue;
    children.push({
      task_key: t.id,
      label: t.label || taskLabel(t.id, g, harness),
      agent_id: agentId,
      worker_session: ag.subagent_session || ag.session,
    });
    seen.add(agentId);
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
