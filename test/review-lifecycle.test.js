#!/usr/bin/env node
// Plain Node tests for the same-node review lifecycle contract.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const frontier = require('../lib/frontier');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const KEY = 'codex/review-state-lifecycle-contract';
const REVIEWED_AT = '2026-06-22T12:00:00.000Z';

// --- explicit helper state + git attempt pointers -----------------------------------------------
{
  const o = ov.EMPTY();
  ov.setGit(o, KEY, { branch: 'orch/attempt/codex-review-state-lifecycle-contract', worktree: '/tmp/attempt', head: 'abc123' });
  ov.setReviewLifecycle(o, KEY, {
    review_state: 'approved',
    review_verdict: 'approved',
    reason: 'diff is focused',
    review_agent: 'reviewer-a',
    reviewed_at: REVIEWED_AT,
  });
  const r = ov.reviewLifecycleFor(o, KEY, 'tested');
  ok('explicit review state is projected', r.review_state === 'approved');
  ok('review verdict aliases normalize to APPROVE', r.review_verdict === 'APPROVE');
  ok('reason aliases to review note/reason', r.review_note === 'diff is focused' && r.review_reason === 'diff is focused');
  ok('review agent and timestamp are preserved', r.review_agent === 'reviewer-a' && r.reviewed_at === REVIEWED_AT);
  ok('attempt pointers fall back to git info', r.attempt_branch === 'orch/attempt/codex-review-state-lifecycle-contract' && r.attempt_worktree === '/tmp/attempt' && r.attempt_head === 'abc123');
  ok('tested status derives pending merge state', r.merge_state === 'pending');
}

// --- coarse status defaults remain the compatibility contract ------------------------------------
{
  const o = ov.EMPTY();
  ov.setReviewFromStatus(o, KEY, 'tested', { agent_id: 'worker-a', summary: 'verified', now: REVIEWED_AT });
  const r = ov.reviewLifecycleFor(o, KEY, 'tested');
  ok('tested means approved', r.review_state === 'approved' && r.review_verdict === 'APPROVE');
  ok('tested means awaiting merge', r.merge_state === 'pending');
  ok('status default records reviewer context', r.review_agent === 'worker-a' && r.review_note === 'verified');
}
{
  const o = ov.EMPTY();
  ov.setReviewFromStatus(o, KEY, 'failed', { agent_id: 'reviewer-b', note: 'needs fixes', now: REVIEWED_AT });
  const r = ov.reviewLifecycleFor(o, KEY, 'failed');
  ok('failed means rejected/kicked back', r.review_state === 'rejected' && r.review_verdict === 'KICK_BACK');
  ok('failed blocks merge', r.merge_state === 'blocked');
}
{
  const o = ov.EMPTY();
  ov.setReviewLifecycle(o, KEY, { review_state: 'approved', merge_state: 'pending' });
  ov.setGit(o, KEY, { branch: 'orch/attempt/codex-review-state-lifecycle-contract', merged: true, merge_sha: 'def456', merged_at: REVIEWED_AT });
  const r = ov.reviewLifecycleFor(o, KEY, 'done');
  ok('done means landed', r.review_state === 'landed');
  ok('merged git info overrides stale pending merge state', r.merge_state === 'merged' && r.merge_sha === 'def456' && r.merged_at === REVIEWED_AT);
}

// --- overlay serialization round-trip ------------------------------------------------------------
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-review-lifecycle-'));
  const o = ov.EMPTY();
  ov.setReviewLifecycle(o, KEY, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    review_note: 'round trip',
    reviewed_at: REVIEWED_AT,
    merge_state: 'pending',
  });
  ov.save(ws, o);
  const loaded = ov.load(ws);
  const r = ov.reviewLifecycleFor(loaded, KEY, 'tested');
  ok('review lifecycle survives save/load', r.review_state === 'approved' && r.review_note === 'round trip' && r.merge_state === 'pending');
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- frontier slim projection keeps lifecycle state but drops heavy pointers ----------------------
{
  const slim = frontier.slimNode({
    id: KEY,
    label: 'Review state lifecycle',
    status: 'tested',
    deps: [],
    context_deps: [],
    review_state: 'approved',
    review_verdict: 'APPROVE',
    review_note: 'large detail',
    review_agent: 'reviewer-a',
    reviewed_at: REVIEWED_AT,
    merge_state: 'pending',
    attempt_branch: 'orch/attempt/codex-review-state-lifecycle-contract',
  });
  ok('frontier slim keeps lightweight review fields', slim.review_state === 'approved' && slim.review_verdict === 'APPROVE' && slim.merge_state === 'pending');
  ok('frontier slim keeps reviewer timestamp context', slim.review_agent === 'reviewer-a' && slim.reviewed_at === REVIEWED_AT);
  ok('frontier slim drops heavy review detail and branch pointers', !('review_note' in slim) && !('attempt_branch' in slim));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
