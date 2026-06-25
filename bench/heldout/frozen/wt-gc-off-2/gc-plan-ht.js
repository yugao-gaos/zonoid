'use strict';

// GC planner for the orchestrator's `worktrees/` directory.
//
// Each self-improvement attempt leaves a worktree behind. gcPlan decides which
// of those entries are safe to delete (`reclaim`) and which to leave alone
// (`keep`). Deletion is permanent, so the policy errs toward keeping: anything
// active, holding unmerged work, or recently touched is protected.

// Don't reclaim anything modified more recently than this — a fresh worktree may
// be mid-setup (created, not yet claimed or populated).
const STALE_HOURS = 24;

function gcPlan(entries) {
  const reclaim = [];
  const keep = [];

  for (const e of entries) {
    if (shouldReclaim(e)) reclaim.push(e.path);
    else keep.push(e.path);
  }

  return { reclaim, keep };
}

function shouldReclaim(e) {
  // An agent is actively using it.
  if (e.claimed) return false;

  // Its branch has unmerged commits — deleting would lose that work.
  if (e.branchMerged === false) return false;

  // Too fresh to be sure it's abandoned.
  if (e.ageHours < STALE_HOURS) return false;

  // Stale and unclaimed, with no unmerged work to protect:
  //   - empty leftover dir,
  //   - branch fully merged into main (branchMerged === true), or
  //   - no branch at all (branchMerged === null) — an orphan.
  return true;
}

module.exports = { gcPlan };
