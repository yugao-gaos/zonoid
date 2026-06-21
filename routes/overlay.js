'use strict';
const overlayStore = require('../lib/overlay');
const filedropGc = require('../lib/filedrop-gc');
const judge = require('../lib/judge');
const graphStore = require('../lib/graph-store');
const path = require('path');
const { noteEmbedText, noteFieldTexts, taskEmbedText } = require('../lib/node-tags');
const newlyReady = require('../lib/newly-ready');
const { requeueStandingHarness } = require('../lib/harness-task');
const recallJournal = require('../lib/recall-outcome-journal');
const gitClaims = require('../lib/git-claims');
const noteSourceCluster = require('../lib/note-source-cluster');
const { defaultSubconsciousStore } = require('../lib/subconscious');

// Resolve a note's knowledge[] for field-level embedding. addNoteNode stores it inline on the node
// (n.knowledge), but the /overlay/note route also mirrors it into overlay.knowledge[id]; prefer the
// inline copy and fall back to the side table so backfill/reembed work for both shapes.
function noteKnowledge(overlay, n) {
  if (n && Array.isArray(n.knowledge) && n.knowledge.length) return n.knowledge;
  const side = overlay && overlay.knowledge && n ? overlay.knowledge[n.id] : null;
  return Array.isArray(side) ? side : [];
}

function isAdmissibleOverlayTaskKey(key) {
  return typeof key === 'string'
    && (/^[^/\s]+\/[^/\s]+$/.test(key) || /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key));
}

function normalizePermitPath(value, base) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw) return '';
  const absolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw);
  const resolved = absolute ? raw : `${String(base || '').replace(/\\/g, '/').replace(/\/+$/, '')}/${raw}`;
  return path.posix.normalize(resolved).replace(/\/+$/, '');
}

function permitCoversClaim(permit, claim) {
  if (!permit || permit.status !== 'active') return false;
  if (permit.session_id !== claim.sessionId) return false;
  if (permit.task_key !== claim.taskKey) return false;
  if (permit.branch !== claim.branch) return false;
  if (claim.agentId && permit.agent_id && permit.agent_id !== claim.agentId) return false;
  return normalizePermitPath(permit.worktree, claim.worktree) === normalizePermitPath(claim.worktree);
}

