'use strict';

// Hours of inactivity before an unclaimed, content-bearing worktree is
// considered abandoned and eligible for reclamation.
const STALE_HOURS = 24;

// Decide a single scan entry: true => reclaim (delete), false => keep.
// Ordered so that "keep" wins on any doubt — reclaimed paths are deleted
// permanently, so we only reclaim when it is clearly safe.
function shouldReclaim(e) {
  // An agent is actively holding it: never touch, regardless of anything else.
  if (e.claimed) return false;

  // Empty directory: a leftover scaffold with nothing to lose.
  if (e.isEmptyDir) return true;

  // Branch exists and is NOT merged: unmerged work — protect it.
  if (e.branchMerged === false) return false;

  // Remaining cases (unclaimed, has content, and either merged into main or
  // an orphan with no branch): reclaim only once it has gone stale, so we
  // don't race work that is still in progress.
  return e.ageHours >= STALE_HOURS;
}

function gcPlan(entries) {
  const reclaim = [];
  const keep = [];
  for (const e of entries) {
    if (shouldReclaim(e)) reclaim.push(e.path);
    else keep.push(e.path);
  }
  return { reclaim, keep };
}

module.exports = { gcPlan };
