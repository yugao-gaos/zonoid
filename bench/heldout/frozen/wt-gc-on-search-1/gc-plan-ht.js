'use strict';

// Default retention window, mirroring scripts/gc-worktrees.js (--retention-hours 24).
// Anything modified more recently than this is left alone even if otherwise reclaimable,
// to avoid racing a worktree that is mid-creation or just finished.
const RETENTION_HOURS = 24;

// Decide whether a single scan entry is safe to delete.
//
// We only reclaim when the entry holds no un-judged work to lose. The two safe
// cases are:
//   - an empty directory (an accumulated parent/leftover with nothing in it), or
//   - a worktree whose branch is fully merged into main (its value is extracted).
// In every other case we keep: an active claim, an unmerged branch
// (branchMerged === false), or no branch at all (branchMerged === null, ambiguous)
// could all represent work that must not be silently orphaned.
function shouldReclaim(entry) {
  if (entry.claimed) return false;                 // an agent still holds it
  if (entry.ageHours < RETENTION_HOURS) return false; // inside retention window
  if (entry.isEmptyDir) return true;               // nothing to lose
  if (entry.branchMerged === true) return true;    // merged, value extracted
  return false;                                    // unmerged / no branch -> keep
}

function gcPlan(entries) {
  const reclaim = [];
  const keep = [];
  for (const entry of entries) {
    if (shouldReclaim(entry)) {
      reclaim.push(entry.path);
    } else {
      keep.push(entry.path);
    }
  }
  return { reclaim, keep };
}

module.exports = { gcPlan };
