#!/usr/bin/env node
// Plain Node test for daemon.js taskTokens read-side time-window correlation (no framework; matches
// test/native-write.test.js style). Run: node test/token-attr.test.js — exits non-zero on any failure.
//
// Regression for the token-attribution bug: a task's assignee is a LOGICAL worker name, but the agent
// record holding transcript_path is registered by the SubagentStart hook under a random harness
// agent_id, so taskTokens used to resolve transcript_path = null for every task. The fix correlates by
// time window: a same-session harness agent whose [startedAt,endedAt] overlaps the task's claim window.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { taskTokens } = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Real transcript file on disk so taskTokens' readUsage parses actual usage (no mocking).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-attr-'));
const harnessTp = path.join(tmp, 'harness.jsonl');
fs.writeFileSync(harnessTp, [
  JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
  JSON.stringify({ message: { usage: { input_tokens: 5, output_tokens: 3 } } }),
].join('\n') + '\n');

try {
  const KEY = 'sessABC/7';
  const SESSION = 'sessABC';

  // The assignee's OWN agent record lacks a transcript (logical worker name, never registered with a path).
  // A separate HARNESS agent in the SAME session, with an overlapping run window, DOES hold the transcript.
  const st = {
    mainTranscript: null,
    overlay: {
      assignee: { [KEY]: 'worker-logical' },
      // Claim window for the task: firstSeen..lastChanged.
      timestamps: { [KEY]: { firstSeen: '2026-06-07T10:00:00.000Z', lastChanged: '2026-06-07T10:05:00.000Z' } },
    },
    agents: {
      'worker-logical': { agent_id: 'worker-logical', session: SESSION, startedAt: '2026-06-07T10:00:00.000Z', endedAt: null, transcript_path: null },
      // harness agent: random hex id, same session, run window overlaps the claim window, HAS transcript.
      'ad0380eeff1b708e5': { agent_id: 'ad0380eeff1b708e5', session: SESSION, startedAt: '2026-06-07T10:00:30.000Z', endedAt: '2026-06-07T10:04:00.000Z', transcript_path: harnessTp },
    },
  };

  const total = taskTokens(KEY, SESSION, false, st);
  ok('taskTokens resolves non-null via time-window correlation', total !== null);
  ok('taskTokens returns the harness transcript total (128)', total === 128);

  // Negative: a harness agent in a DIFFERENT session must NOT be borrowed.
  const stWrongSession = JSON.parse(JSON.stringify(st));
  stWrongSession.agents['ad0380eeff1b708e5'].session = 'otherSession';
  ok('no borrow across sessions', taskTokens(KEY, SESSION, false, stWrongSession) === null);

  // Negative: a harness agent whose window does NOT overlap the claim must NOT be borrowed.
  const stNoOverlap = JSON.parse(JSON.stringify(st));
  stNoOverlap.agents['ad0380eeff1b708e5'].startedAt = '2026-06-07T11:00:00.000Z';
  stNoOverlap.agents['ad0380eeff1b708e5'].endedAt = '2026-06-07T11:05:00.000Z';
  ok('no borrow when windows disjoint', taskTokens(KEY, SESSION, false, stNoOverlap) === null);

  // Preserve existing behavior: a direct assignee transcript takes precedence (no fallback used).
  const stDirect = JSON.parse(JSON.stringify(st));
  stDirect.agents['worker-logical'].transcript_path = harnessTp;
  // Make the harness window NOT overlap so we know the value came from the direct path, not fallback.
  stDirect.agents['ad0380eeff1b708e5'].transcript_path = null;
  ok('direct assignee transcript still wins', taskTokens(KEY, SESSION, false, stDirect) === 128);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
