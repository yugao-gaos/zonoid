#!/usr/bin/env node
'use strict';
// PreToolUse(Bash) GATE: refuse Bash commands that write files unless THIS conversation has a task
// claimed in_progress. Cross-platform Node port of orch-gate-bash.sh — closes the bypass path where
// a shell command (redirect, tee, cp, python -c "open(...,'w')", sed -i, dd) writes outside a claim.
// Exit 2 = deny; exit 0 = allow. Fail-open if the daemon is unreachable.
const k = require('./lib/hookkit');

const PORT = k.PORT;

// ── write target exempt-list (slash-normalized; mirrors is_exempt() in bash) ──
function isExempt(p) {
  const s = k.normalizePath(p);
  if (!s) return false;
  if (s.startsWith('/tmp/') || s.startsWith('/private/tmp/')) return true;
  if (s === '/dev/null' || s === '/dev/stderr' || s === '/dev/stdout') return true;
  if (/\/\.claude\/projects\/.*\/memory\//.test(s)) return true;
  if (s.endsWith('/.claude/settings.json') || s.endsWith('/.claude/settings.local.json')) return true;
  if (s.endsWith('/.claude/keybindings.json') || s.endsWith('/.claude/launch.json')) return true;
  if (s.endsWith('/.mcp.json')) return true;
  if (s.endsWith('/CLAUDE.md')) return true;
  if (s.includes('/.claude/orchestrator/tasks/')) return true;
  if (s.includes('/.claude/tasks/')) return true;
  if (s.includes('/scratch/')) return true;
  if (s.endsWith('.log') || s.includes('/logs/')) return true;
  return false;
}

function resolveTarget(t, wt) {
  const s = k.slash(t);
  const isAbs = s.startsWith('/') || /^[A-Za-z]:\//.test(s);
  return k.normalizePath(isAbs ? s : `${k.slash(wt).replace(/\/+$/, '')}/${s}`);
}


(async () => {
  if (k.gateOff()) k.allow();
  const input = await k.readInput();
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!cmd) k.allow();                        // no command -> nothing to check

  // ── Git VCS exemption: plumbing operates on already-claimed, already-edited work. ──
  const gitVerbs = /(^|[;&|]|&&|\|\|)\s*git\s+(-C\s+\S+\s+)?(commit|merge|add|push|pull|fetch|branch|tag|worktree|rebase|cherry-pick|log|status|diff|show|rev-parse|describe|remote)\b/;
  const gitMutators = /\bgit\s+(-C\s+\S+\s+)?(checkout|restore|reset|clean|rm|stash)\b/;
  if (gitVerbs.test(cmd) && !gitMutators.test(cmd)) k.allow();

  // ── Local daemon exemption: curl/wget to the orchestrator are HTTP calls, not writes. ──
  const reLocal = new RegExp(`\\b(curl|wget)\\b.*(localhost|127\\.0\\.0\\.1):${PORT}(/|$)`);
  if (reLocal.test(cmd)) k.allow();

  // ── Write-pattern detection ────────────────────────────────────────────────
  // Mask quoted spans so literal redirect chars inside quotes don't false-positive.
  const cmdRedir = cmd.replace(/'[^']*'/g, 'Q').replace(/"[^"]*"/g, 'Q');
  let writePattern = false;
  if (/(^|[^A-Za-z0-9._@-])(>>?)\s*[^/\s&0-9]/.test(cmdRedir)) writePattern = true;  // redirect to non-fd, non-/path
  if (/(>>?)\s*\/(?!dev\/null)/.test(cmdRedir)) writePattern = true;                 // redirect to absolute path != /dev/null
  if (/\btee\b/.test(cmd)) writePattern = true;
  if (/open\s*\(.*['"]([wWaA]|[wWaA]b)['"]|\.write(_text|_bytes)?\s*\(|\.touch\s*\(/.test(cmd)) writePattern = true;
  if (/\b(cp|mv|rsync|install)\b/.test(cmd)) writePattern = true;
  if (/\bdd\b.*\bof=/.test(cmd)) writePattern = true;
  if (/\bsed\b.*-i/.test(cmd)) writePattern = true;
  if (!writePattern) k.allow();               // no write pattern -> allow

  // ── Collect write targets, then allow only if EVERY extractable target is exempt. ──
  const cmdNoComment = cmd.replace(/[ \t]#.*$/m, '');
  const targets = [];
  for (const m of cmdNoComment.matchAll(/(>>?)\s*(\S+)/g)) { if (m[2]) targets.push(m[2]); }
  if (/\b(cp|mv|rsync|install)\b/.test(cmdNoComment)) {
    const toks = cmdNoComment.split(/\s+/).filter((t) => t && !t.startsWith('-'));
    if (toks.length) targets.push(toks[toks.length - 1]);              // destination = last non-flag token
  }
  const dd = cmdNoComment.match(/\bof=(\S+)/);
  if (dd) targets.push(dd[1]);

  // tee / python writes / sed -i give no cheaply-extractable target -> fall through to claim check.
  if (targets.length && targets.every(isExempt)) k.allow();

  // ── Session claim check (same as orch-gate.js, matched against the write targets) ──
  const sid = input.session_id || '';
  if (!sid) k.allow();
  if (k.isOff(sid)) k.allow();

  const resp = await k.getJson(`/active-claim?session=${encodeURIComponent(sid)}`, 600);
  if (!resp) k.allow();                       // daemon unreachable -> fail open

  if (resp.claimed === true) {
    const claims = Array.isArray(resp.claims) ? resp.claims : [];
    let anyWorktree = false, matched = false, mismatchBranch = '';
    for (const c of claims) {
      const key = c && c.key;
      if (!key) continue;
      const detail = await k.getJson(`/task/detail?key=${encodeURIComponent(key)}`, 600);
      const branch = detail && detail.task && detail.task.git && detail.task.git.branch;
      const wt = detail && detail.task && detail.task.git && detail.task.git.worktree;
      if (branch) {
        anyWorktree = true;
        mismatchBranch = branch;
        if (!targets.length || targets.some((t) => wt && k.isUnder(resolveTarget(t, wt), wt))) { matched = true; break; }
      }
    }
    if (anyWorktree && !matched) {
      k.deny(`orch-gate: task has a registered worktree (${mismatchBranch}) — Bash file writes must happen inside the worktree path, not at ${targets[0] || '(bash)'}. Use the path returned by branch_task.`);
    }
    k.allow();
  }

  const sinfo = await k.getJson(`/session-info?session=${encodeURIComponent(sid)}`, 600);
  if (sinfo && sinfo.is_subagent === true) {
    k.deny('orch-gate: no task claimed. Worker subagents must call branch_task then start_task before editing. To create new tasks use Claude TaskCreate or an adapter file-drop create_task/task_create tool.');
  }

  const t = await k.tryTrivialMainAllow(sid, cmd);
  if (t.ok) {
    await k.reportDispatcherEdit(sid, Buffer.byteLength(cmd, 'utf8'), targets[0] || '(bash)', t.attribution);
    k.allow();
  }
  k.deny(k.mainSessionDenyMessage(t.denyReason));
})().catch(() => process.exit(0));
