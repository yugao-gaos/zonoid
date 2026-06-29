'use strict';

function agentsTools(deps) {
  const { q, UI_URI, PORT, runSubconsciousAssignment } = deps;
  return [
  { name: 'list_agents', description: 'List every known agent across sessions with its task, session, workspace, startedAt and current cooperative-stop flag. Use to SEE whether another session has a worker running on this graph before you act.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/agents') },
{ name: 'request_agent_stop', description: 'Cooperatively stop a worker by agent_id, or by task_key (resolved via its assignee). Sets an advisory stop flag — there is NO cross-process kill; the worker is expected to poll list_agents (or /agent/stop-requested) and self-terminate. Use to stand down a colliding worker in another session.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, task_key: { type: 'string' } }, additionalProperties: false }, run: (a, call) => call('POST', '/agent/stop', { agent_id: a.agent_id, task_key: a.task_key }) }
  ];
}

module.exports = agentsTools;
