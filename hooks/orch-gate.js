#!/usr/bin/env node
'use strict';
// PreToolUse(Write|Edit) GATE: enforce task-claim discipline for substantive inline edits.
// Canonical cross-platform policy path; the shell wrapper delegates here.
//
// Subagents: zero-tolerance — require a valid Subconscious execution permit backed by an active
// claim/worktree before any non-exempt Write/Edit.
// Main/dispatcher sessions: request a permit via Subconscious, or use 1 trivial patch/turn while a worker runs.
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
  const agentId = input.agent_id || ti.agent_id || '';
  const foregroundAgentId = input.foreground_agent_id || ti.foreground_agent_id || '';

  async function permitForClaim(key, workspace) {
    const params = new URLSearchParams({ session_id: sid, task_key: key });
    if (workspace) params.set('workspace', workspace);
    if (agentId) params.set('agent_id', agentId);
    if (foregroundAgentId) params.set('foreground_agent_id', foregroundAgentId);
    const permitResp = await k.getJson(`/subconscious/permit?${params.toString()}`, 600);
    return permitResp && (permitResp.execution_permit || permitResp.permit);
  }

  const resp = await k.getJson(`/active-claim?session=${encodeURIComponent(sid)}`, 600);
  if (!resp) {                                 // daemon unreachable -> fail open unless local budget is already spent
    if (k.trivialCounterCount(sid) >= 1) k.deny(k.mainSessionDenyMessage('budget'));
    k.allow();
  }

  if (resp.claimed === true) {
    // A session may hold several claims (different worktrees). Allow if ANY claim has a valid
    // Subconscious execution permit and that same claim's worktree is an ancestor of EVERY target
    // path. Targets = the Write/Edit file_path PLUS every path an apply_patch envelope touches.
    const claims = Array.isArray(resp.claims) ? resp.claims : [];
    let anyWorktree = false, matched = false, mismatchBranch = '', offending = '';
    let permitDenyReason = 'no Subconscious execution permit found for this session/task';
    for (const c of claims) {
      const key = c && c.key;
      if (!key) continue;
      const detailParams = new URLSearchParams({ key });
      if (c.workspace) detailParams.set('workspace', c.workspace);
      const detail = await k.getJson(`/task/detail?${detailParams.toString()}`, 600);
      const branch = detail && detail.task && detail.task.git && detail.task.git.branch;
      const wt = detail && detail.task && detail.task.git && detail.task.git.worktree;
      if (!branch || !wt) {
        permitDenyReason = 'claimed assignment is missing a registered worktree; ask Subconscious to re-prepare it with subconscious_assignment action:"prepare" before requesting a permit';
        continue;
      }
      anyWorktree = true;
      mismatchBranch = branch;
      const outside = targets.length ? policy.firstOutsideWorktree(targets, wt) : '';
      if (outside) {
        offending = outside;
        continue;
      }
      const permit = await permitForClaim(key, c.workspace);
      const permitValidation = policy.validateExecutionPermit(permit, {
        sessionId: sid,
        taskKey: key,
        branch,
        worktree: wt,
        agentId,
        foregroundAgentId,
      });
      if (!permitValidation.ok) {
        permitDenyReason = permitValidation.reason;
        continue;
      }
      const outsidePermit = targets.length ? policy.firstOutsidePermitScope(targets, wt, permit) : '';
      if (outsidePermit) {
        offending = outsidePermit;
        permitDenyReason = 'target is outside the Subconscious execution permit scope';
        continue;
      }
      matched = true;
      break;
    }
    if (matched) k.allow();
    if (anyWorktree && offending && permitDenyReason !== 'target is outside the Subconscious execution permit scope') {
      k.deny(`orch-gate: task has a registered worktree (${mismatchBranch}) — writes must happen inside the worktree path, not at ${offending || fp || '(apply_patch)'}. Use the worktree returned by subconscious_assignment action:"prepare".`);
    }
    k.deny(`orch-gate: ${permitDenyReason}${offending ? ` (${offending})` : ''}. Ask Subconscious for an execution permit before writing.`);
  }

  // No active claim. Subagent or main/driving session?
  const sinfo = await k.getJson(`/session-info?session=${encodeURIComponent(sid)}`, 600);
  const isSub = sinfo && sinfo.is_subagent;
  if (isSub === true) {
    k.deny('orch-gate: no task claimed. Worker subagents must accept a prepared Subconscious assignment before editing with subconscious_assignment action:"accept". Dispatchers should create or repair the assignment with subconscious_assignment action:"prepare".');
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
