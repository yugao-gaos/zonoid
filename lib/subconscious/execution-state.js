'use strict';

function loopStateKey(workspace, loopId, agentId) {
  return `${workspace}\0${loopId}\0${agentId}`;
}

function sessionCompanionKey(workspace, sessionId) {
  return `${workspace}\0${sessionId}`;
}

function anchorAllocationKey(workspace, sessionId, companionAgentId, companionLoopId) {
  return `${workspace}\0${sessionId}\0${companionAgentId || ''}\0${companionLoopId || ''}`;
}

function ideaScheduleKey(workspace, agentId, sessionId, companionAgentId, companionLoopId) {
  return `${workspace}\0${agentId}\0${sessionId || ''}\0${companionAgentId || ''}\0${companionLoopId || ''}`;
}

function createExecutionState() {
  const loops = new Map();
  const sessionCompanions = new Map();
  const anchorAllocations = new Map();
  const ideaSchedules = new Map();
  const executionPermits = new Map();
  let nextLoopObservationId = 1;
  let nextSessionCompanionObservationId = 1;
  let nextAnchorObservationId = 1;
  let nextAnchorDecisionId = 1;
  let nextIdeaId = 1;
  let nextExecutionPermitId = 1;

  function loopFor(workspace, loopId, agentId, now) {
    const key = loopStateKey(workspace, loopId, agentId);
    let entry = loops.get(key);
    if (!entry) {
      entry = {
        workspace,
        loop_id: loopId,
        agent_id: agentId,
        created_at: now,
        updated_at: now,
        status: null,
        phase: null,
        directive: null,
        payload: null,
        observation_count: 0,
        tick_count: 0,
        latest_observation: null,
        observations: [],
      };
      loops.set(key, entry);
    }
    return entry;
  }

  function getLoop(identity) {
    return loops.get(loopStateKey(identity.workspace, identity.loop_id, identity.agent_id));
  }

  function getSessionCompanion(identity) {
    return sessionCompanions.get(sessionCompanionKey(identity.workspace, identity.session_id));
  }

  function setSessionCompanion(entry) {
    sessionCompanions.set(sessionCompanionKey(entry.workspace, entry.session_id), entry);
    return entry;
  }

  function getAnchorAllocation(identity) {
    return anchorAllocations.get(anchorAllocationKey(
      identity.workspace,
      identity.session_id,
      identity.companion_agent_id,
      identity.companion_loop_id
    ));
  }

  function setAnchorAllocation(entry) {
    anchorAllocations.set(anchorAllocationKey(
      entry.workspace,
      entry.session_id,
      entry.companion_agent_id,
      entry.companion_loop_id
    ), entry);
    return entry;
  }

  function ideaScheduleFor(identity, now) {
    const key = ideaScheduleKey(
      identity.workspace,
      identity.agent_id,
      identity.session_id,
      identity.companion_agent_id,
      identity.companion_loop_id
    );
    let entry = ideaSchedules.get(key);
    if (!entry && now) {
      entry = {
        workspace: identity.workspace,
        agent_id: identity.agent_id,
        session_id: identity.session_id,
        companion_agent_id: identity.companion_agent_id,
        companion_loop_id: identity.companion_loop_id,
        created_at: now,
        updated_at: now,
        idea_count: 0,
        scheduled_count: 0,
        approval_required_count: 0,
        latest_idea: null,
        ideas: [],
      };
      ideaSchedules.set(key, entry);
    }
    return entry;
  }

  function executionPermitValues() {
    return [...executionPermits.values()];
  }

  function setExecutionPermit(permit) {
    executionPermits.set(permit.id, permit);
    return permit;
  }

  return {
    loopFor,
    getLoop,
    getSessionCompanion,
    setSessionCompanion,
    getAnchorAllocation,
    setAnchorAllocation,
    ideaScheduleFor,
    executionPermitValues,
    setExecutionPermit,
    nextLoopObservationId: () => `subloop-${nextLoopObservationId++}`,
    nextSessionCompanionObservationId: () => `subcomp-${nextSessionCompanionObservationId++}`,
    nextAnchorObservationId: () => `subanchor-obs-${nextAnchorObservationId++}`,
    nextAnchorDecisionId: () => `subanchor-dec-${nextAnchorDecisionId++}`,
    nextIdeaId: () => `subidea-${nextIdeaId++}`,
    nextExecutionPermitId: () => `subpermit-${nextExecutionPermitId++}`,
  };
}

module.exports = {
  anchorAllocationKey,
  createExecutionState,
  ideaScheduleKey,
  loopStateKey,
  sessionCompanionKey,
};
