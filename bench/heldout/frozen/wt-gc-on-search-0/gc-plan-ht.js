'use strict';

// Retention window: a merged worktree is kept this long after its last
// modification so a human (or the hold-merge review flow) still has a chance
// to look at it before it is reclaimed. Matches scripts/gc-worktrees.js (24h).
const RETENTION_HOURS = 24;

// Decide a GC plan for a scan of the worktrees/ directory.
//
// Principle (from the worktree-lifecycle policy): worktrees are ephemeral and
// reclaimable ONLY once their durable value has been extracted — i.e. the
// branch is fully merged into main — and only when nothing is still using
// them. Empty directories carry no value at all. Anything with unmerged work,
// an active claim, or an unknown branch state is NEEDS-ATTENTION and kept, so
// we never silently orphan un-judged work.
//
// `keep` is the safe default; an entry is reclaimed only when it provably
// clears every safety check.
function gcPlan(entries) {
  const reclaim = [];
  const keep = [];

  for (const e of entries) {
    if (shouldReclaim(e)) {
      reclaim.push(e.path);
    } else {
      keep.push(e.path);
    }
  }

  return { reclaim, keep };
}

function shouldReclaim(e) {
  // 1. An agent is actively using it — never touch.
  if (e.claimed) return false;

  // 2. Empty directory: no code, no value (e.g. leftover parent dirs). Reclaim.
  if (e.isEmptyDir) return true;

  // 3. Unmerged commits: durable value not yet extracted. NEEDS-ATTENTION, keep.
  if (e.branchMerged === false) return false;

  // 4. Fully merged and past the retention window: value extracted, safe to reap.
  if (e.branchMerged === true && e.ageHours >= RETENTION_HOURS) return true;

  // 5. Everything else — merged-but-recent, or no branch (unknown state) — keep.
  return false;
}

module.exports = { gcPlan };
