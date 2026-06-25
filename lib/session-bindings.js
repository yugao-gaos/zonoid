'use strict';
const path = require('path');
const harnessRegistry = require('./harness');

// Resolve a session id from hook/MCP payload fields or transcript basename.
function resolveSessionId(body, transcript) {
  const b = body && typeof body === 'object' ? body : {};
  const sid = b.session_id || b.session || b.conversation_id || null;
  if (sid) return String(sid);
  if (transcript) {
    const base = path.basename(String(transcript), '.jsonl');
    if (base) return base;
  }
  return null;
}

function inferHarness(transcript, hint) {
  if (hint) return String(hint);
  const tx = String(transcript || '');
  if (tx.includes('.cursor/projects') || tx.includes('agent-transcripts')) return 'cursor';
  if (tx.includes('.claude/projects') || tx.includes(`${path.sep}.claude${path.sep}`)) return 'claude';
  if (process.env.ZONOID_HARNESS) return process.env.ZONOID_HARNESS;
  return 'claude';
}

function bindSession(sessions, sessionId, { transcript, workspace, harness } = {}) {
  if (!sessionId) return sessions || {};
  const map = sessions && typeof sessions === 'object' ? sessions : {};
  const prev = map[sessionId] || {};
  map[sessionId] = {
    harness: harness || prev.harness || (transcript ? inferHarness(transcript) : prev.harness) || null,
    transcript: transcript !== undefined && transcript !== null && transcript !== '' ? transcript : (prev.transcript ?? null),
    workspace: workspace || prev.workspace || null,
    lastSeen: new Date().toISOString(),
  };
  return map;
}

function sessionBinding(st, sessionId) {
  if (!sessionId || !st.sessions) return null;
  return st.sessions[sessionId] || null;
}

function mainTranscriptForSession(st, sessionId) {
  const b = sessionBinding(st, sessionId);
  return b && b.transcript ? b.transcript : null;
}

function resolveSessionTranscriptPath(st, sessionId, subSessionId) {
  const main = mainTranscriptForSession(st, sessionId);
  if (!main || !subSessionId) return null;
  const b = sessionBinding(st, sessionId);
  const harnessName = (b && b.harness) || inferHarness(main);
  let h;
  try { h = harnessRegistry.get(harnessName); } catch { h = harnessRegistry.get('claude'); }
  return h.transcripts.sessionTranscriptPath(main, subSessionId);
}

function sessionCount(st) {
  return st.sessions ? Object.keys(st.sessions).length : 0;
}

module.exports = {
  resolveSessionId, inferHarness, bindSession, sessionBinding,
  mainTranscriptForSession, resolveSessionTranscriptPath, sessionCount,
};
