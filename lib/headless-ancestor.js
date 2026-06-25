'use strict';

const { listProcs } = require('./proc-list');

function isHeadlessDrainCommand(cmd) {
  const text = String(cmd || '');
  return (
    text.includes('edge-judge single-pass headless mode')
    || text.includes('headless mode against the orchestrator daemon')
    || text.includes('You are ONBOARDING onto an unfamiliar codebase')
    || (text.includes('scripts/onboard-learn.js') && text.includes('--drain'))
    || (text.includes('onboard-learn.js') && text.includes('--drain'))
    || text.includes('scripts/gate-label.js')
    || text.includes('gate-label.js --workspace')
  );
}

/**
 * Walk the parent-process chain from opts.ppid (default: process.ppid) and return
 * true if any ancestor process is running a headless drain command.
 *
 * Cross-platform: delegates process enumeration to lib/proc-list.js which uses
 * `ps` on POSIX and PowerShell Get-CimInstance on Windows.
 *
 * opts.execFileSync is injectable so existing tests (and new proc-list tests) can
 * pass a stub without needing real ps / PowerShell.
 *
 * @param {object} [opts]
 * @param {number}   [opts.ppid]         Starting PID (default: process.ppid)
 * @param {number}   [opts.depth]        Max ancestor hops (default: 8)
 * @param {Function} [opts.execFileSync] Injectable execFileSync for tests
 */
function hasHeadlessDrainAncestor(opts = {}) {
  const depth = Number(opts.depth) || 8;
  let pid = opts.ppid || process.ppid;

  // Build a pid→{ppid, command} lookup from the process list once (avoids
  // spawning ps/PowerShell once per ancestor hop, which was the old pattern).
  let procMap;
  try {
    const procs = listProcs({ execFileSync: opts.execFileSync });
    procMap = new Map(procs.map((p) => [p.pid, p]));
  } catch {
    return false;
  }

  for (let i = 0; i < depth && pid && pid > 1; i++) {
    const entry = procMap.get(pid);
    if (!entry) break;
    if (isHeadlessDrainCommand(entry.command)) return true;
    const next = entry.ppid;
    if (!Number.isFinite(next) || next === pid) break;
    pid = next;
  }
  return false;
}

module.exports = { hasHeadlessDrainAncestor, isHeadlessDrainCommand };
