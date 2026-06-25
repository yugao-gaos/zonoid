#!/usr/bin/env node
// Plain Node test (no framework; matches test/token-attr.test.js style) for rework-aware,
// role-tagged per-task cost accumulation in lib/usage-accounting.js. Run:
//   node test/task-cost-accum.test.js  — exits non-zero on any failure.
//
// Covers the multi-attempt lifecycle: worker run (+impl) → judge run (+review) → KICK BACK →
// worker run (+impl) → judge run (+review). The rollup must SUM across attempts (usage_records is
// keyed by agent_id and overwrites; task_costs must not), role-tag impl vs review, and report
// total = Σimpl + Σreview with attempts = number of contributing agent-run finishes.
'use strict';
const ua = require('../lib/usage-accounting');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const TASK = 'sessX/9';
const mkSlice = (agent_id, output, endedAt, opts = {}) => ({
  agent_id, task_key: TASK, endedAt,
  usage: { output_tokens: output },
  judged_node: opts.judged_node || null,
  role: opts.role || null,
});

const ov = {};

// 1) Worker run #1 — implementation (no judge marker).
ua.recordTaskCost(ov, mkSlice('worker-a', 1000, '2026-06-15T10:00:00Z'));
// 2) Judge run #1 — review (carries judged_node, the eager-judge marker).
ua.recordTaskCost(ov, mkSlice('judge-a', 300, '2026-06-15T10:05:00Z', { judged_node: TASK }));
// 3) KICK BACK → worker run #2 — implementation. SAME logical worker may reuse agent_id; here a
//    distinct re-run finish (new endedAt) must accumulate, not overwrite.
ua.recordTaskCost(ov, mkSlice('worker-a', 800, '2026-06-15T10:10:00Z'));
// 4) Judge run #2 — review, tagged explicitly via role (judge dispatched against attempt branch).
ua.recordTaskCost(ov, mkSlice('judge-b', 200, '2026-06-15T10:15:00Z', { role: 'review' }));

const roll = ua.taskCost(ov, TASK);

ok('rollup exists', !!roll);
ok('impl_tokens sums the two worker runs (1000+800=1800)', roll.impl_tokens === 1800);
ok('review_tokens sums the two judge runs (300+200=500)', roll.review_tokens === 500);
ok('total = Σimpl + Σreview (2300)', roll.total === 2300);
ok('attempts counts all four agent-run finishes', roll.attempts === 4);

// Role classification helpers.
ok('judged_node ⇒ review', ua.roleForSlice({ judged_node: 'n1' }) === 'review');
ok('explicit role=review wins', ua.roleForSlice({ role: 'review' }) === 'review');
ok('no marker ⇒ implementation', ua.roleForSlice({}) === 'implementation');
ok('explicit role beats judged_node', ua.roleForSlice({ role: 'implementation', judged_node: 'n1' }) === 'implementation');

// Idempotency: re-POSTing the SAME finish (same agent_id + endedAt) must NOT double-count.
ua.recordTaskCost(ov, mkSlice('judge-b', 200, '2026-06-15T10:15:00Z', { role: 'review' }));
const roll2 = ua.taskCost(ov, TASK);
ok('duplicate finish not re-counted (review still 500)', roll2.review_tokens === 500);
ok('duplicate finish does not bump attempts (still 4)', roll2.attempts === 4);

// Slice without a task_key is ignored (no crash, no phantom rollup).
ok('no-task_key slice ignored', ua.recordTaskCost(ov, { agent_id: 'x', usage: { output_tokens: 5 } }) === null);

// Unknown task returns null from taskCost.
ok('unknown task ⇒ null', ua.taskCost(ov, 'no/such') === null);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
