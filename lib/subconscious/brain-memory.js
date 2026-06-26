'use strict';

function agentStateKey(workspace, agentId) {
  return `${workspace}\0${agentId}`;
}

function createExecutionBrainMemory(options = {}) {
  const maxEvents = Math.max(1, Number(options.maxEvents) || 25);
  const agents = new Map();
  let nextEventId = 1;

  function eventsFor(workspace, agentId) {
    const key = agentStateKey(workspace, agentId);
    let entry = agents.get(key);
    if (!entry) {
      entry = { workspace, agent_id: agentId, events: [] };
      agents.set(key, entry);
    }
    return entry.events;
  }

  function appendEvent(input) {
    const event = {
      ...input,
      id: input.id || `subevt-${nextEventId++}`,
    };
    const events = eventsFor(event.workspace, event.agent_id);
    events.push(event);
    while (events.length > maxEvents) events.shift();
    return { event, recent_agent_events: events.slice() };
  }

  function recentEvents(workspace, agentId, limit = maxEvents) {
    const entry = agents.get(agentStateKey(workspace, agentId));
    if (!entry) return [];
    return entry.events.slice(-Math.max(1, Number(limit) || maxEvents));
  }

  return {
    appendEvent,
    eventsFor,
    recentEvents,
  };
}

module.exports = {
  agentStateKey,
  createExecutionBrainMemory,
};
