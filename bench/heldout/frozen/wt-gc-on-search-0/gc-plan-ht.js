// Retention window: worktrees younger than this are kept even if merged/unregistered.
const RETENTION_HOURS = 24;

/**
 * @param {Array<{path:string, isEmptyDir:boolean, registered:boolean, branchMerged:boolean|null, claimed:boolean, ageHours:number}>} entries
 * @returns {{ reclaim: string[], keep: string[] }}
 */
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

function shouldReclaim({ isEmptyDir, registered, branchMerged, claimed, ageHours }) {
  // Never touch an actively claimed worktree.
  if (claimed) return false;

  // Empty directories hold no work — safe to remove immediately.
  if (isEmptyDir) return true;

  // Git no longer tracks this path and it has aged past retention.
  if (!registered && ageHours >= RETENTION_HOURS) return true;

  // Branch is fully merged into main, unclaimed, and outside the retention window.
  if (branchMerged === true && ageHours >= RETENTION_HOURS) return true;

  return false;
}

module.exports = { gcPlan };
