'use strict';

/**
 * Resolve the transcript path for the agent that worked on taskKey.
 *
 * Three legs, tried in order:
 *  1. agent record has transcript_path directly
 *  2. agent record has session → sessionTranscript lookup
 *  3. task claim window overlaps a byWindow run → use that run's transcript_path
 *     (handles inline main-agent work where no SubagentStart hook fires)
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: taskWindows = {}, byWindow = [], sessionTranscript = {} } = registry;

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript path
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow — find the run window that contains the task claim window
  const tw = taskWindows[taskKey];
  if (tw && tw.start && tw.end && byWindow.length) {
    const tStart = tw.start;
    const tEnd = tw.end;
    for (const entry of byWindow) {
      if (entry.transcript_path && entry.start && entry.end &&
          entry.start <= tStart && entry.end >= tEnd) {
        return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
