// Shared usage/transcript helpers for harness adapters. Adapters with on-disk transcript JSONLs
// delegate parsing to lib/human-input; adapters without transcripts return these empty shapes and
// may aggregate optional agent-reported fields instead. Cost attribution degrades — never blocks.
'use strict';
const fs = require('fs');
const path = require('path');

const EMPTY_HUMAN = Object.freeze({ tokens: 0, chars: 0, messages: 0, dropped: 0, files: 0, since: null });
const EMPTY_OVERHEAD = Object.freeze({
  tokens: 0,
  chars: 0,
  by_category: Object.freeze({
    system_reminder: 0, tool_result: 0, command_blocks: 0, automation_messages: 0, orchestrator_suffix: 0,
  }),
  files: 0,
  since: null,
});
const EMPTY_USAGE = Object.freeze({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total: 0,
  by_model: {},
});

// Normalize optional self-reported usage on an agent record (POST /agent/start|done or overlay status).
// Accepts reported_usage or legacy usage / token_usage shapes; returns null when absent or empty.
function parseReportedUsage(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const raw = agent.reported_usage || agent.usage || agent.token_usage;
  if (!raw || typeof raw !== 'object') return null;
  const input = Number(raw.input_tokens) || 0;
  const output = Number(raw.output_tokens) || 0;
  const cacheRead = Number(raw.cache_read_input_tokens ?? raw.cache_read_tokens) || 0;
  const cacheCreate = Number(raw.cache_creation_input_tokens) || 0;
  const total = typeof raw.total === 'number' && !Number.isNaN(raw.total)
    ? raw.total
    : input + output;
  if (total <= 0 && input <= 0 && output <= 0) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
    total,
    by_model: raw.by_model && typeof raw.by_model === 'object' ? raw.by_model : {},
    source: 'self_reported',
  };
}

// Sum self-reported usage across agent registry entries (hookless / no-transcript harnesses).
function aggregateSelfReported(agents, opts = {}) {
  const out = { ...EMPTY_USAGE, agents: 0, source: 'self_reported' };
  if (!agents || typeof agents !== 'object') return out;
  const since = opts.since ? String(opts.since).slice(0, 19) : null;
  for (const agent of Object.values(agents)) {
    if (!agent) continue;
    if (since) {
      const seen = String(agent.lastSeen || agent.startedAt || '').slice(0, 19);
      if (seen && seen < since) continue;
    }
    const u = parseReportedUsage(agent);
    if (!u) continue;
    out.agents++;
    out.input_tokens += u.input_tokens;
    out.output_tokens += u.output_tokens;
    out.cache_read_input_tokens += u.cache_read_input_tokens;
    out.cache_creation_input_tokens += u.cache_creation_input_tokens;
    out.total += u.total;
  }
  return out;
}

// List main-session transcript JSONLs in a project dir (Claude layout). Returns [] when dir missing.
function listSessionTranscripts(projectDir) {
  if (!projectDir) return [];
  let entries = [];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => ({ id: e.name.slice(0, -'.jsonl'.length), path: path.join(projectDir, e.name) }));
}

function emptyHuman(opts = {}) {
  return { ...EMPTY_HUMAN, since: opts.since || null };
}

function emptyOverhead(opts = {}) {
  return {
    tokens: 0, chars: 0,
    by_category: { ...EMPTY_OVERHEAD.by_category },
    files: 0,
    since: opts.since || null,
  };
}

module.exports = {
  EMPTY_HUMAN, EMPTY_OVERHEAD, EMPTY_USAGE,
  parseReportedUsage, aggregateSelfReported, listSessionTranscripts,
  emptyHuman, emptyOverhead,
};
