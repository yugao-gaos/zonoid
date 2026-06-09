#!/usr/bin/env node
// Plain Node test for the query-by-text scorer behind /search + search_knowledge (no framework;
// matches test/autowire.test.js style). Run: node test/search-knowledge.test.js — exits non-zero
// on any failed assertion. Covers: a free-text query ranks the RELEVANT note ahead of irrelevant
// ones; note nodes (incl. [ingest]) are scored over label+summary; an unrelated query scores 0.
'use strict';
const { scoreNodeAgainstTokens, suggestToks } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Fixture nodes mirroring the graph: ingested knowledge note (relevant), an unrelated note, a
// task, and a near-miss. Free-text query — no anchor task.
const nodes = [
  { id: 'note:1', label: '[ingest] workspace hijack via cwd', summary: 'a malicious task can hijack the worker cwd; pin workspace to the daemon root', kind: 'note' },
  { id: 'note:2', label: '[ingest] stripe refund idempotency keys', summary: 'reuse idempotency keys to avoid double refunds', kind: 'note' },
  { id: 's/7',    label: 'rotate database credentials quarterly', summary: 'vault rotation cron job', kind: 'task' },
  { id: 'note:3', label: '[ingest] git worktree cleanup', summary: 'remove stale attempt branches after merge', kind: 'note' },
];

const query = 'workspace hijack cwd';
const qt = suggestToks(query);

const ranked = nodes
  .map((n) => ({ key: n.id, kind: n.kind, ...scoreNodeAgainstTokens(n, qt) }))
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score);

// --- the relevant ingested note ranks first ---
ok('relevant [ingest] note ranks #1', ranked.length > 0 && ranked[0].key === 'note:1');

// --- it beats every irrelevant node by score ---
ok('relevant note outscores stripe note', (ranked.find((r) => r.key === 'note:1') || {}).score > ((ranked.find((r) => r.key === 'note:2') || { score: 0 }).score));

// --- note nodes are scored (not skipped) ---
ok('note nodes are scored, not excluded', ranked.some((r) => r.kind === 'note'));

// --- the unrelated db task does not surface for this query ---
ok('unrelated db task scores 0 (filtered out)', !ranked.some((r) => r.key === 's/7'));

// --- a query with no overlap returns nothing ---
{
  const qt2 = suggestToks('airline mileage redemption kiosk');
  const r2 = nodes.map((n) => scoreNodeAgainstTokens(n, qt2)).filter((r) => r.score > 0);
  ok('disjoint query yields zero matches', r2.length === 0);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