function ensureExecutionPermitForClaim(store, claim) {
  if (!store || !claim.sessionId || !claim.taskKey || !claim.worktree || !claim.branch) return null;
  if (typeof store.executionPermit !== 'function') return null;
  const read = typeof store.readExecutionPermit === 'function'
    ? store.readExecutionPermit({
      workspace: claim.workspace,
      session_id: claim.sessionId,
      agent_id: claim.agentId,
      task_key: claim.taskKey,
    })
    : null;
  if (read && permitCoversClaim(read.execution_permit, claim)) return read.execution_permit;
  const issued = store.executionPermit({
    action: 'issue',
    workspace: claim.workspace,
    session_id: claim.sessionId,
    agent_id: claim.agentId,
    task_key: claim.taskKey,
    worktree: claim.worktree,
    branch: claim.branch,
    scope: 'worktree',
    reason: 'auto-issued after accepted worker claim',
  });
  return issued && issued.ok ? issued.execution_permit : null;
}

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, sendOp, readBody, notifyChange, buildGraph, targetOverlay, nodeExistsInGraph,
    embed, knowledgeText, snapshotNative, now, suggestToks, scoreNodeAgainstTokens,
    SUGGEST_DUP_THRESHOLD, DIMS, seedBlockingDepContext } = ctx;
  const graphHasKey = (ws, key) => {
    if (typeof nodeExistsInGraph !== 'function') return true;
    return nodeExistsInGraph(buildGraph(ws), key);
  };
  const acceptsTaskKey = (T, key) => graphHasKey(T.ws, key)
    || !!(T.ov.knowledge_nodes && T.ov.knowledge_nodes[key])
    || isAdmissibleOverlayTaskKey(key);
  const ensureTaskSnapshot = (T, key) => {
    if (!isAdmissibleOverlayTaskKey(key)) return;
    if (T.ov.snapshots && T.ov.snapshots[key]) return;
    overlayStore.setSnapshot(T.ov, key, {
      subject: key,
      description: '',
      status: T.ov.status[key] || 'pending',
      blockedBy: [],
      owner: null,
      metadata: { synthetic_overlay_task: true },
    });
    if (ctx.cache) {
      if (ctx.cache.agg) ctx.cache.agg.delete(T.ws);
      if (ctx.cache.aggAt) ctx.cache.aggAt.delete(T.ws);
    }
    // PHASE 4 (unification): auto-wire this newly-created task to entities whose name appears
    // as a substring in the task label (case-insensitive). Best-effort: any error is swallowed
    // so task creation is NEVER blocked. Only fires on creation (snapshot didn't exist above).
    // Relation 'touches' indicates the task acts on this entity's subsystem.
    try {
      if (T.ov.entity_nodes) {
        const labelLower = key.toLowerCase();
        for (const entity of Object.values(T.ov.entity_nodes)) {
          if (!entity.validTo && entity.name && labelLower.includes(entity.name.toLowerCase())) {
            try { overlayStore.addEntityEdge(T.ov, key, 'entity:' + entity.id, 'touches'); } catch { /* best-effort */ }
          }
        }
      }
    } catch { /* best-effort — never abort task creation */ }
  };

  if (p === '/overlay/edge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.from || !b.to) { send(res, 400, { ok: false, error: 'from and to required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    // Reject unknown task keys: both endpoints must resolve to existing nodes.
    // Cross-workspace ghost edges carry fromWorkspace on `from` — skip the local-graph check for `from`
    // in that case (the foreign node lives in a different workspace and cannot be validated here).
    if (!b.fromWorkspace && !acceptsTaskKey(T, b.from)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.from}` }); return true;
    }
    if (!acceptsTaskKey(T, b.to)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.to}` }); return true;
    }
    if (!b.fromWorkspace) ensureTaskSnapshot(T, b.from);
    ensureTaskSnapshot(T, b.to);
    // add_dependency / wires_to / suggest_links all land here — these are hand-ASSERTED edges (no
    // autowire origin), so default origin:'asserted'. This is the population keepRateByBand must EXCLUDE
    // when tuning the autowire-lexical threshold (asserted note->task edges contaminated the sub-0.40 band).
    overlayStore.addEdge(T.ov, b.from, b.to, b.fromWorkspace, b.kind, b.weight, { origin: 'asserted' });
    // When a blocking edge is created, auto-seed a low-weight context edge so the prerequisite's
    // knowledge flows as retrieval context to the blocked task (gate-transparent). Best-effort.
    // Absent kind defaults to 'blocking' (back-compat) — fire for both absent and explicit blocking.
    if (b.kind !== 'context' && b.kind !== 'supersede' && seedBlockingDepContext) {
      try { seedBlockingDepContext(T.ov, T.ws, b.to); } catch { /* best-effort — never abort the edge write */ }
    }
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, edges: T.ov.edges.length, ghost: !!b.fromWorkspace, kind: b.kind === 'context' ? 'context' : 'blocking' }); return true;
  }

  if (p === '/overlay/edge/remove' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.from || !b.to) { send(res, 400, { ok: false, error: 'from and to required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    // Reject unknown task keys — same cross-workspace carve-out as /overlay/edge.
    if (!b.fromWorkspace && !acceptsTaskKey(T, b.from)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.from}` }); return true;
    }
    if (!acceptsTaskKey(T, b.to)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.to}` }); return true;
    }
    const before = T.ov.edges.length;
    overlayStore.removeEdge(T.ov, b.from, b.to, b.fromWorkspace, b.kind);
    const removed = before - T.ov.edges.length;
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, removed, edges: T.ov.edges.length }); return true;
  }

  if (p === '/overlay/status' && m === 'POST') {
    const { ALL_STATUSES, followups, verdicts, agentsArr, saveAgents, git } = ctx;
    const b = await readBody(req);
    if (ctx.opReplay(res, b)) return true;
    const T = targetOverlay(b, u);
    if (!ALL_STATUSES.includes(b.status)) { send(res, 400, { ok: false, error: 'invalid status', allowed: ALL_STATUSES }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    // Reject unknown task key — prevents phantom node creation (symmetry with READ ops).
    if (b.key) {
      if (!acceptsTaskKey(T, b.key)) {
        send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
      }
      ensureTaskSnapshot(T, b.key);
    }
    if (b.follow_ups != null) {
      if (b.status !== 'done') { send(res, 400, { ok: false, error: 'follow_ups only allowed with status "done"' }); return true; }
      const fErr = followups.validate(b.follow_ups);
      if (fErr) { send(res, 400, { ok: false, error: fErr }); return true; }
    }
    if (b.verdicts != null) {
      if (b.status !== 'done') { send(res, 400, { ok: false, error: 'verdicts only allowed with status "done"' }); return true; }
      const vErr = verdicts.validate(b.verdicts);
      if (vErr) { send(res, 400, { ok: false, error: vErr }); return true; }
    }
    if (b.status === 'done' && T.ov.config.require_review && T.ov.status[b.key] !== 'tested') {
      send(res, 409, { ok: false, error: 'review required: task must be "tested" before "done" (require_review policy is on)' }); return true;
    }
    const cur = T.ov.status[b.key];
    if (b.expected_status !== undefined && (cur || null) !== (b.expected_status || null)) {
      send(res, 409, { ok: false, error: 'stale write: status changed under you', current: cur || null, expected: b.expected_status || null }); return true;
    }
    if (cur === 'canceled' && b.status !== 'canceled' && !b.force && !b.reopen) {
      send(res, 409, { ok: false, error: 'task is canceled (terminal): pass force/reopen to override', current: cur, attempted: b.status }); return true;
    }
    const resolveClaimSid = (allowDaemonFallback) => {
      let sid = b.session_id ? String(b.session_id) : null;
      if (!sid && b.agent_id && ctx.state.agents[b.agent_id]) {
        const ag = ctx.state.agents[b.agent_id];
        if (ag.subagent_session && ag.subagent_session !== ag.session) sid = ag.subagent_session;
        else if (ag.session) sid = ag.session;
      }
      if (!sid && allowDaemonFallback && process.env.CLAUDE_CODE_SESSION_ID) sid = String(process.env.CLAUDE_CODE_SESSION_ID);
      return sid;
    };
    let claimSid = null;
    if (b.status === 'in_progress') {
      claimSid = resolveClaimSid(true);
      // DAEMON-SIDE harness-session fallback: when a worker claims without a resolvable session, use
      // the daemon's own CLAUDE_CODE_SESSION_ID (inherited via daemonEnv from the MCP server). Under
      // the claude-desktop entrypoint that equals the worker's harness .session_id — the value the
      // PreToolUse gate queries /active-claim with — so the claim becomes gate-visible and background-
      // worker writes are no longer wrongly denied (note-mqftffo7f2b). Mirrors the mcp-graph SESSION
      // fix but activates on a DAEMON restart, not an MCP-server reload. A worker that DOES pass a
      // real session_id is unaffected. (Relies on workers sharing the harness session id, probe-verified.)
      if (!claimSid) {
        send(res, 400, { ok: false, error: 'session_id required on in_progress claim when not inferable from agent registry' }); return true;
      }
      const isSubagent = agentsArr().some((a) =>
        a.state === 'running' && (
          // Standard subagent: distinct session from its dispatcher
          (a.subagent_session && a.subagent_session === claimSid && a.subagent_session !== a.session) ||
          // Agent-tool spawn: registered via SubagentStart hook with agent_tool_spawn:true.
          // Hook runs in dispatcher context so a.session is the dispatcher's session, NOT the
          // subagent's — match on agent_id only (unique per spawn).
          (a.agent_tool_spawn && a.agent_id === b.agent_id)
        )
      );
      const hasWorktree = !!(T.ov.git && T.ov.git[b.key] && T.ov.git[b.key].worktree);
      if (!isSubagent) {
        // Self-register-on-claim fallback: the SubagentStart hook does NOT fire for run_in_background
        // Agent-tool spawns (note-mqed9vz7vr9), so they never carry agent_tool_spawn:true and isSubagent
        // is false for them. The proof of delegation we CAN rely on is that branch_task was already
        // called for this task_key (a worktree is registered) — the dispatcher never calls branch_task.
        // So a claim bearing an agent_id AND backed by a registered worktree is a legitimate hook-less
        // worker: register it (one normalized field) and allow. A claim with NO worktree is still
        // refused — the worktree stays the security boundary that keeps the dispatcher from claiming.
        if (b.agent_id && hasWorktree) {
          ctx.touchAgent(b.agent_id, { state: 'running', agent_tool_spawn: true, session: claimSid, task_key: b.key, agent_type: b.agent_type });
        } else {
          send(res, 409, { ok: false, error: 'dispatcher sessions cannot claim tasks — if you are a delegated worker, call branch_task(task_key) then start_task' }); return true;
        }
      }
      // Worktree required: subagents must call branch_task before start_task so concurrent
      // agents cannot write to the same branch and overwrite each other's work.
      if (!hasWorktree) {
        send(res, 409, { ok: false, error: 'call branch_task(task_key) before start_task — subagents must work in an isolated worktree' }); return true;
      }
    } else if (newlyReady.isTerminalStatus(b.status)) {
      claimSid = resolveClaimSid(false) || (T.ov.claimSessions && T.ov.claimSessions[b.key]) || null;
    }
    if (b.status === 'in_progress' && b.force) {
      // Force-claim cap: max 3 per task key. Counter persisted in overlay so daemon restarts don't reset it.
      const FORCE_CAP = 3;
      if (!T.ov.forceClaims) T.ov.forceClaims = {};
      const fcCount = T.ov.forceClaims[b.key] || 0;
      if (fcCount >= FORCE_CAP) {
        // Check for existing pending guidance item for this (session, task) — don't file duplicates.
        const already = Array.isArray(T.ov.guidance) && T.ov.guidance.some(
          (g) => !g.resolved && g.trigger === 'force_claim_cap' && g.action && g.action.taskKey === b.key
        );
        if (!already) {
          overlayStore.addGuidance(T.ov, {
            question: `Force-claim cap reached on task ${b.key} — agent "${b.agent_id || '(unknown)'}" has exhausted 3 force-claims. Approve on dashboard to reset.`,
            context: `task_key: ${b.key}\nagent_id: ${b.agent_id || '(unknown)'}`,
            trigger: 'force_claim_cap',
            severity: 'blocking',
            action: { kind: 'force_claim_cap', taskKey: b.key },
          });
          T.save(); ctx.notifyChange(T.ws);
        }
        const dashUrl = `http://${(req.headers && req.headers.host) || '127.0.0.1:8787'}/graph`;
        send(res, 409, { ok: false, error: `force-claim cap reached — tell the user to approve the reset on the dashboard at ${dashUrl} (guidance gate), then retry`, approval_required: true, dashboard: dashUrl }); return true;
      }
      T.ov.forceClaims[b.key] = fcCount + 1;
    }
    if (b.status === 'in_progress' && b.agent_id && cur === 'in_progress' && !b.force) {
      const owner = T.ov.assignee[b.key];
      if (owner && owner !== b.agent_id) {
        send(res, 409, { ok: false, error: 'task is already in_progress by another agent: pass force to take over', current: cur, owner, attempted_by: b.agent_id }); return true;
      }
    }
    if (b.status === 'in_progress' && T.ov.unwired && T.ov.unwired[b.key]) {
      send(res, 409, { ok: false, error: 'task is unwired — if you are a worker agent, call request_guidance to escalate to your dispatcher (do NOT mark_root just to unblock yourself); if you created this task, wire it with add_dependency (blocking/context), or mark_root only if it is genuinely a standalone root' }); return true;
    }
    // JUDGING→READY gate (task D) — ADDITIVE: refuse a claim while the task is still in the 'judging'
    // phase (outstanding unjudged autowire candidate edges within the timeout). Its inherited context
    // is provisional until the judge keeps/prunes those edges (eager path C is the happy case). NOT a
    // deadlock: once the edges sit unjudged past judgingTimeoutMs the task falls back to ready and this
    // arm no longer fires (timedOut → not judging), so a judge hiccup can never permanently block it.
    if (b.status === 'in_progress' && !b.force) {
      const _js = judge.judgingState(T.ov, b.key, Date.now(), judge.judgingTimeoutMs(T.ov), judge.judgingHardCeilingMs(T.ov));
      if (_js.judging && !_js.timedOut) {
        send(res, 409, { ok: false, error: 'task wirings not yet judged — this task is in the judging phase (unjudged autowire context edges); its inherited context is provisional. Wait for the eager judge to keep/prune them (it dispatches automatically), or it falls back to claimable after the judging timeout.' }); return true;
      }
    }
    if (b.status === 'in_progress' && T.ov.metrics && T.ov.metrics[b.key]) {
      const gitInfo = T.ov.git && T.ov.git[b.key];
      const wt = gitInfo && gitInfo.worktree;
      const branch = wt ? git.currentBranch(wt) : null;
      if (!wt || !branch || branch !== gitInfo.branch || !branch.startsWith('orch/attempt/')) {
        send(res, 409, { ok: false, error: 'self-learning mode: task has a metric spec — call branch_task first before editing' }); return true;
      }
    }
    const gitClaimMode = gitClaims.claimMode(T.ov);
    let gitClaim = null;
    let gitClaimFinalize = null;
    let executionPermit = null;
    if (b.status === 'in_progress' && !b.force && gitClaimMode.enabled) {
      const repo = ctx.resolveRepo ? ctx.resolveRepo(b.key, b.repo_path, T.ov, T.ws) : T.ws;
      if (!gitClaims.shouldAcquire(repo, T.ov)) {
        gitClaim = null;
      } else {
        const gitInfo = T.ov.git && T.ov.git[b.key];
        try {
          gitClaim = gitClaims.acquire(repo, b.key, {
            agentId: b.agent_id || null,
            sessionId: claimSid,
            branch: gitInfo && gitInfo.branch,
            leaseMinutes: gitClaims.claimLeaseMinutes(T.ov),
          });
        } catch (e) {
          gitClaim = { ok: false, error: 'git claim acquire failed', detail: String(e.stderr || e.message || e).slice(0, 500) };
        }
        if (!gitClaim.ok && gitClaimMode.strict) {
          send(res, gitClaim.conflict ? 409 : 503, { ok: false, error: gitClaim.error, git_claim: gitClaim }); return true;
        }
      }
    }
    // HANDOFF VALIDATION (T2): refuse a terminal completion whose STRUCTURED task_result is
    // incomplete. Mirrors the metric-branch invariant 409 above — daemon-side refusal on the call
    // the daemon already mediates, no new mechanism, no hook. GATED two ways so the legacy
    // free-string complete_task path is never hard-broken:
    //   (1) opt-in: only enforce when the caller actually sends a structured `task_result` object;
    //       legacy callers send only a free-string `summary` and pass through untouched.
    //   (2) scoped: the one invariant is metric-result completeness — a task that carries a metric
    //       spec (T.ov.metrics[key], the has_metric_spec discriminator) MUST report
    //       task_result.metric_measurements. Tasks with no metric spec have nothing to measure and
    //       are not refused.
    if (newlyReady.isTerminalStatus(b.status) && b.task_result && typeof b.task_result === 'object') {
      if (T.ov.metrics && T.ov.metrics[b.key]) {
        const mm = b.task_result.metric_measurements;
        const hasMeasurements = mm != null && (Array.isArray(mm) ? mm.length > 0 : Object.keys(mm).length > 0);
        if (!hasMeasurements) {
          send(res, 409, { ok: false, error: 'incomplete task_result: task carries a metric spec — terminal status requires task_result.metric_measurements (run measure_task and report the value)', key: b.key, missing: 'metric_measurements' }); return true;
        }
      }
    }
    if (newlyReady.isTerminalStatus(b.status) && gitClaimMode.enabled) {
      const repo = ctx.resolveRepo ? ctx.resolveRepo(b.key, b.repo_path, T.ov, T.ws) : T.ws;
      if (gitClaims.shouldAcquire(repo, T.ov)) {
        try {
          gitClaimFinalize = gitClaims.finalize(repo, b.key, {
            agentId: b.agent_id || null,
            sessionId: claimSid,
            status: b.status,
            strict: gitClaimMode.strict,
          });
        } catch (e) {
          gitClaimFinalize = { ok: false, error: 'git claim release failed', detail: String(e.stderr || e.message || e).slice(0, 500) };
        }
        if (!gitClaimFinalize.ok && gitClaimMode.strict) {
          send(res, gitClaimFinalize.conflict ? 409 : 503, { ok: false, error: gitClaimFinalize.error, git_claim: gitClaimFinalize }); return true;
        }
      }
    }
    const readyBefore = newlyReady.isTerminalStatus(b.status)
      ? newlyReady.readyKeys(buildGraph(T.ws))
      : null;
    if (b.status === 'canceled') { T.ov.cancel_requested[b.key] = now(); overlayStore.markForRejudge(T.ov, b.key); }
    else if ((b.force || b.reopen) && cur === 'canceled') delete T.ov.cancel_requested[b.key];
    overlayStore.setStatus(T.ov, b.key, b.status, b.note);
    overlayStore.clearSpawnLease(T.ov, b.key);   // release the spawn-dispatch lease on claim/terminal (task /3)
    if (b.max_retries != null) {
      if (!T.ov.retryConfig) T.ov.retryConfig = {};
      if (!T.ov.retryConfig[b.key]) T.ov.retryConfig[b.key] = {};
      T.ov.retryConfig[b.key].maxRetries = Number(b.max_retries);
    }
    { const ts = T.ov.timestamps[b.key] = T.ov.timestamps[b.key] || {}; const n = now(); if (!ts.firstSeen) ts.firstSeen = n; if (ts.lastStatus !== b.status || b.status === 'in_progress') { ts.lastChanged = n; ts.lastStatus = b.status; } }
    if (b.agent_id) {
      T.ov.assignee[b.key] = b.agent_id;
      ctx.touchAgent(b.agent_id, { status: b.status, task_key: b.key, workspace: T.ws, reported_usage: b.reported_usage });
    }
    if (b.status === 'in_progress') {
      try {
        const gitUser = require('child_process').execFileSync(
          'git', ['-C', T.ws, 'config', 'user.name'],
          { encoding: 'utf8', timeout: 2000, windowsHide: true }
        ).trim() || null;
        if (gitUser) {
          if (!T.ov.git_users) T.ov.git_users = {};
          T.ov.git_users[b.key] = gitUser;
        }
      } catch { /* no git config or not a git repo — skip silently */ }
      if (!T.ov.work_sessions) T.ov.work_sessions = {};
      if (!T.ov.work_sessions[b.key]) T.ov.work_sessions[b.key] = [];
      T.ov.work_sessions[b.key].push({
        agent_id: b.agent_id || null,
        git_user: (T.ov.git_users && T.ov.git_users[b.key]) || null,
        start_ts: now(),
        end_ts: null,
      });
      if (claimSid) {
        if (!T.ov.claimSessions) T.ov.claimSessions = {};
        T.ov.claimSessions[b.key] = claimSid;
      }
      if (gitClaim) {
        if (!T.ov.git_claims) T.ov.git_claims = {};
        const claim = gitClaim.claim || {};
        T.ov.git_claims[b.key] = {
          mode: gitClaimMode.mode,
          advisory: !gitClaimMode.strict,
          ok: !!gitClaim.ok,
          conflict: !!gitClaim.conflict,
          error: gitClaim.error || null,
          agent_id: b.agent_id || null,
          git_user: claim.git_user || null,
          session_id: claim.session_id || claimSid || null,
          branch: claim.branch || null,
          claimed_at: claim.claimed_at || null,
          lease_until: claim.lease_until || null,
        };
      }
      const gitInfo = T.ov.git && T.ov.git[b.key];
      executionPermit = ensureExecutionPermitForClaim(ctx.subconscious || defaultSubconsciousStore, {
        workspace: T.ws,
        sessionId: claimSid,
        agentId: b.agent_id || null,
        taskKey: b.key,
        worktree: gitInfo && gitInfo.worktree,
        branch: gitInfo && gitInfo.branch,
      });
    } else {
      const sessions = T.ov.work_sessions && T.ov.work_sessions[b.key];
      if (sessions) {
        const open = [...sessions].reverse().find(s => !s.end_ts);
        if (open) open.end_ts = now();
      }
      if (['done', 'tested', 'failed', 'canceled'].includes(b.status) && T.ov.claimSessions) {
        delete T.ov.claimSessions[b.key];
      }
      if (['done', 'tested', 'failed', 'canceled'].includes(b.status) && T.ov.git_claims) {
        delete T.ov.git_claims[b.key];
      }
    }
    if (b.summary != null) T.ov.summaries[b.key] = String(b.summary).slice(0, 2000);
    // TASK embedding (multi-vec schema): (re)embed title+summary whenever a summary is set so the
    // task carries a dense vector for retrieval/suggest_links — mirrors the note embed path. Title
    // resolved from the adoption snapshot (subject), falling back to the native task. Category/tags
    // are deliberately OUT of the embedded string (separate signals, fused in later steps). embed()
    // is null-safe (sidecar loading/disabled ⇒ no vec ⇒ lexical fallback, exactly like notes).
    // Embed when the summary changed (interface text updated) OR when the task has no vector yet
    // (first write — e.g. the in_progress claim — gives a title-only vec so every task is covered).
    const _hasVec = T.ov.taskVecs && Array.isArray(T.ov.taskVecs[b.key]) && T.ov.taskVecs[b.key].length;
    if (b.key && (b.summary != null || !_hasVec)) {
      try {
        const snap = T.ov.snapshots && T.ov.snapshots[b.key];
        let title = snap && snap.subject;
        if (!title) { const nt = ctx.readNativeTask(T.ws, String(b.key)); title = nt && (nt.subject || nt.activeForm); }
        if (!_hasVec) {
          // FIRST vec (task born on THIS lane — e.g. the in_progress claim): pass through the shared
          // ingestNode funnel so embed → setTaskVec → autowire (seed weight-0 candidate edges to
          // relevant NOTES+TASKS for the neighborhood-aware judge) → markEagerJudge all fire in lockstep
          // with the birth-time native lane. Identical result, one funnel. Best-effort, null-safe.
          await ctx.ingestNode(T.ov, buildGraph(T.ws), b.key, { title, summary: T.ov.summaries[b.key] });
          // PHASE 4 (unification): auto-wire this task to entities whose name appears as a
          // substring in the resolved task label. Best-effort — never blocks the status write.
          // Fires only at task birth (first vec, no existing snapshot vec) so it does not repeat
          // on every status update. Relation 'touches' marks entity/execution boundary wiring.
          if (title && T.ov.entity_nodes) {
            const titleLower = title.toLowerCase();
            for (const entity of Object.values(T.ov.entity_nodes)) {
              if (!entity.validTo && entity.name && titleLower.includes(entity.name.toLowerCase())) {
                try { overlayStore.addEntityEdge(T.ov, b.key, 'entity:' + entity.id, 'touches'); } catch { /* best-effort */ }
              }
            }
          }
        } else if (b.summary != null) {
          // Already ingested, but the interface text (summary) changed ⇒ re-embed ONLY so retrieval
          // tracks the new text. No re-autowire / no re-mark — candidate seeding is a one-shot at birth
          // (the prior !_hasVec gate enforced exactly this), the judge owns edge evolution thereafter.
          const tvec = await embed(taskEmbedText({ title, summary: T.ov.summaries[b.key] }));
          if (tvec) overlayStore.setTaskVec(T.ov, b.key, tvec);
        }
      } catch { /* best effort — never block the status write on embedding/recall */ }
    }
    const NATIVE_STATUS = { in_progress: 'in_progress', done: 'completed', tested: 'completed' };
    const ns = NATIVE_STATUS[b.status];
    if (['done', 'tested', 'failed', 'canceled'].includes(b.status)) snapshotNative(T.ov, b.key, ns, T.ws);
    // RECALL-OUTCOME attribution: when a task reaches a terminal status, append a resolved row
    // joining the task_key to its outcome. Readers take the latest row per task_key — this
    // supersedes any prior 'pending' row written at context-assembly time (/search?task_key=).
    // Best-effort: never block the status write on journal IO.
    if (['done', 'tested', 'failed', 'canceled'].includes(b.status) && b.key) {
      try {
        const outcome = recallJournal.STATUS_TO_OUTCOME[b.status] || b.status;
        // Recover recalled note keys from the latest pending row for this task, if any.
        const latestPending = recallJournal.latestByTask(T.ws).get(b.key);
        const recalled = latestPending ? (latestPending.recalled_note_keys || []) : [];
        const via = latestPending ? (latestPending.via || 'rag') : 'rag';
        recallJournal.appendRow(T.ws, { task_key: b.key, recalled_note_keys: recalled, outcome, via });
      } catch { /* attribution logging must never block the status write */ }
    }
    let followUpResults = null;
    let bucketCleanup = null;
    if (b.status === 'done' && Array.isArray(b.follow_ups) && b.follow_ups.length) {
      followUpResults = followups.apply(T.ov, b.key, b.follow_ups);
      // INGEST-AT-BIRTH (BUILD3): follow-up nodes are born here on the snapshot substrate (apply set
      // the snapshot + parent->child context edge) but, like the native/file-drop lanes pre-BUILD1,
      // they carried no vec / no candidate edges / no eager mark — so a ready follow-up reached
      // dispatch with judging:false and the D-gate was a no-op. Route each minted node through the
      // shared ingestNode funnel (embed title+prompt → setTaskVec → autowireNewTaskWholeGraph →
      // markEagerJudge) so it carries a vec + weight-0 candidate edges + an eager mark BEFORE it can
      // reach `ready`/dispatch — identical to the native lane, one funnel. Best-effort, null-safe;
      // the recall graph is rebuilt per node so each sees prior siblings ingested this batch. Status
      // routing (ready / scheduled-not_ready / gated-not_ready) is orthogonal: ingest is birth, not
      // readiness — a held follow-up is still embedded+wired+judged, exactly like the native lane.
      for (const r of followUpResults) {
        try {
          await ctx.ingestNode(T.ov, buildGraph(T.ws), r.key, { title: r.title, summary: r.prompt });
        } catch { /* best-effort birth ingest — never block the completion write */ }
      }
      for (const r of followUpResults) {
        if (r.routing === 'scheduled') {
          const w = ctx.harness.scheduler.writeScheduledTask({ id: r.key.slice('followup/'.length), title: r.title, prompt: r.prompt, taskKey: r.key, when: r.when, fireAt: r.fireAt, cwd: T.ws });
          r.armed = w.armed; if (w.skillPath) r.skill = w.skillPath; if (w.note) r.note = w.note; if (w.error) r.error = w.error;
        }
        delete r.prompt;
      }
      const { cache } = ctx;
      cache.agg.delete(T.ws); cache.aggAt.delete(T.ws);
    }
    let verdictResults = null;
    if (b.status === 'done' && Array.isArray(b.verdicts) && b.verdicts.length) {
      verdictResults = verdicts.apply(T.ov, b.key, b.verdicts);
      for (const r of verdictResults) if (r.action === 'cancel') snapshotNative(T.ov, r.task_key, null, T.ws);
      // AUTOMODE: auto-execute merge verdicts when config.automode is true.
      // When a judge task completes with {action:'merge', task_key:'<impl>'}, auto-call
      // git.mergeBranch so the attempt integrates without dispatcher intervention.
      if (T.ov.config && T.ov.config.automode) {
        for (const r of verdictResults) {
          if (r.action !== 'merge') continue;
          const repo = ctx.resolveRepo(r.task_key, undefined, T.ov, T.ws);
          if (!repo || !ctx.git.isRepo(repo)) continue;
          const mr = ctx.git.mergeBranch(repo, r.task_key, { message: `automode: merge attempt ${r.task_key} (${r.reason})` });
          if (mr.merged) {
            ctx.overlayStore.setGit(T.ov, r.task_key, { merged: true, merge_sha: mr.head || null, merged_at: ctx.now() });
            r.auto_merged = true; r.merge_sha = mr.head || null;
          } else if (mr.conflict) {
            r.merge_conflict = true;
          }
        }
      }
    }
    let staleHolds = null;
    let harnessRequeued = false;
    if (b.status === 'done') {
      bucketCleanup = followups.onBucketComplete(T.ov, b.key);
      T.save();
      const sh = verdicts.sweepStaleHolds(T.ov, b.key, buildGraph(T.ws));
      if (sh.released.length || sh.flagged.length) staleHolds = sh;
      harnessRequeued = requeueStandingHarness(T.ov, b.key, b.note);
    }
    const lintWarning = b.status === 'done' ? verdicts.lintProse(b.summary, b.verdicts, b.key) : null;
    T.save();
    // Write-through routed by namespace: file-drop stub keys update the stub file's status
    // field; Claude '<session>/<id>' keys keep the native todo-panel write-through.
    if (ns && b.key) ctx.writeTaskStatus(T.ws, String(b.key), ns);
    if (['done', 'tested', 'failed', 'canceled'].includes(b.status) && b.key) {
      if (filedropGc.removeStubIfSnapshotted(T.ws, String(b.key), T.ov)) {
        const { cache } = ctx;
        cache.agg.delete(T.ws); cache.aggAt.delete(T.ws);
      }
    }
    notifyChange(T.ws);
    const statusResp = { ok: true };
    if (followUpResults) statusResp.follow_ups = followUpResults;
    if (verdictResults) statusResp.verdicts = verdictResults;
    if (staleHolds) statusResp.stale_holds = staleHolds;
    if (bucketCleanup) statusResp.bucket_cleanup = bucketCleanup;
    if (harnessRequeued) statusResp.harness_requeued = true;
    if (lintWarning) statusResp.warning = lintWarning;
    if (b.status === 'in_progress' && b.force) {
      const FORCE_CAP = 3;
      statusResp.force_claims_remaining = Math.max(0, FORCE_CAP - ((T.ov.forceClaims && T.ov.forceClaims[b.key]) || 0));
    }
    if (gitClaim) statusResp.git_claim = { ok: !!gitClaim.ok, already_claimed: !!gitClaim.already_claimed, pushed: !!gitClaim.pushed, conflict: !!gitClaim.conflict, advisory: !gitClaimMode.strict, error: gitClaim.error || null };
    if (gitClaimFinalize) statusResp.git_claim_finalize = { ok: !!gitClaimFinalize.ok, pushed: !!gitClaimFinalize.pushed, skipped: !!gitClaimFinalize.skipped, conflict: !!gitClaimFinalize.conflict, advisory: !gitClaimMode.strict, error: gitClaimFinalize.error || null };
    if (executionPermit) statusResp.execution_permit = executionPermit;
    if (readyBefore) {
      statusResp.newly_ready = newlyReady.diffNewlyReady(readyBefore, newlyReady.readyKeys(buildGraph(T.ws)));
    }
    sendOp(res, b, 200, statusResp); return true;
  }

  if (p === '/overlay/dispatcher-focus' && m === 'POST') {
    const b = await readBody(req);
    if (!b.session_id || !b.task_key) {
      send(res, 400, { ok: false, error: 'session_id and task_key required' });
      return true;
    }
    const T = targetOverlay(b, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    if (!T.ov.dispatcher_focus) T.ov.dispatcher_focus = {};
    T.ov.dispatcher_focus[b.session_id] = b.task_key;
    T.save();
    notifyChange(T.ws);
    send(res, 200, { ok: true, session_id: b.session_id, focus: b.task_key });
    return true;
  }

    if (p === '/overlay/claim-session' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.task_key || !b.session_id) { send(res, 400, { ok: false, error: 'task_key and session_id required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    if (!T.ov.claimSessions) T.ov.claimSessions = {};
    T.ov.claimSessions[b.task_key] = b.session_id;
    T.save();
    send(res, 200, { ok: true }); return true;
  }

  if (p === '/overlay/knowledge' && m === 'POST') {
    const b = await readBody(req);
    if (ctx.opReplay(res, b)) return true;
    const T = targetOverlay(b, u);
    if (!b.key || !b.item) { send(res, 400, { ok: false, error: 'key and item required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    if (!acceptsTaskKey(T, b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    ensureTaskSnapshot(T, b.key);
    const kvec = await embed(knowledgeText(b.item));
    if (kvec) b.item._vec = kvec;
    (T.ov.knowledge[b.key] = T.ov.knowledge[b.key] || []).push(b.item);
    T.save(); notifyChange(T.ws);
    sendOp(res, b, 200, { ok: true, count: T.ov.knowledge[b.key].length }); return true;
  }

  if (p === '/overlay/knowledge-node' && m === 'POST') {
    const b = await readBody(req);
    if (ctx.opReplay(res, b)) return true;
    const T = targetOverlay(b, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    const fields = [
      b.type || b.kind,
      b.label || b.title,
      b.summary,
      b.source_path || b.sourcePath,
      b.section_ref || b.sectionRef,
      b.chunk_ref || b.chunkRef,
      b.cluster_ref || b.clusterRef,
    ].map((x) => String(x || '').trim()).filter(Boolean);
    const payload = { ...b };
    if (fields.length) {
      payload.vec = await embed(fields.join(' '));
      payload.vecs = (await Promise.all(fields.map(embed))).filter(Boolean);
    }
    const r = overlayStore.upsertKnowledgeNode(T.ov, payload);
    if (!r.ok) { send(res, 400, r); return true; }
    T.save(); notifyChange(T.ws);
    sendOp(res, b, 200, { ok: true, key: r.key, node: r.node }); return true;
  }

  if (p === '/overlay/note' && m === 'POST') {
    const b = await readBody(req);
    if (ctx.opReplay(res, b)) return true;
    const T = targetOverlay(b, u);
    if (!b.title || !b.summary) { send(res, 400, { ok: false, error: 'title and summary required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    // Validate wires_to targets BEFORE creating the note — reject unknown task keys (phantom-node guard).
    if (Array.isArray(b.wires_to) && b.wires_to.length) {
      const _bad = b.wires_to.filter((k) => !acceptsTaskKey(T, k));
      if (_bad.length) { send(res, 404, { ok: false, error: `unknown task(s) in wires_to: ${_bad.join(', ')}` }); return true; }
      for (const k of b.wires_to) ensureTaskSnapshot(T, k);
    }
    const rawNotePayload = { ...b };
    if (noteSourceCluster.shouldClusterNote(rawNotePayload)) {
      b.summary = noteSourceCluster.compactNoteSummary(b.summary);
    }
    b.vec = await embed(noteEmbedText({ title: b.title, category: b.category, tags: b.tags, summary: b.summary }));
    // FIELD-LEVEL multi-vec set (note.vecs): embed each salient field (title/summary/each knowledge[]
    // entry) on its own so a knowledge item is retrievable without being diluted into the pooled vec.
    // The pooled b.vec above stays the gate/dedup vector; b.vecs only upgrades corpus scoring.
    b.vecs = (await Promise.all(noteFieldTexts({ title: b.title, summary: b.summary, knowledge: b.knowledge }).map(embed))).filter(Boolean);

    // Near-duplicate guard: reject if a current note has cosine(title-vec) >= DUP_THRESHOLD,
    // unless the caller already resolved the conflict with `supersedes` or `force:true`.
    // Calibrated on the locale-sum gotcha cluster (12 clones):
    //   positive min  (clone vs clone): 0.5743
    //   negative p99  (random pairs):   0.5326
    //   negative max  (same-subsystem): 0.9466 (bench-report.js vs bench-report.test.js — file ingest titles)
    // Overlap exists above ~0.57 — title-only vecs cannot cleanly separate clones from legitimate
    // same-subsystem neighbours (whose p99 is 0.66). Threshold 0.70 sits above that p99 so routine
    // notes in an active subsystem do NOT bounce (avoids alarm-fatigue → reflexive force:true, which
    // would neuter the guard) while still catching the dense clone mass (0.68–0.88). Stragglers in
    // the 0.55–0.70 band are the dup-judge's job (defense-in-depth), not the write gate's.
    // DEFER-TO-JUDGE (was hard-reject): on a guard fire we no longer bounce the caller back to
    // skip/supersede/force. We ADMIT the note PROVISIONAL (pending_dup) — retrieval-invisible — and
    // enqueue the {new,match} pair for the intelligent dup-judge, which decides consolidate/distinct/
    // supersede. The dumb write path only flags; the judge reasons. `supersedes`/`force` still bypass
    // the guard entirely (the caller already resolved the conflict).
    const DUP_THRESHOLD = 0.70; // title-vec cosine; see calibration note above
    let pendingDupMatch = null;
    if (b.vec && !b.supersedes && !b.force) {
      const { cosine } = ctx;
      let bestMatch = null;
      for (const n of Object.values(T.ov.note_nodes || {})) {
        if (!n.validTo && Array.isArray(n.vec)) {
          const score = cosine(b.vec, n.vec);
          if (score >= DUP_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { key: 'note:' + n.id, title: n.title, summary: String(n.summary || '').slice(0, 200), score };
          }
        }
      }
      if (bestMatch) pendingDupMatch = bestMatch;
    }

    const id = overlayStore.addNoteNode(T.ov, b);
    if (!b.vec) {
      const _retryText = b.title;
      setTimeout(async () => {
        try {
          const v = await embed(_retryText);
          if (!v) return;
          const node = T.ov.note_nodes && T.ov.note_nodes[id];
          if (node && !node.vec) {
            node.vec = v;
            // P3: resolve the graph-store per request workspace (no daemon-global state.graphStore).
            const gs = T.ws ? graphStore.open(path.join(T.ws, '.graph')) : null;
            if (gs) graphStore.appendEvent(gs, 'note:' + id, { evt: 'note_vec_set', id, vec: v, actor: 'retry', ts: Date.now() });
          }
        } catch { /* best effort */ }
      }, 45000);
    }
    overlayStore.bumpEpoch(T.ov);
    // PENDING-DUP: the guard fired (cosine >= DUP_THRESHOLD, no supersedes/force). The note was just
    // ADMITTED; flag it pending_dup so it is retrieval-invisible and surfaced to the dup-judge as a
    // {new,match} cluster (judge.pendingDupClusters → buildQueue → GET /judge/next). bumpEpoch above
    // makes the pair re-pullable (clusterPending: judgedAtEpoch < epoch). The pair is queued via the
    // pendingDup map (NOT eagerJudge — that path is edge-based and would no-op for a 0.70–0.80 pair
    // that forms no natural cluster).
    if (pendingDupMatch) overlayStore.markPendingDup(T.ov, 'note:' + id, pendingDupMatch.key, pendingDupMatch.score);
    let superseded = null;
    if (b.supersedes) {
      const oldId = String(b.supersedes).replace(/^note:/, '');
      const r = overlayStore.supersedeNote(T.ov, oldId, id, b.valid_from, T.ws);
      if (!r.ok) { send(res, 400, { ok: false, error: r.error }); return true; }
      superseded = { old_key: 'note:' + oldId, at: r.at };
    }
    let hint = null;
    if (!b.supersedes) {
      const qt = suggestToks(`${b.title} ${b.summary}`);
      let best = null;
      for (const n of Object.values(T.ov.note_nodes || {})) {
        if (n.id === id || n.validTo) continue;
        const { score } = scoreNodeAgainstTokens({ label: n.title, summary: n.summary }, qt);
        if (score >= SUGGEST_DUP_THRESHOLD && (!best || score > best.score)) best = { key: 'note:' + n.id, score };
      }
      if (best) hint = `this may contradict/duplicate note ${best.key} — if it replaces it, call supersede_note(old_key=${best.key}, new_key=note:${id}) so the stale note is retired; if uncertain, leave both.`;
    }
    if (Array.isArray(b.wires_to)) {
      for (const taskKey of b.wires_to) {
        overlayStore.addEdge(T.ov, 'note:' + id, taskKey, null, 'context', 1.0);
        const gs = T.ws ? graphStore.open(path.join(T.ws, '.graph')) : null;
        if (gs) graphStore.appendEvent(gs, 'note:' + id, { evt: 'edge_added', from: 'note:' + id, to: taskKey, kind: 'context', weight: 1.0, actor: b.actor || 'record-decision', ts: Date.now() });
      }
    }
    const sourceCluster = noteSourceCluster.buildSourceClusterForNote('note:' + id, rawNotePayload);
    if (sourceCluster) {
      for (const node of sourceCluster.nodes) {
        const fields = [
          node.type,
          node.label || node.title,
          node.summary,
          node.source_path,
          node.section_ref,
          node.chunk_ref,
        ].map((x) => String(x || '').trim()).filter(Boolean);
        const payload = { ...node };
        if (fields.length) {
          payload.vec = await embed(fields.join(' '));
          payload.vecs = (await Promise.all(fields.map(embed))).filter(Boolean);
        }
        overlayStore.upsertKnowledgeNode(T.ov, payload);
      }
      for (const edge of sourceCluster.edges) {
        overlayStore.addEdge(T.ov, edge.from, edge.to, null, 'context', 1.0, { origin: 'note-source-cluster' });
      }
    }
    // Persist the note/supersede event before buildGraph can reload from the local overlay JSON,
    // which intentionally excludes note_nodes and relies on graph-store rehydration.
    T.save();
    // INGEST: route the note through the unified ingestNode funnel (autowireNoteProvider + markEagerJudge).
    // ingestNode detects the note: prefix, skips re-embed (vec already in note_nodes[id].vec via addNoteNode),
    // calls autowireNoteProvider to seed weight-0 candidate edges to relevant tasks/notes, then stamps
    // markEagerJudge so the heartbeat dispatches a judge immediately when edges were seeded.
    const ingestResult = await ctx.ingestNode(T.ov, buildGraph(T.ws), 'note:' + id, { title: b.title, summary: b.summary });
    // FadeMem subsumption (Note-decay E): if the new note's embedding is available and it
    // semantically subsumes an older current note (cosine >= SUBSUMPTION_THRESHOLD), soft-retire
    // the older note by setting its validTo and supersededBy, then log a note_superseded event.
    // Guard: skip if no vec (embedding sidecar unavailable → fail-open, consistent with dup guard).
    if (b.vec && !judge.noteDecayDisabled()) {
      try {
        const subsumed = judge.findSubsumedNotes(id, b.vec, T.ov);
        if (subsumed.length) {
          const newNoteKey = 'note:' + id;
          const retiredAt = new Date().toISOString();
          const gs2 = graphStore.forWorkspace(T.ws);
          for (const { noteId } of subsumed) {
            const oldNode = T.ov.note_nodes[noteId];
            if (!oldNode) continue;
            oldNode.validTo = retiredAt;
            oldNode.supersededBy = id;
            graphStore.appendEvent(gs2, 'note:' + noteId, { evt: 'note_superseded', id: noteId, supersededBy: id, validTo: retiredAt, actor: 'subsumption', ts: retiredAt });
          }
        }
      } catch { /* subsumption is best-effort — never block the note write */ }
    }
    T.save(); notifyChange(T.ws);
    const resp = { ok: true, id, key: 'note:' + id, superseded, autowired: ingestResult.seeded, hint };
    if (sourceCluster) resp.source_cluster = { nodes: sourceCluster.nodes.length, chunks: sourceCluster.chunkCount };
    if (pendingDupMatch) {
      resp.pending_dup = true;
      resp.note_key = 'note:' + id;
      resp.match = {
        key: pendingDupMatch.key, title: pendingDupMatch.title, summary: pendingDupMatch.summary,
        score: Math.round(pendingDupMatch.score * 10000) / 10000,
      };
    }
    sendOp(res, b, 200, resp); return true;
  }

  if (p === '/overlay/gate' && m === 'POST') {
    const b = await readBody(req);
    if (ctx.opReplay(res, b)) return true;
    const T = targetOverlay(b, u);
    if (!b.kind) { send(res, 400, { ok: false, error: 'kind required' }); return true; }
    if (!b.blocking_task_key) { send(res, 400, { ok: false, error: 'blocking_task_key required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    if (!acceptsTaskKey(T, b.blocking_task_key)) {
      return send(res, 404, { ok: false, error: `unknown task: ${b.blocking_task_key}` });
    }
    ensureTaskSnapshot(T, b.blocking_task_key);
    const { mintGateKey } = require('../lib/followups');
    const { GATE_KINDS } = require('../lib/followup-buckets');
    if (!GATE_KINDS[b.kind]) { send(res, 400, { ok: false, error: `Unknown gate kind: ${b.kind}` }); return true; }
    const key = mintGateKey(T.ov, b.kind);
    const now = new Date().toISOString();
    overlayStore.setSnapshot(T.ov, key, {
      subject: `Gate: ${b.kind}`,
      description: GATE_KINDS[b.kind].guidanceQuestion,
      status: 'pending',
      blockedBy: [],
      owner: null,
      metadata: { gate_kind: b.kind, created_at: now, created_by: b.created_by || 'dispatcher', blocking_task: b.blocking_task_key },
    });
    overlayStore.setStatus(T.ov, key, 'not_ready', `gate/${b.kind}: waiting for ${GATE_KINDS[b.kind].satisfiedBy}`);
    overlayStore.addEdge(T.ov, key, b.blocking_task_key, null, 'blocking');
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, gate_key: key, kind: b.kind, blocking_task_key: b.blocking_task_key });
    return true;
  }

  if (p === '/overlay/note/rewire' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    const id = String(b.key).replace(/^note:/, '');
    const n = (T.ov.note_nodes || {})[id];
    if (!n) { send(res, 404, { ok: false, error: 'unknown note' }); return true; }
    if (!T.ov.judgedAtEpoch) T.ov.judgedAtEpoch = {};
    delete T.ov.judgedAtEpoch['note:' + id];
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, key: 'note:' + id, requeued: true, autowired: 0 }); return true;
  }

  if (p === '/overlay/note/supersede' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.old_key || !b.new_key) { send(res, 400, { ok: false, error: 'old_key and new_key required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    const oldId = String(b.old_key).replace(/^note:/, '');
    const newId = String(b.new_key).replace(/^note:/, '');
    const r = overlayStore.supersedeNote(T.ov, oldId, newId, b.at, T.ws);
    if (!r.ok) { send(res, 400, { ok: false, error: r.error }); return true; }
    overlayStore.markForRejudge(T.ov, 'note:' + oldId);
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, old_key: 'note:' + oldId, new_key: 'note:' + newId, at: r.at }); return true;
  }

  if (p === '/overlay/block' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    if (!acceptsTaskKey(T, b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    ensureTaskSnapshot(T, b.key);
    overlayStore.setBlocked(T.ov, b.key, b.reason);
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, key: b.key, blocked: T.ov.blocked[b.key] }); return true;
  }

  if (p === '/overlay/unblock' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    if (!acceptsTaskKey(T, b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    const wasBlocked = overlayStore.isBlocked(T.ov, b.key);
    overlayStore.clearBlocked(T.ov, b.key);
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, key: b.key, was_blocked: wasBlocked }); return true;
  }

  if (p === '/overlay/backfill-embeddings' && m === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const T = targetOverlay(b, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    let notesEmbedded = 0, notesSkipped = 0, knEmbedded = 0, knSkipped = 0, failed = 0;
    // P3: resolve the graph-store per request workspace (no daemon-global state.graphStore).
    const gs = graphStore.open(path.join(T.ws, '.graph'));
    const ts = new Date().toISOString();
    for (const n of Object.values(T.ov.note_nodes || {})) {
      // Upgrade a note that is missing EITHER the pooled `.vec` OR the field-level `.vecs` set.
      // (Previously only notes missing `.vec` were touched, so existing notes never gained `.vecs`.)
      const hasVec = Array.isArray(n.vec);
      const hasVecs = Array.isArray(n.vecs) && n.vecs.length > 0;
      if (hasVec && hasVecs) { notesSkipped++; continue; }
      let touched = false;
      if (!hasVec) {
        const v = await embed(noteEmbedText({ title: n.title, category: n.category, tags: n.tags, summary: n.summary }));
        if (v) {
          n.vec = v; touched = true;
          graphStore.appendEvent(gs, 'note:' + n.id, { evt: 'note_vec_set', id: n.id, vec: v, actor: 'backfill', ts });
        } else failed++;
      }
      if (!hasVecs) {
        const vecs = (await Promise.all(noteFieldTexts({ title: n.title, summary: n.summary, knowledge: noteKnowledge(T.ov, n) }).map(embed))).filter(Boolean);
        if (vecs.length) {
          n.vecs = vecs; touched = true;
          graphStore.appendEvent(gs, 'note:' + n.id, { evt: 'note_vecs_set', id: n.id, vecs, actor: 'backfill', ts });
        }
      }
      if (touched) notesEmbedded++;
    }
    for (const items of Object.values(T.ov.knowledge || {})) {
      for (const it of (items || [])) {
        if (it && Array.isArray(it._vec)) { knSkipped++; continue; }
        const v = await embed(knowledgeText(it));
        if (v && it && typeof it === 'object') { it._vec = v; knEmbedded++; } else failed++;
      }
    }
    // TASK backfill (multi-vec schema): every real (non-note) task node that lacks a vec gets one
    // from its title+summary. buildGraph yields the authoritative label+summary per node.
    let tasksEmbedded = 0, tasksSkipped = 0;
    const g = buildGraph(T.ws);
    for (const node of g.tasks) {
      if (overlayStore.isNonTaskNode(node)) continue;
      const existing = T.ov.taskVecs && T.ov.taskVecs[node.id];
      if (Array.isArray(existing) && existing.length) { tasksSkipped++; continue; }
      const v = await embed(taskEmbedText({ title: node.label, summary: node.summary }));
      if (v) { overlayStore.setTaskVec(T.ov, node.id, v); tasksEmbedded++; } else failed++;
    }
    overlayStore.save(T.ws, T.ov);
    notifyChange(T.ws);
    send(res, 200, { ok: true, notes: { embedded: notesEmbedded, skipped: notesSkipped }, knowledge: { embedded: knEmbedded, skipped: knSkipped }, tasks: { embedded: tasksEmbedded, skipped: tasksSkipped }, failed }); return true;
  }

  if (p === '/overlay/reembed' && m === 'POST') {
    const body2 = await readBody(req).catch(() => ({}));
    const T = targetOverlay(body2, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    const force2 = body2 && body2.force;
    let embedded = 0, skipped = 0, failed = 0;
    // P3: resolve the graph-store per request workspace (no daemon-global state.graphStore).
    const gs2 = graphStore.open(path.join(T.ws, '.graph'));
    const ts2 = new Date().toISOString();
    for (const n of Object.values(T.ov.note_nodes || {})) {
      // Skip only when BOTH the pooled `.vec` and the field-level `.vecs` set are already present at
      // full DIMS (and not forced) — so existing single-vec notes get upgraded to multivec.
      const vecOk = Array.isArray(n.vec) && n.vec.length === DIMS;
      const vecsOk = Array.isArray(n.vecs) && n.vecs.length > 0;
      if (!force2 && vecOk && vecsOk) { skipped++; continue; }
      let touched = false;
      const v = await embed(noteEmbedText({ title: n.title, category: n.category, tags: n.tags, summary: n.summary }));
      if (v) { n.vec = v; touched = true; graphStore.appendEvent(gs2, 'note:' + n.id, { evt: 'note_vec_set', id: n.id, vec: v, actor: 'reembed', ts: ts2 }); } else failed++;
      const vecs = (await Promise.all(noteFieldTexts({ title: n.title, summary: n.summary, knowledge: noteKnowledge(T.ov, n) }).map(embed))).filter(Boolean);
      if (vecs.length) { n.vecs = vecs; touched = true; graphStore.appendEvent(gs2, 'note:' + n.id, { evt: 'note_vecs_set', id: n.id, vecs, actor: 'reembed', ts: ts2 }); }
      if (touched) embedded++;
    }
    overlayStore.save(T.ws, T.ov);
    notifyChange(T.ws);
    send(res, 200, { ok: true, embedded, skipped, failed }); return true;
  }

  if (p === '/supersede' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.old_key || !b.new_key) { send(res, 400, { ok: false, error: 'old_key and new_key required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    // Reject unknown task keys — both old and new must exist (phantom-node guard).
    if (!acceptsTaskKey(T, b.old_key)) { send(res, 404, { ok: false, error: `unknown task: ${b.old_key}` }); return true; }
    if (!acceptsTaskKey(T, b.new_key)) { send(res, 404, { ok: false, error: `unknown task: ${b.new_key}` }); return true; }
    ensureTaskSnapshot(T, b.old_key);
    ensureTaskSnapshot(T, b.new_key);
    const note = `superseded by ${b.new_key}${b.reason ? ': ' + b.reason : ''}`;
    overlayStore.setStatus(T.ov, b.old_key, 'canceled', note);
    overlayStore.markForRejudge(T.ov, b.old_key);
    snapshotNative(T.ov, b.old_key, null, T.ws);
    overlayStore.addEdge(T.ov, b.old_key, b.new_key, null, 'supersede');
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, old_key: b.old_key, new_key: b.new_key }); return true;
  }

  // ─── Phase 2: Entity layer ────────────────────────────────────────────────

  // POST /entity — create or upsert an entity node.
  // Body: { name, type, aliases?, workspace, vec? }
  // Returns: { ok, id, kind:'entity', name, type, created }
  if (p === '/entity' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.name) { send(res, 400, { ok: false, error: 'name required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    // Embed the entity name for semantic retrieval (same embed path as notes; best-effort).
    let vec = null;
    try { vec = await embed(String(b.name)); } catch { /* embedding sidecar unavailable — lexical fallback */ }
    let entity;
    try {
      entity = overlayStore.createEntity(T.ov, { name: b.name, type: b.type, aliases: b.aliases, vec });
    } catch (err) {
      send(res, 400, { ok: false, error: err.message }); return true;
    }
    T.save(); notifyChange(T.ws);
    send(res, 200, { ok: true, id: entity.id, kind: 'entity', name: entity.name, type: entity.type, created: !vec || entity.validFrom === entity.validFrom }); return true;
  }

  // POST /entity/link — wire two nodes with a relation label.
  // Body: { from, to, relation, workspace }
  //
  // Accepted combinations (Phase 4 extended — entity is the unification join key):
  //   note    → entity   (a distilled fact is about this entity)
  //   entity  → note     (same, reversed)
  //   entity  → entity   (e.g. 'works_at', 'prefers')
  //   task    → entity   (a task touches this entity's subsystem)
  //   entity  → task     (same, reversed)
  //
  // from/to may be a note key ('note:<id>'), task key (any key in ov.nodes as kind:'task',
  // or any admissible overlay key), or entity key ('entity:<id>').
  // relation: e.g. 'subject_of', 'related_to', 'works_at', 'touches'
  // Returns: { ok, from, to, relation }
  // After wiring, fires the async contradiction check (fire-and-forget, note→entity pairs only).
  if (p === '/entity/link' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.from || !b.to) { send(res, 400, { ok: false, error: 'from and to required' }); return true; }
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass workspace (body or ?workspace=)' }); return true; }
    // Validate each key: entity keys must exist in entity_nodes; task keys must exist as tasks.
    // note keys (note:<id>) are accepted without a node existence check (same as /overlay/edge).
    const validateLinkKey = (key) => {
      if (key.startsWith('entity:')) {
        const bareId = key.slice(7);
        return (T.ov.entity_nodes && T.ov.entity_nodes[bareId]) ? null : `unknown entity: ${key}`;
      }
      if (key.startsWith('note:')) return null; // note keys are self-validating (note:<id>)
      // task key: must be admissible or exist in graph
      if (!acceptsTaskKey(T, key)) return `unknown task: ${key}`;
      return null;
    };
    const fromErr = validateLinkKey(b.from);
    if (fromErr) { send(res, 404, { ok: false, error: fromErr }); return true; }
    const toErr = validateLinkKey(b.to);
    if (toErr) { send(res, 404, { ok: false, error: toErr }); return true; }
    // At least one side must be an entity (entity-link is entity-anchored).
    if (!b.from.startsWith('entity:') && !b.to.startsWith('entity:')) {
      send(res, 400, { ok: false, error: 'at least one of from/to must be an entity key (entity:<id>)' }); return true;
    }
    let edge;
    try {
      edge = overlayStore.addEntityEdge(T.ov, b.from, b.to, b.relation);
    } catch (err) {
      send(res, 400, { ok: false, error: err.message }); return true;
    }
    T.save(); notifyChange(T.ws);

    // Contradiction check: fire-and-forget when a note is wired to an entity.
    // Only fires when the new side is a note and the other side is an entity.
    const noteKey = b.from.startsWith('note:') ? b.from : (b.to.startsWith('note:') ? b.to : null);
    const entityKey = b.from.startsWith('entity:') ? b.from : (b.to.startsWith('entity:') ? b.to : null);
    if (noteKey && entityKey) {
      const newNoteId = noteKey.slice(5);
      const entityId = entityKey.slice(7);
      // Build a spawnClaude helper: wraps child_process.execFile with the same pattern as distill.py.
      const spawnClaude = async (prompt) => {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const claudeCli = process.env.ZONOID_BENCH_CLAUDE || 'claude';
        const model = process.env.ZONOID_BENCH_MODEL || 'haiku'; // use fast/cheap model for contradiction check
        const args = ['--model', model, '--output-format', 'text', '--allowedTools', '', '-p'];
        try {
          const result = await execFileAsync(claudeCli, args, { input: prompt, encoding: 'utf8', timeout: 60000, windowsHide: true });
          return result.stdout || '';
        } catch {
          return null;
        }
      };
      // setImmediate so we don't block the HTTP response.
      setImmediate(() => {
        overlayStore.checkEntityContradiction(T.ov, T.ws, newNoteId, entityId, spawnClaude, overlayStore.save).catch(() => {});
      });
    }

    send(res, 200, { ok: true, from: b.from, to: b.to, relation: b.relation || null }); return true;
  }

  // ─── Phase 4: Entity context (unification payoff) ────────────────────────

  // GET /entity?name=<name>&workspace=...
  // Look up an entity by name (case-insensitive exact match). Returns the entity record or 404.
  // Used by the entity_context MCP tool to find an entity id before calling GET /entity/:id/context.
  if (p === '/entity' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass ?workspace=' }); return true; }
    const nameParam = u && u.searchParams && u.searchParams.get('name');
    if (!nameParam) { send(res, 400, { ok: false, error: 'name query param required' }); return true; }
    const normName = nameParam.trim().toLowerCase();
    let found = null;
    for (const entity of Object.values(T.ov.entity_nodes || {})) {
      if (!entity.validTo && entity.name && entity.name.toLowerCase() === normName) { found = entity; break; }
    }
    if (!found) { send(res, 404, { ok: false, error: `no entity found with name: ${nameParam}` }); return true; }
    send(res, 200, { ok: true, id: found.id, name: found.name, type: found.type, aliases: found.aliases || [], validFrom: found.validFrom || null }); return true;
  }

  // GET /entity/:id/context?workspace=...&asOf=...
  // Returns everything known (conversational facts) AND everything done (tasks) about entity E,
  // in a single unified view. Entity is the join key across both graphs.
  //
  // Response:
  //   { entity: { id, name, type, aliases },
  //     facts: [ ...note nodes linked to this entity via context edges ],
  //     tasks: [ ...task nodes linked to this entity via context edges ],
  //     summary: "N facts, M tasks" }
  //
  // Temporal filter: if asOf is provided, only facts with validTo==null OR validTo >= asOf are returned.
  if (p.startsWith('/entity/') && p.endsWith('/context') && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace resolved — pass ?workspace=' }); return true; }
    const pathParts = p.split('/');
    const entityId = pathParts[2];
    if (!entityId) { send(res, 400, { ok: false, error: 'entity id required in path' }); return true; }
    const entity = T.ov.entity_nodes && T.ov.entity_nodes[entityId];
    if (!entity) { send(res, 404, { ok: false, error: `unknown entity: entity:${entityId}` }); return true; }

    const asOf = (u && u.searchParams && u.searchParams.get('asOf')) || null;
    const entityKey = 'entity:' + entityId;

    const linkedKeys = new Set();
    for (const e of (T.ov.edges || [])) {
      if (e.kind !== 'context') continue;
      if (e.from === entityKey) linkedKeys.add(e.to);
      else if (e.to === entityKey) linkedKeys.add(e.from);
    }

    const facts = [];
    const tasks = [];
    for (const key of linkedKeys) {
      if (key.startsWith('note:')) {
        const noteId = key.slice(5);
        const n = T.ov.note_nodes && T.ov.note_nodes[noteId];
        if (!n) continue;
        if (asOf && n.validTo && n.validTo < asOf) continue;
        facts.push({ key, id: n.id, title: n.title, summary: n.summary, category: n.category || null, validFrom: n.validFrom || null, validTo: n.validTo || null, supersededBy: n.supersededBy || null });
      } else if (!key.startsWith('entity:')) {
        const snap = T.ov.snapshots && T.ov.snapshots[key];
        const status = (T.ov.status && T.ov.status[key]) || (snap && snap.status) || 'unknown';
        const summary = (T.ov.summaries && T.ov.summaries[key]) || (snap && snap.description) || '';
        tasks.push({ key, label: (snap && snap.subject) || key, status, summary });
      }
    }

    send(res, 200, {
      ok: true,
      entity: { id: entity.id, name: entity.name, type: entity.type, aliases: entity.aliases || [] },
      facts,
      tasks,
      summary: `${facts.length} fact${facts.length !== 1 ? 's' : ''}, ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`,
    }); return true;
  }


  return false;
};
