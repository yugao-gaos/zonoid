'use strict';

// GC planner for the orchestrator's `worktrees/` directory.
//
// Each self-improvement attempt leaves a worktree behind. This decides which
// stale leftovers are safe to delete and which must be left alone. It is
// deliberately conservative: when in doubt, keep. Reclaimed paths are deleted
// permanently by the caller, so the bar for reclaiming is "we are confident no
// unfinished work is lost".

const STALE_HOURS = 24;

// A single entry is safe to reclaim only when every guard agrees.
function reclaimable(e) {
  // An agent is actively holding it — never touch it.
  if (e.claimed) return false;

  // Fresh entries may be mid-creation or in active (unclaimed) use. Leave them.
  if (e.ageHours < STALE_HOURS) return false;

  // Empty directory: nothing inside, so there is no work to lose regardless of
  // branch/registration state.
  if (e.isEmptyDir) return true;

  // Non-empty: only safe if its branch is fully merged into main, i.e. the work
  // is already captured. Unmerged work (false) or work with no branch (null)
  // could be uncommitted/uncaptured — keep it.
  if (e.branchMerged === true) return true;

  return false;
}

function gcPlan(entries) {
  const reclaim = [];
  const keep = [];
  for (const e of entries) {
    (reclaimable(e) ? reclaim : keep).push(e.path);
  }
  return { reclaim, keep };
}

module.exports = { gcPlan };
