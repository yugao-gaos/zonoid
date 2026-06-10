#!/usr/bin/env node
// Plain Node test for lib/delta.js (the /graph/delta change sensor) — no framework; matches the
// style of test/native-write.test.js / test/repo-target.test.js. Run: node test/graph-delta.test.js
// Pure-lib assertions only: parseSince validation + computeDelta bucketing/ordering/counts over a
// synthetic graph+overlay (the route is a thin wrapper; the HTTP path is covered by the daemon's
// existing read plumbing).
'use strict';
const delta = require('../lib/delta');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- parseSince: 400-path validation ---
ok('missing since rejected', delta.parseSince(null).ok === false);
ok('empty since rejected', delta.parseSince('').ok === false);
ok('garbage since rejected', delta.parseSince('not-a-date').ok === false);
ok('valid ISO accepted', delta.parseSince('2026-06-09T00:00:00Z').ok === true);
ok('parsed ms matches', delta.parseSince('2026-06-09T00:00:00Z').ms === Date.parse('2026-06-09T00:00:00Z'));

// --- computeDelta over a synthetic graph + overlay ---
const SINCE = '2026-06-09T00:00:00.000Z';
const sinceMs = Date.parse(SINCE);
const BEFORE = '2026-06-08T12:00:00.000Z';   // before the baseline
const T1 = '2026-06-09T01:00:00.000Z';       // after
const T2 = '2026-06-09T02:00:00.000Z';       // after, later

const tasks = [
  // changed AFTER since (created before): reached done — must land in status_changes only.
  { id: 's/1', label: 'finished work', status: 'done', kind: 'task' },
  // created AND changed after since: created + later re-changed -> both buckets.
  { id: 's/2', label: 'new then canceled', status: 'canceled' },
  // created after since, never re-changed -> tasks_created ONLY (no double-count).
  { id: 's/3', label: 'brand new', status: 'ready' },
  // untouched since before the baseline -> excluded everywhere.
  { id: 's/4', label: 'old stable', status: 'done' },
  // no timestamps recorded at all -> excluded (nothing derivable).
  { id: 's/5', label: 'untracked', status: 'ready' },
  // note node mixed into the graph list -> skipped by the task buckets.
  { id: 'note:n-new', label: 'a note', kind: 'note', status: 'note' },
];
const overlay = {
  timestamps: {
    's/1': { firstSeen: BEFORE, lastChanged: T2, lastStatus: 'done' },
    's/2': { firstSeen: T1, lastChanged: T2, lastStatus: 'canceled' },
    's/3': { firstSeen: T1, lastChanged: T1, lastStatus: 'ready' },
    's/4': { firstSeen: BEFORE, lastChanged: BEFORE, lastStatus: 'done' },
  },
  note_nodes: {
    'n-new': { id: 'n-new', title: 'fresh decision', summary: 'recorded after T', created_at: T1 },
    'n-old': { id: 'n-old', title: 'old decision', summary: 'recorded before T', created_at: BEFORE },
  },
  knowledge: {
    's/1': [
      // timestamped verdict (object value) after T -> included in merges.
      { type: 'note', value: { winner: 's/1', at: T2 } },
      // verdict WITHOUT any timestamp -> omitted (not derivable, by design).
      { type: 'note', value: { winner: 's/1', metric_value: 42 } },
      // non-verdict knowledge -> ignored.
      { type: 'snippet', value: 'just a snippet' },
    ],
    's/4': [
      // string-encoded verdict with an item-level timestamp BEFORE T -> excluded by time.
      { type: 'note', ts: BEFORE, value: JSON.stringify({ winner: 's/4' }) },
      // string-encoded verdict with a value-level timestamp after T -> included.
      { type: 'note', value: JSON.stringify({ winner: 's/4b', merged_at: T1 }) },
    ],
  },
};

const d = delta.computeDelta(tasks, overlay, sinceMs);

ok('echoes since', d.since === SINCE);
ok('now is parseable', !Number.isNaN(Date.parse(d.now)));

// status_changes: s/1 (done after T) + s/2 (changed after creation) — NOT s/3 (pure creation),
// NOT s/4 (old), NOT s/5 (untracked), NOT the note node.
ok('status_changes count', d.status_changes.length === 2);
ok('status_changes ordered oldest first', d.status_changes.map((x) => x.key).join(',') === 's/2,s/1' || d.status_changes.map((x) => x.key).join(',') === 's/1,s/2');
ok('done task surfaces with current status', d.status_changes.some((x) => x.key === 's/1' && x.status === 'done' && x.lastChanged === T2));
ok('canceled task surfaces', d.status_changes.some((x) => x.key === 's/2' && x.status === 'canceled'));
ok('pure creation NOT double-counted as change', !d.status_changes.some((x) => x.key === 's/3'));
ok('note node excluded from task buckets', !d.status_changes.concat(d.tasks_created).some((x) => x.key === 'note:n-new'));

// tasks_created: s/2 + s/3 (firstSeen after T), ascending by firstSeen.
ok('tasks_created count', d.tasks_created.length === 2);
ok('created entries carry firstSeen', d.tasks_created.every((x) => x.firstSeen === T1));
ok('old task excluded from created', !d.tasks_created.some((x) => x.key === 's/4' || x.key === 's/1'));

// notes_added: only the post-T note.
ok('notes_added count', d.notes_added.length === 1);
ok('note carries key/title/summary', d.notes_added[0].key === 'note:n-new' && d.notes_added[0].title === 'fresh decision' && d.notes_added[0].summary === 'recorded after T');

// merges: the two TIMESTAMPED verdicts after T (object + string-encoded); timestamp-less omitted.
ok('merges count', d.merges.length === 2);
ok('object verdict included', d.merges.some((x) => x.key === 's/1' && x.winner === 's/1' && x.at === T2));
ok('string verdict with merged_at included', d.merges.some((x) => x.key === 's/4' && x.winner === 's/4b' && x.at === T1));
ok('pre-T verdict excluded', !d.merges.some((x) => x.winner === 's/4'));
ok('merges ordered oldest first', d.merges[0].at <= d.merges[1].at);

// counts summary mirrors the buckets.
ok('counts match buckets', d.counts.status_changes === 2 && d.counts.tasks_created === 2 && d.counts.notes_added === 1 && d.counts.merges === 2);

// empty overlay -> all-zero delta, never throws.
const empty = delta.computeDelta([], {}, sinceMs);
ok('empty overlay yields zero counts', empty.counts.status_changes === 0 && empty.counts.tasks_created === 0 && empty.counts.notes_added === 0 && empty.counts.merges === 0);

// itemTimestamp probes item then value, common field spellings.
ok('itemTimestamp null when absent', delta.itemTimestamp({ type: 'note' }, { winner: 'x' }) === null);
ok('itemTimestamp reads value.measured_at', (delta.itemTimestamp({}, { measured_at: T1 }) || {}).iso === T1);
ok('itemTimestamp ignores non-string ts fields', delta.itemTimestamp({ ts: 12345 }, null) === null);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
