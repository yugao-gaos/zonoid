#!/usr/bin/env node
// Plain Node test (no framework; matches search-knowledge.test.js style) for temporal / state-change
// reasoning over note nodes — the supersede chain + as-of retrieval (the "Zep gap"). Run:
//   node test/temporal-knowledge.test.js   (exits non-zero on any failed assertion)
// Covers: addNoteNode stamps validFrom/validTo; supersedeNote stamps the old note invalid WITHOUT
// deleting it and chains old↔new; noteChain walks oldest→newest; noteCurrentAsOf returns the fact
// CURRENT at a given instant (history preserved, not just the latest).
'use strict';
const ov = require('../lib/overlay');
const { noteCurrentAsOf } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- build a fact that changed over time: the deploy target moved fly.io → render → railway ---
const o = ov.EMPTY();
const id1 = ov.addNoteNode(o, { title: 'Deploy target: fly.io', summary: 'we deploy the daemon to fly.io', valid_from: '2026-01-01T00:00:00.000Z' });
const id2 = ov.addNoteNode(o, { title: 'Deploy target: render', summary: 'we deploy the daemon to render.com', valid_from: '2026-03-01T00:00:00.000Z' });
const id3 = ov.addNoteNode(o, { title: 'Deploy target: railway', summary: 'we deploy the daemon to railway.app', valid_from: '2026-05-01T00:00:00.000Z' });

// --- new note has a validFrom and an open validTo before being superseded ---
ok('new note stamps validFrom', o.note_nodes[id1].validFrom === '2026-01-01T00:00:00.000Z');
ok('new note validTo is null (current)', o.note_nodes[id1].validTo === null);

// --- chain them: fly.io -> render -> railway ---
ov.supersedeNote(o, id1, id2);  // fly.io retired in favor of render @ render.validFrom
ov.supersedeNote(o, id2, id3);  // render retired in favor of railway @ railway.validFrom

// --- supersede stamps validTo on the old note WITHOUT deleting it (history preserved) ---
ok('old note kept, not deleted', !!o.note_nodes[id1]);
ok('old note stamped validTo', o.note_nodes[id1].validTo === '2026-03-01T00:00:00.000Z');
ok('old note links supersededBy', o.note_nodes[id1].supersededBy === id2);
ok('new note links supersedes', o.note_nodes[id2].supersedes === id1);
ok('newest note still current (validTo null)', o.note_nodes[id3].validTo === null);

// --- chain walks oldest -> newest regardless of which member we ask about ---
const chain = ov.noteChain(o, id2);
ok('noteChain oldest->newest', chain.length === 3 && chain[0] === id1 && chain[2] === id3);

// --- as-of retrieval: the fact CURRENT at a past instant, not just the latest ---
const node = (id) => ({ kind: 'note', validFrom: o.note_nodes[id].validFrom, validTo: o.note_nodes[id].validTo });
// In February, fly.io was current; render/railway not yet true.
ok('as-of Feb: fly.io is current', noteCurrentAsOf(node(id1), '2026-02-01T00:00:00.000Z') === true);
ok('as-of Feb: render not yet true', noteCurrentAsOf(node(id2), '2026-02-01T00:00:00.000Z') === false);
ok('as-of Feb: railway not yet true', noteCurrentAsOf(node(id3), '2026-02-01T00:00:00.000Z') === false);
// In April, render was current; fly.io already retired, railway not yet.
ok('as-of Apr: render is current', noteCurrentAsOf(node(id2), '2026-04-01T00:00:00.000Z') === true);
ok('as-of Apr: fly.io already retired', noteCurrentAsOf(node(id1), '2026-04-01T00:00:00.000Z') === false);
// Now (no asOf), only the latest is current.
ok('latest is current now', o.note_nodes[id3].validTo === null && o.note_nodes[id1].validTo !== null);

// --- non-note nodes are never time-filtered (tasks have no validity window) ---
ok('tasks pass as-of unconditionally', noteCurrentAsOf({ kind: 'task' }, '2020-01-01T00:00:00.000Z') === true);
// --- pre-temporal note (no validFrom) is never filtered (back-compat) ---
ok('pre-temporal note not filtered', noteCurrentAsOf({ kind: 'note' }, '2020-01-01T00:00:00.000Z') === true);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
