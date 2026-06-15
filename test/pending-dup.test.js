/**
 * Tests for the DEFER-TO-JUDGE pending_dup flow (write-time dup guard turned from REJECT into
 * admit-provisional + dup-judge adjudication). Pure/in-process — exercises lib/overlay + lib/judge
 * directly (no daemon HTTP), which deterministically covers the lifecycle the prompt requires:
 *
 *   - guard fire admits the note provisional + retrieval-invisible + enqueued for the dup-judge;
 *   - the recall path EXCLUDES a pending_dup note, INCLUDES it after DISTINCT;
 *   - CONSOLIDATE supersedes the new note into the match (and clears provisional);
 *   - timeout flips visible WITHOUT clearing the eager/queue membership, and the note is STILL
 *     re-judged afterward (assert it remains in pendingDupClusters / the dup-queue);
 *   - persistence round-trip: pendingDup survives save()/load().
 *
 * The force:true / supersedes bypass + the ok:true pending_dup response are covered end-to-end in
 * test/note-dup-guard.test.js (live daemon).
 *
 * Run: node test/pending-dup.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ov = require('../lib/overlay');
const judge = require('../lib/judge');

// Two unit vectors with cosine ~0.74 — the 0.70–0.80 band where the WRITE guard fires (>=0.70) but
// the natural dupClusters() recall (>=0.80) does NOT, so the pair only ever reaches the judge via the
// pending-dup queue. (Identical-vec pairs would also form a natural cluster, hiding the pending path.)
const VEC_A = (() => { const v = new Array(384).fill(0); v[0] = 1; return v; })();
const VEC_B = (() => { const v = new Array(384).fill(0); v[0] = 0.74; v[1] = Math.sqrt(1 - 0.74 * 0.74); return v; })();
const TIMEOUT = 10 * 60 * 1000;

// Helper: a fresh overlay with two CURRENT notes (match + new), where `new` is pending_dup vs `match`.
function seedPending() {
  const overlay = ov.EMPTY();
  const matchId = ov.addNoteNode(overlay, { title: 'locale sum bug', summary: 'parseFloat mis-sums', vec: VEC_A });
  const newId   = ov.addNoteNode(overlay, { title: 'locale sum bug v2', summary: 'parseFloat mis-sums again', vec: VEC_B });
  const matchKey = 'note:' + matchId, newKey = 'note:' + newId;
  ov.bumpEpoch(overlay);                               // makes the pair re-pullable (judgedAtEpoch < epoch)
  ov.markPendingDup(overlay, newKey, matchKey, 0.74);
  return { overlay, matchKey, newKey };
}

test('guard fire: note admitted provisional + retrieval-invisible + enqueued for judge', () => {
  const { overlay, matchKey, newKey } = seedPending();

  // admitted: the note exists and is current.
  assert.ok(overlay.note_nodes[newKey.replace(/^note:/, '')], 'new note admitted into note_nodes');
  // provisional flag recorded with the match key.
  assert.ok(ov.isPendingDup(overlay, newKey), 'new note flagged pending_dup');
  assert.equal(overlay.pendingDup[newKey].match, matchKey, 'pendingDup records the match key');

  // retrieval-invisible: pendingDupState says NOT visible while within the timeout.
  const st = judge.pendingDupState(overlay, newKey, Date.now(), TIMEOUT);
  assert.equal(st.pending, true, 'state.pending');
  assert.equal(st.visible, false, 'pending note is retrieval-invisible within timeout');

  // enqueued for the dup-judge: the {new,match} pair appears as a dup-cluster work item.
  const clusters = judge.pendingDupClusters(overlay);
  assert.equal(clusters.length, 1, 'one pending-dup cluster');
  assert.deepEqual(clusters[0], [matchKey, newKey].sort(), 'cluster = {match,new}');
  const queue = judge.buildQueue(overlay);
  const dupItem = queue.find((i) => i.kind === 'dup-cluster' && i.pending_dup);
  assert.ok(dupItem, 'pending-dup pair surfaced in buildQueue as a dup-cluster item');
  assert.ok(judge.judgeQueueDepth(overlay) >= 1, 'queue depth counts the pending-dup pair');
});

test('recall path EXCLUDES a pending_dup note, INCLUDES it after DISTINCT', () => {
  const { overlay, newKey } = seedPending();
  const now = Date.now();
  // Mirror routes/graph.js dupInvisible(): excluded while pending+not-timed-out.
  assert.equal(judge.pendingDupState(overlay, newKey, now, TIMEOUT).visible, false, 'excluded from recall while pending');

  // DISTINCT verdict (markDistinct in routes/judge.js) clears provisional.
  ov.clearPendingDup(overlay, newKey);
  assert.equal(ov.isPendingDup(overlay, newKey), false, 'cleared after DISTINCT');
  assert.equal(judge.pendingDupState(overlay, newKey, now, TIMEOUT).visible, true, 'recall-eligible after DISTINCT');
  // and it no longer occupies the dup-queue.
  assert.equal(judge.pendingDupClusters(overlay).length, 0, 'pair drops out of the queue after DISTINCT');
});

test('CONSOLIDATE supersedes the new note into the match (and clears provisional)', () => {
  const { overlay, matchKey, newKey } = seedPending();
  const keepId = matchKey.replace(/^note:/, ''), newId = newKey.replace(/^note:/, '');

  // Apply the consolidate effect (as routes/judge.js does): supersede new into match + clear provisional.
  const r = ov.supersedeNote(overlay, newId, keepId);
  assert.ok(r.ok, 'supersede applied');
  ov.clearPendingDup(overlay, matchKey);
  ov.clearPendingDup(overlay, newKey);

  assert.ok(overlay.note_nodes[newId].validTo, 'new note retired (validTo set) — superseded into match');
  assert.equal(overlay.note_nodes[newId].supersededBy, keepId, 'new.supersededBy = match');
  assert.equal(ov.isPendingDup(overlay, newKey), false, 'provisional cleared on consolidate');
  // A superseded member means the pair is moot — pendingDupClusters drops it.
  assert.equal(judge.pendingDupClusters(overlay).length, 0, 'consolidated pair leaves the dup-queue');
});

test('timeout flips visible WITHOUT clearing the eager/queue membership; note STILL re-judged', () => {
  const { overlay, matchKey, newKey } = seedPending();
  // Backdate the anchor so the entry is past the timeout.
  overlay.pendingDup[newKey].at = Date.now() - (TIMEOUT + 60_000);
  const now = Date.now();

  const st = judge.pendingDupState(overlay, newKey, now, TIMEOUT);
  // PURE derived flip: still pending, timed out, now VISIBLE (provisional) — entry NOT mutated.
  assert.equal(st.pending, true, 'still pending (entry not dropped on timeout)');
  assert.equal(st.timedOut, true, 'timed out');
  assert.equal(st.visible, true, 'timed-out pending note falls back to visible');

  // NON-DESTRUCTIVE: the pendingDup entry survives — the note is STILL enqueued for the dup-judge.
  assert.ok(ov.isPendingDup(overlay, newKey), 'timeout did NOT clear the pendingDup entry');
  assert.equal(overlay.pendingDup[newKey].match, matchKey, 'match key still present after timeout');
  const clusters = judge.pendingDupClusters(overlay);
  assert.equal(clusters.length, 1, 'timed-out pair STILL surfaced for re-judgment');
  // judgedAtEpoch < epoch ⇒ still pending at the cluster watermark (re-pullable).
  assert.equal(judge.clusterPending(overlay, clusters[0]), true, 'cluster still pending (re-judgeable)');
  const inQueue = judge.buildQueue(overlay).some((i) => i.kind === 'dup-cluster');
  assert.ok(inQueue, 'timed-out pending-dup pair remains in buildQueue');
});

test('persistence: pendingDup survives a save()/load() round-trip', () => {
  const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-penddup-')));
  const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
  // overlay module read BASE at require-time; re-require with the sandbox env via a fresh module cache.
  delete require.cache[require.resolve('../lib/overlay')];
  const ov2 = require('../lib/overlay');
  try {
    const WS = path.join(SANDBOX, 'ws');
    const overlay = ov2.EMPTY();
    const matchId = ov2.addNoteNode(overlay, { title: 'a', summary: 'a', vec: VEC_A });
    const newId   = ov2.addNoteNode(overlay, { title: 'a2', summary: 'a2', vec: VEC_B });
    ov2.markPendingDup(overlay, 'note:' + newId, 'note:' + matchId, 0.74);
    ov2.save(WS, overlay);

    const reloaded = ov2.load(WS);
    assert.ok(reloaded.pendingDup && reloaded.pendingDup['note:' + newId], 'pendingDup survived reload');
    assert.equal(reloaded.pendingDup['note:' + newId].match, 'note:' + matchId, 'match key survived');
    assert.equal(typeof reloaded.pendingDup['note:' + newId].at, 'number', 'timeout anchor survived');
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
    delete require.cache[require.resolve('../lib/overlay')];
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
  }
});
