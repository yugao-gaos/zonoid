'use strict';

const STALE_HOURS = 168; // 1 week

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
  // Claimed worktrees are always kept — an agent is actively using them
  if (e.claimed) return false;

  // Empty directories have nothing to lose
  if (e.isEmptyDir) return true;

  // Branch fully merged into main — work is done
  if (e.branchMerged === true) return true;

  // Git no longer knows about this path — orphaned after abnormal exit
  if (!e.registered) return true;

  // Unclaimed and untouched for over a week — give up on unresolved attempts
  if (e.ageHours > STALE_HOURS) return true;

  return false;
}

module.exports = { gcPlan };
