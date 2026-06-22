'use strict';

const { execFileSync } = require('child_process');

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

function hasHeadlessDrainAncestor(opts = {}) {
  const execFile = opts.execFileSync || execFileSync;
  let pid = opts.ppid || process.ppid;
  const depth = Number(opts.depth) || 8;
  for (let i = 0; i < depth && pid && pid > 1; i++) {
    let cmd = '';
    try { cmd = execFile('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { cmd = ''; }
    if (isHeadlessDrainCommand(cmd)) return true;
    let next = '';
    try { next = execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { next = ''; }
    const parsed = Number(next);
    if (!Number.isFinite(parsed) || parsed === pid) break;
    pid = parsed;
  }
  return false;
}

module.exports = { hasHeadlessDrainAncestor, isHeadlessDrainCommand };
