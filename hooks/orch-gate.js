#!/usr/bin/env node
'use strict';
// PreToolUse(Write|Edit) GATE: enforce task-claim discipline for substantive inline edits.
// Canonical cross-platform policy path; the shell wrapper delegates here.
//
// Subagents: zero-tolerance — require a valid active claim before any non-exempt Write/Edit.
// Main/dispatcher sessions: claim via a worker, or use 1 trivial patch/turn while a worker runs.
// Default-on: a conversation opts out with 'orch off' (sessions/<id>.off). Fail-open if the daemon
// is unreachable — we deny only on a definitive "no claim for this session".
const k = require('./lib/hookkit');
const policy = require('./lib/gate-policy');


(async () => {
  if (k.gateOff()) k.allow();
  const input = await k.readInput();
  const ti = input.tool_input || {};
  const fp = k.slash(ti.file_path || '');
  const targets = policy.writeEditTargets(input);

  // ── Path allow-list ────────────────────────────────────────────────────────
  // Harness plumbing that is NOT substantive work. Orchestrator source is deliberately NOT exempt.
  if (policy.allTargetsExempt(targets)) k.allow();

  const sid = input.session_id || '';
  if (!sid) k.allow();                       // no session id -> can't correlate; don't block
  if (k.isOff(sid)) k.allow();               // orchestrator disabled for this conversation

  const resp = await k.getJson(`/active-claim?session=${encodeURIComponent(sid)}`, 600);
  if (!resp) {                                 // daemon unreachable -> fail open unless local budget is already spent
    if (k.trivialCounterCount(sid) >= 1) k.deny(k.mainSessionDenyMessage('budget'));
    k.allow();
  }

  if (resp.claimed === true) {
    // A session may hold several claims (different worktrees). Allow if ANY claim's worktree is an
    // ancestor of EVERY target path (or the tool has no file path). Targets = the Write/Edit
    // file_path PLUS every path an apply_patch envelope touches — apply_patch may write multiple
    // files in one call, and if ANY lands outside the worktree the confinement check must block.
    const claims = Array.isArray(resp.claims) ? resp.claims : [];
    let anyWorktree = false, matched = false, mismatchBranch = '', offending = '';
    for (const c of claims) {
      const key = c && c.key;
      if (!key) continue;
      const detail = await k.getJson(`/task/detail?key=${encodeURIComponent(key)}`, 600);
      const branch = detail && detail.task && detail.task.git && detail.task.git.branch;
      const wt = detail && detail.task && detail.task.git && detail.task.git.worktree;
      if (branch) {
        anyWorktree = true;
        mismatchBranch = branch;
        // Match this claim only if every target is inside its worktree (empty targets => non-file
        // tool => allow). Require a non-empty wt so an empty worktree can't degrade isUnder to a
        // universal match and silently allow out-of-worktree writes.
        if (targets.length === 0) { matched = true; break; }
        // apply_patch paths are often RELATIVE to the worker's cwd (== the worktree when claimed);
        // resolve a non-absolute target against this worktree before the ancestor test. An absolute
        // out-of-tree path stays absolute (blocked); a `../escape` resolves outside wt (blocked).
        const outside = policy.firstOutsideWorktree(targets, wt);
        if (!outside) { matched = true; break; }
        offending = outside;
      }
    }
    if (anyWorktree && !matched) {
      k.deny(`orch-gate: task has a registered worktree (${mismatchBranch}) — writes must happen inside the worktree path, not at ${offending || fp || '(apply_patch)'}. Use the path returned by branch_task.`);
    }
    k.allow();                                // an in_progress task is claimed -> allow
  }

  // No active claim. Subagent or main/driving session?
  const sinfo = await k.getJson(`/session-info?session=${encodeURIComponent(sid)}`, 600);
  const isSub = sinfo && sinfo.is_subagent;
  if (isSub === true) {
    k.deny('orch-gate: no task claimed. Worker subagents must call branch_task then start_task before editing. To create new tasks use Claude TaskCreate or an adapter file-drop create_task/task_create tool.');
  }

  // Main/driving session (or unknown): try 1 trivial patch/turn if workers are in flight.
  const patch = ti.new_string != null ? ti.new_string : (ti.content != null ? ti.content : '');
  const t = await k.tryTrivialMainAllow(sid, patch);
  if (t.ok) {
    await k.reportDispatcherEdit(sid, Buffer.byteLength(patch, 'utf8'), fp, t.attribution);
    k.allow();
  }
  k.deny(k.mainSessionDenyMessage(t.denyReason));
})().catch(() => process.exit(0));   // never brick edits on an unexpected hook error -> fail open
