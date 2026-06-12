'use strict';

/**
 * Return the transcript path for the task, or null if none can be attributed.
 *
 * Three attribution legs (in order):
 *  1. Agent record carries transcript_path directly.
 *  2. Agent record carries a session that maps via sessionTranscript.
 *  3. OVERRIDE (spec omits this): find a byWindow run whose time window
 *     overlaps the task's claim window — handles inline main-agent work where
 *     no SubagentStart hook fires and the agent record has neither field.
 */
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: win = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct path on agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow overlap with the task's claim window
  const taskWin = win[taskKey];
  if (taskWin && taskWin.start && taskWin.end) {
    for (const run of byWindow) {
      if (!run.transcript_path || !run.start || !run.end) continue;
      if (run.start <= taskWin.end && taskWin.start <= run.end) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
