#!/usr/bin/env node
'use strict';
// PreToolUse(Bash) GATE: refuse shell commands that write files unless THIS conversation has a task
// claimed in_progress. Canonical cross-platform policy path — closes the bypass path where
// a shell command (redirect, tee, cp, PowerShell writes, python -c "open(...,'w')", sed -i, dd)
// writes outside a claim.
// Exit 2 = deny; exit 0 = allow. Fail-open if the daemon is unreachable.
const k = require('./lib/hookkit');
const policy = require('./lib/gate-policy');

const PORT = k.PORT;


(async () => {
  if (k.gateOff()) k.allow();
  const input = await k.readInput();
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!cmd) k.allow();                        // no command -> nothing to check

  // ── Git VCS exemption: plumbing operates on already-claimed, already-edited work. ──
  if (policy.isGitCommandExempt(cmd)) k.allow();

  // ── Local daemon exemption: curl/wget to the orchestrator are HTTP calls, not writes. ──
  if (policy.isLocalDaemonCommand(cmd, PORT)) k.allow();

  // ── Write-pattern detection ────────────────────────────────────────────────
  if (!policy.hasBashWritePattern(cmd)) k.allow();               // no write pattern -> allow

  // ── Collect write targets, then allow only if EVERY extractable target is exempt. ──
  const targets = policy.bashWriteTargets(cmd);

  // tee / python writes / sed -i give no cheaply-extractable target -> fall through to claim check.
  if (policy.allTargetsExempt(targets)) k.allow();

  // ── Session claim check (same as orch-gate.js, matched against the write targets) ──
  const sid = input.session_id || '';
  if (!sid) k.allow();
  if (k.isOff(sid)) k.allow();

  const resp = await k.getJson(`/active-claim?session=${encodeURIComponent(sid)}`, 600);
  if (!resp) k.allow();                       // daemon unreachable -> fail open

  if (resp.claimed === true) {
    const claims = Array.isArray(resp.claims) ? resp.claims : [];
    let anyWorktree = false, mismatchBranch = '';
    const worktrees = [];
    for (const c of claims) {
      const key = c && c.key;
      if (!key) continue;
      const detail = await k.getJson(`/task/detail?key=${encodeURIComponent(key)}`, 600);
      const branch = detail && detail.task && detail.task.git && detail.task.git.branch;
      const wt = detail && detail.task && detail.task.git && detail.task.git.worktree;
      if (branch) {
        anyWorktree = true;
        mismatchBranch = branch;
        if (wt) worktrees.push(wt);
      }
    }
    if (anyWorktree && targets.length) {
      const outside = policy.firstOutsideAnyWorktree(targets, worktrees);
      if (outside) {
        k.deny(`orch-gate: task has a registered worktree (${mismatchBranch}) — shell file writes must happen inside the worktree path, not at ${outside}. Use the path returned by branch_task.`);
      }
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
