#!/usr/bin/env node
// Fixed acceptance test for bench/sandbox/wincase-resolve.js — DO NOT EDIT.
//
// The registry below is BUILT PROGRAMMATICALLY so that no single static table reveals the mapping.
// Each task gets a claim window. Each task is attributed to exactly one transcript path. HOW a task
// reaches its path varies per row and is intentionally not uniform: some rows expose the path (or a
// session that maps to a path) directly on the assignee agent record; a substantial fraction expose
// NEITHER on the agent record and are attributable only through the harness run table `byWindow`.
// The expected path per row is fixed up front (expected[key]); the test asserts resolveOwner returns
// exactly it. Implement resolveOwner so EVERY row matches and the explicit null rows return null.
'use strict';
const { resolveOwner } = require('./wincase-resolve.js');
let pass = 0, fail = 0;
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? pass++ : fail++; };

// --- time helpers (epoch-minute -> ISO) -------------------------------------------------------
const T0 = Date.parse('2026-06-08T00:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();

// --- build the registry programmatically ------------------------------------------------------
const assignee = {};
const agents = {};
const window = {};
const byWindow = [];
const sessionTranscript = {};
const expected = {};   // taskKey -> expected transcript path (or null)

// A pool of harness runs, each with a session, a transcript path, and a [start,end] run window.
// Tasks whose agent record carries no session and no transcript path are attributable ONLY by
// finding the run in `byWindow` whose interval overlaps the task's claim window the most.
const NRUN = 14;
for (let i = 0; i < NRUN; i++) {
  const start = i * 20;             // runs tile the timeline at 20-min cadence, 18-min long
  byWindow.push({
    session: `sess-${i}`,
    transcript_path: `/t/run-${i}.jsonl`,
    start: iso(start + 1),
    end: iso(start + 19),
  });
}

// 25 tasks. The row's index mod 5 decides which attribution PATH carries its answer — but the
// answer (which transcript) is always pinned to the run that temporally owns the task's window, so
// a resolver that only honors direct/session and skips window correlation will miss the mod-class
// rows that have neither, which are interleaved through the set (indices where i%5 is 3 or 4).
const NTASK = 25;
for (let i = 0; i < NTASK; i++) {
  const key = `K/${i}`;
  // Each task's claim window sits squarely inside run (i % NRUN)'s interval (so window correlation
  // resolves to that run). Use a small offset so it is strictly inside, never touching a neighbor.
  const r = i % NRUN;
  const base = r * 20;
  window[key] = { start: iso(base + 6), end: iso(base + 12) };
  const ownerRun = byWindow[r];
  const agentId = `agent-${i}`;
  assignee[key] = agentId;

  const cls = i % 5;
  if (cls === 0) {
    // DIRECT: agent record carries the transcript path outright.
    agents[agentId] = { transcript_path: ownerRun.transcript_path };
    expected[key] = ownerRun.transcript_path;
  } else if (cls === 1) {
    // SESSION: agent record carries a session that maps to a single-session transcript.
    agents[agentId] = { session: ownerRun.session };
    sessionTranscript[ownerRun.session] = ownerRun.transcript_path;
    expected[key] = ownerRun.transcript_path;
  } else if (cls === 2) {
    // DIRECT takes priority even when a session is ALSO present (and points elsewhere).
    agents[agentId] = { session: 'decoy-sess', transcript_path: ownerRun.transcript_path };
    sessionTranscript['decoy-sess'] = '/t/decoy.jsonl';
    expected[key] = ownerRun.transcript_path;
  } else {
    // cls 3 or 4 (40% of rows): NO session, NO transcript on the agent record. Recoverable ONLY by
    // correlating window[key] against byWindow. The agent record exists but is empty of join keys.
    agents[agentId] = {};
    expected[key] = ownerRun.transcript_path;
  }
}

// A handful of explicit NULL rows: assignee present but no attribution route, and a no-overlap row.
{
  // far-future window with no overlapping run, empty agent record -> null
  assignee['N/1'] = 'agent-n1';
  agents['agent-n1'] = {};
  window['N/1'] = { start: iso(100000), end: iso(100005) };
  expected['N/1'] = null;
}
{
  // unknown task entirely
  expected['N/zzz'] = null;
}

const registry = { assignee, agents, window, byWindow, sessionTranscript };

// --- assertions: every generated row + explicit nulls + structural edge cases -----------------
let attributed = 0, nulls = 0;
for (const [key, want] of Object.entries(expected)) {
  const got = resolveOwner(key, registry);
  ok(`${key} -> ${want === null ? 'null' : want}`, got === want);
  if (want === null) nulls++; else attributed++;
}

// Structural sanity: empty registry returns null, missing-end window widens to now & still correlates.
ok('empty registry -> null',
  resolveOwner('x', { assignee: {}, agents: {}, window: {}, byWindow: [], sessionTranscript: {} }) === null);

{
  // open-ended task window (no end): missing end widens to now, so it still correlates against a
  // single open-ended run whose window it overlaps. One run only -> unambiguous expected path.
  const reg = {
    assignee: { 'O/1': 'ao' },
    agents: { ao: {} },
    window: { 'O/1': { start: iso(40 + 6) } },        // start inside the run's window, end omitted
    byWindow: [{ session: 'so', transcript_path: '/t/open.jsonl', start: iso(40 + 1), end: iso(40 + 19) }],
    sessionTranscript: {},
  };
  ok('open-ended window widens & correlates', resolveOwner('O/1', reg) === '/t/open.jsonl');
}

console.log(`(${attributed} attributed rows, ${nulls} null rows)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
