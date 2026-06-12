'use strict';

const RETENTION_HOURS = 24;

function shouldReclaim(entry) {
  // Never remove an actively claimed worktree
  if (entry.claimed) return false;

  // Empty directories are always safe to remove
  if (entry.isEmptyDir) return true;

  // Fully merged + outside retention window
  if (entry.branchMerged === true && entry.ageHours >= RETENTION_HOURS) return true;

  // Unregistered from git and stale: orphaned
  if (!entry.registered && entry.ageHours >= RETENTION_HOURS) return true;

  return false;
}

function gcPlan(entries) {
  const reclaim = [];
  const keep = [];
  for (const entry of entries) {
    (shouldReclaim(entry) ? reclaim : keep).push(entry.path);
  }
  return { reclaim, keep };
}

module.exports = { gcPlan };
