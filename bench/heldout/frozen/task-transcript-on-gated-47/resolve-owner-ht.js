'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// A task is claimed by an assignee (a logical agent id). We resolve that agent
// to the transcript file that holds the task's token usage. Three legs, in order:
//   1. direct  — the agent record carries transcript_path.
//   2. session — the agent record carries a session that maps to a transcript
//                via sessionTranscript.
//   3. window  — fallback when the agent record has neither: match the task's
//                claim window against the run windows in byWindow and return the
//                overlapping run's transcript_path.
// Return null only when all three legs fail. Every field may be absent.

function toMillis(iso) {
  if (typeof iso !== 'string') return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

// Inclusive overlap of two closed intervals; null bounds make the test fail.
function overlaps(aStart, aEnd, bStart, bEnd) {
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) {
    return false;
  }
  return aStart <= bEnd && bStart <= aEnd;
}

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  const agent = (agentId != null && agents[agentId]) || null;

  // Leg 1: direct transcript_path on the agent record.
  if (agent && typeof agent.transcript_path === 'string') {
    return agent.transcript_path;
  }

  // Leg 2: agent session -> sessionTranscript.
  if (agent && agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (typeof viaSession === 'string') return viaSession;
  }

  // Leg 3: window overlap against harness run windows in byWindow.
  const window = (registry.window && registry.window[taskKey]) || null;
  const byWindow = Array.isArray(registry.byWindow) ? registry.byWindow : [];
  if (window) {
    const taskStart = toMillis(window.start);
    const taskEnd = toMillis(window.end);
    for (const run of byWindow) {
      if (!run || typeof run.transcript_path !== 'string') continue;
      if (overlaps(taskStart, taskEnd, toMillis(run.start), toMillis(run.end))) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
