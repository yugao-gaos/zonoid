#!/usr/bin/env node
'use strict';
// PreToolUse(Bash) GATE: refuse shell commands that write files unless THIS conversation has a
// Subconscious execution permit backed by an active task claim/worktree. Canonical cross-platform
// policy path — closes the bypass path where
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
  const targets = policy.bashWriteTargets(cmd, input.cwd || (input.tool_input && input.tool_input.cwd) || process.cwd());

  // tee / python writes / sed -i give no cheaply-extractable target -> fall through to claim check.
  if (policy.allTargetsExempt(targets)) k.allow();

  // ── Session claim check (same as orch-gate.js, matched against the write targets) ──
  const sid = input.session_id || '';
  if (!sid) k.allow();
  if (k.isOff(sid)) k.allow();
  const ti = input.tool_input || {};
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
  if (!resp) k.allow();                       // daemon unreachable -> fail open

  if (resp.claimed === true) {
    const claims = Array.isArray(resp.claims) ? resp.claims : [];
    let anyWorktree = false, mismatchBranch = '';
    let permitDenyReason = 'no Subconscious execution permit found for this session/task';
    const scopes = [];
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
      scopes.push({ branch, wt, permit });
    }
    if (scopes.length) {
      // Valid permit, but the write pattern yielded NO extractable target (e.g. an inline
      // python write to a computed/variable path, a write to an already-open handle, or dd
      // of=$VAR). We cannot confirm the write lands inside the worktree, so fail CLOSED rather
      // than trust the permit blindly — otherwise a claimed worker could escape its worktree
      // via `python -c "open(p,'w')"`. The worker can re-issue the write in a verifiable form.
      if (!targets.length) {
        k.deny('orch-gate: this shell command writes a file but the gate could not extract a concrete target path (computed/variable path, a write to an already-open handle, or dd of=$VAR), so it cannot verify the write stays inside your worktree. Use a literal path (e.g. open("./rel","w"), or a redirect/tee to an explicit file), or run the write from a committed script — the orchestrator can verify those.');
      }
      for (const target of targets) {
        if (!target || policy.isPathExempt(target)) continue;
        const matched = scopes.some((scope) =>
          !policy.firstOutsideWorktree([target], scope.wt) &&
          !policy.firstOutsidePermitScope([target], scope.wt, scope.permit)
        );
        if (!matched) {
          const inAnyWorktree = scopes.some((scope) => !policy.firstOutsideWorktree([target], scope.wt));
          const msg = inAnyWorktree
            ? `orch-gate: target is outside the Subconscious execution permit scope (${target}). Ask Subconscious for a permit that covers this path.`
            : `orch-gate: task has a registered worktree (${mismatchBranch}) — shell file writes must happen inside the worktree path, not at ${target}. Use the worktree returned by subconscious_assignment action:"prepare".`;
          k.deny(msg);
        }
      }
      k.allow();
    }
    k.deny(`orch-gate: ${permitDenyReason}. Ask Subconscious for an execution permit before writing.`);
  }

  const sinfo = await k.getJson(`/session-info?session=${encodeURIComponent(sid)}`, 600);
  if (sinfo && sinfo.is_subagent === true) {
    k.deny('orch-gate: no task claimed. Worker subagents must accept a prepared Subconscious assignment before editing with subconscious_assignment action:"accept". Dispatchers should create or repair the assignment with subconscious_assignment action:"prepare".');
  }

  if (policy.hasGitMutatorCommand(cmd)) {
    k.deny('orch-gate: git mutators require an active Subconscious assignment and execution permit. Use subconscious_assignment action:"accept" in the prepared worktree before running this git command.');
  }

  const t = await k.tryTrivialMainAllow(sid, cmd);
  if (t.ok) {
    await k.reportDispatcherEdit(sid, Buffer.byteLength(cmd, 'utf8'), targets[0] || '(bash)', t.attribution);
    k.allow();
  }
  k.deny(k.mainSessionDenyMessage(t.denyReason));
})().catch(() => process.exit(0));
