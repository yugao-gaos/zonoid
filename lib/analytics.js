// Tool-usage analytics: aggregated MCP tool-call counters, persisted across daemon restarts.
// Every tools/call dispatch (both transports — stdio mcp-graph.js and the daemon's /mcp endpoint —
// funnel through mcp-core.handleRpc) beacons POST /analytics/tool-call to the daemon, which tallies
// here in memory and flushes DEBOUNCED to one small JSON file (no per-call disk writes).
// State shape: { tools: { [name]: { total, errors, last_called, workspaces: { [path]: n }, days: { 'YYYY-MM-DD': n } } } }
// `days` is a rolling 7-day window (UTC day keys), pruned on record and on report.
'use strict';
const fs = require('fs');
const path = require('path');

const FLUSH_MS = 2000;
const WINDOW_DAYS = 7;

function load(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s && typeof s.tools === 'object') return s; } catch { /* none yet */ }
  return { tools: {} };
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function pruneDays(days, now = new Date()) {
  const cutoff = dayKey(new Date(now.getTime() - (WINDOW_DAYS - 1) * 86400000));
  for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
}

function record(state, tool, isError, workspace, now = new Date()) {
  const t = state.tools[tool] || (state.tools[tool] = { total: 0, errors: 0, last_called: null, workspaces: {}, days: {} });
  t.total += 1;
  if (isError) t.errors += 1;
  t.last_called = now.toISOString();
  if (workspace) t.workspaces[workspace] = (t.workspaces[workspace] || 0) + 1;
  const k = dayKey(now);
  t.days[k] = (t.days[k] || 0) + 1;
  pruneDays(t.days, now);
}

// Debounced persist: one write FLUSH_MS after the first dirty mark; further marks coalesce.
// unref'd so a pending flush never holds the process open.
function makeFlusher(file, state) {
  let timer = null;
  const flush = () => {
    timer = null;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); } catch { /* best effort */ }
  };
  const soon = () => {
    if (timer) return;
    timer = setTimeout(flush, FLUSH_MS);
    if (timer.unref) timer.unref();
  };
  return { soon, flush };
}

// Per-tool rows for EVERY registered tool — never-called tools get zero rows — plus any historical
// tool no longer in the registry (registered:false, the prune-candidate signal). Sorted by total desc.
function report(state, registeredNames, now = new Date()) {
  const registered = new Set(registeredNames);
  const names = new Set([...registeredNames, ...Object.keys(state.tools)]);
  const rows = [];
  for (const name of names) {
    const t = state.tools[name];
    if (t) pruneDays(t.days, now);
    rows.push({
      name,
      registered: registered.has(name),
      total: t ? t.total : 0,
      errors: t ? t.errors : 0,
      last_called: t ? t.last_called : null,
      last7d: t ? Object.values(t.days).reduce((s, n) => s + n, 0) : 0,
      days: t ? t.days : {},
    });
  }
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return rows;
}

module.exports = { load, record, report, makeFlusher, pruneDays, dayKey, FLUSH_MS, WINDOW_DAYS };
