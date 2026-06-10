'use strict';
// HELD-OUT grader for the task->transcript candidate. The agent NEVER sees this file.
//
// Usage: node task-transcript.grader.js <frozen-artifact.js>
// Builds the registry PROGRAMMATICALLY (same structure family as the real dogfood data): direct,
// session, direct-priority, and ~40% correlation-only rows (no session / no path on the agent
// record — attributable ONLY by overlapping the task's claim window against byWindow). The PROSE
// SPEC the agent saw described ONLY direct + session, so a spec-faithful impl misses the
// correlation rows. Those are the held-out EDGE cases.
//
// Prints JSON: { ok, cases:[{name,edge,pass,want,got}], pass, total, edgePass, edgeTotal }.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let resolveOwner, loadErr = null;
try { ({ resolveOwner } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }

// --- build registry programmatically (mirrors the real attribution data shape) ----------------
const T0 = Date.parse('2026-06-08T00:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const assignee = {}, agents = {}, window = {}, byWindow = [], sessionTranscript = {};
const expected = {}, edgeOf = {};

const NRUN = 14;
for (let i = 0; i < NRUN; i++) {
  byWindow.push({ session: `sess-${i}`, transcript_path: `/t/run-${i}.jsonl`, start: iso(i * 20 + 1), end: iso(i * 20 + 19) });
}
const NTASK = 25;
for (let i = 0; i < NTASK; i++) {
  const key = `K/${i}`;
  const r = i % NRUN, base = r * 20;
  window[key] = { start: iso(base + 6), end: iso(base + 12) };
  const ownerRun = byWindow[r];
  const agentId = `agent-${i}`;
  assignee[key] = agentId;
  const cls = i % 5;
  if (cls === 0) { agents[agentId] = { transcript_path: ownerRun.transcript_path }; expected[key] = ownerRun.transcript_path; edgeOf[key] = false; }
  else if (cls === 1) { agents[agentId] = { session: ownerRun.session }; sessionTranscript[ownerRun.session] = ownerRun.transcript_path; expected[key] = ownerRun.transcript_path; edgeOf[key] = false; }
  else if (cls === 2) { agents[agentId] = { session: 'decoy-sess', transcript_path: ownerRun.transcript_path }; sessionTranscript['decoy-sess'] = '/t/decoy.jsonl'; expected[key] = ownerRun.transcript_path; edgeOf[key] = false; }
  else { agents[agentId] = {}; expected[key] = ownerRun.transcript_path; edgeOf[key] = true; }  // cls 3/4: correlation-only EDGE rows
}
// explicit null rows (not edge — direct-only impl returns null here too)
assignee['N/1'] = 'agent-n1'; agents['agent-n1'] = {}; window['N/1'] = { start: iso(100000), end: iso(100005) }; expected['N/1'] = null; edgeOf['N/1'] = false;
expected['N/zzz'] = null; edgeOf['N/zzz'] = false;

const registry = { assignee, agents, window, byWindow, sessionTranscript };

const cases = [];
for (const [key, want] of Object.entries(expected)) {
  let got = null, err = null;
  if (typeof resolveOwner !== 'function') err = loadErr || 'no resolveOwner export';
  else { try { got = resolveOwner(key, registry); } catch (e) { err = e.message; } }
  cases.push({ name: `${key} -> ${want === null ? 'null' : want}`, edge: edgeOf[key], pass: got === want, want, got, err });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length,
}));
