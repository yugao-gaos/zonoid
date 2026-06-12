'use strict';

function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: win = {}, byWindow = [], sessionTranscript = {} } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId) {
    const rec = agents[agentId] || {};

    // Leg 1: direct transcript_path on the agent record
    if (rec.transcript_path) return rec.transcript_path;

    // Leg 2: session → sessionTranscript lookup
    if (rec.session && sessionTranscript[rec.session]) return sessionTranscript[rec.session];
  }

  // Leg 3: byWindow overlap fallback
  const tw = win[taskKey];
  if (tw && tw.start && tw.end) {
    const tStart = tw.start;
    const tEnd = tw.end;
    for (const entry of byWindow) {
      if (entry.transcript_path && entry.start && entry.end &&
          entry.start <= tEnd && entry.end >= tStart) {
        return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
