'use strict';
const overlayStore = require('../lib/overlay');
const filedropGc = require('../lib/filedrop-gc');
const judge = require('../lib/judge');
const graphStore = require('../lib/graph-store');
const path = require('path');
const { noteEmbedText, taskEmbedText } = require('../lib/node-tags');
const newlyReady = require('../lib/newly-ready');
const { requeueStandingHarness } = require('../lib/harness-task');
const recallJournal = require('../lib/recall-outcome-journal');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, sendOp, readBody, notifyChange, buildGraph, state, targetOverlay,
    embed, knowledgeText, snapshotNative, now, suggestToks, scoreNodeAgainstTokens,
    SUGGEST_DUP_THRESHOLD, DIMS } = ctx;

  if (p === '/overlay/edge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.from || !b.to) { send(res, 400, { ok: false, error: 'from and to required' }); return true; }
    // add_dependency / wires_to / suggest_links all land here — these are hand-ASSERTED edges (no
    // autowire origin), so default origin:'asserted'. This is the population keepRateByBand must EXCLUDE
    // when tuning the autowire-lexical threshold (asserted note->task edges contaminated the sub-0.40 band).
    overlayStore.addEdge(T.ov, b.from, b.to, b.fromWorkspace, b.kind, b.weight, { origin: 'asserted' });
    T.save(); notifyChange();
    send(res, 200, { ok: true, edges: T.ov.edges.length, ghost: !!b.fromWorkspace, kind: b.kind === 'context' ? 'context' : 'blocking' }); return true;
  }

  if (p === '/overlay/edge/remove' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.from || !b.to) { send(res, 400, { ok: false, error: 'from and to required' }); return true; }
    const before = T.ov.edges.length;
    overlayStore.removeEdge(T.ov, b.from, b.to, b.fromWorkspace, b.kind);
    const removed = before - T.ov.edges.length;
    T.save(); notifyChange();
    send(res, 200, { ok: true, removed, edges: T.ov.edges.length }); return true;
  }

  if (p === '/overlay/status' && m === 'POST') {
    const { ALL_STATUSES, followups, verdicts, agentsArr, saveAgents, git } = ctx;
    const b = await readBody(req);
    if (ctx.opReplay(res, b)) return true;
    const T = targetOverlay(b, u);
    if (!ALL_STATUSES.includes(b.status)) { send(res, 400, { ok: false, error: 'invalid status', allowed: ALL_STATUSES }); return true; }
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
    if (b.status === 'in_progress') {
      let claimSid = b.session_id ? String(b.session_id) : null;
      if (!claimSid && b.agent_id && ctx.state.agents[b.agent_id]) {
        const ag = ctx.state.agents[b.agent_id];
        if (ag.subagent_session && ag.subagent_session !== ag.session) claimSid = ag.subagent_session;
        else if (ag.session) claimSid = ag.session;
      }
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
          T.save(); ctx.notifyChange();
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
      const _js = judge.judgingState(T.ov, b.key, Date.now(), judge.judgingTimeoutMs(T.ov));
      if (_js.judging && !_js.timedOut) {
        send(res, 409, { ok: false, error: 'task wirings not yet judged — this task is in the judging phase (unjudged autowire context edges); its inherited context is provisional. Wait for the eager judge to keep/prune them (it dispatches automatically), or it falls back to claimable after the judging timeout.' }); return true;
      }
    }
    if (b.status === 'in_progress' && T.ov.metrics && T.ov.metrics[b.key]) {
      const branch = git.currentBranch(T.ws);
      if (!branch || !branch.startsWith('orch/attempt/')) {
        send(res, 409, { ok: false, error: 'self-learning mode: task has a metric spec — call branch_task first before editing' }); return true;
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
          { encoding: 'utf8', timeout: 2000 }
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
    } else {
      const sessions = T.ov.work_sessions && T.ov.work_sessions[b.key];
      if (sessions) {
        const open = [...sessions].reverse().find(s => !s.end_ts);
        if (open) open.end_ts = now();
      }
      if (['done', 'tested', 'failed', 'canceled'].includes(b.status) && T.ov.claimSessions) {
        delete T.ov.claimSessions[b.key];
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
    if (['done', 'tested', 'failed', 'canceled'].includes(b.status)) snapshotNative(T.ov, b.key, ns);
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
      for (const r of verdictResults) if (r.action === 'cancel') snapshotNative(T.ov, r.task_key);
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
    notifyChange();
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
    if (!T.ov.dispatcher_focus) T.ov.dispatcher_focus = {};
    T.ov.dispatcher_focus[b.session_id] = b.task_key;
    T.save();
    notifyChange();
    send(res, 200, { ok: true, session_id: b.session_id, focus: b.task_key });
    return true;
  }

    if (p === '/overlay/claim-session' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.task_key || !b.session_id) { send(res, 400, { ok: false, error: 'task_key and session_id required' }); return true; }
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
    const kvec = await embed(knowledgeText(b.item));
    if (kvec) b.item._vec = kvec;
    (T.ov.knowledge[b.key] = T.ov.knowledge[b.key] || []).push(b.item);
    T.save(); notifyChange();
    sendOp(res, b, 200, { ok: true, count: T.ov.knowledge[b.key].length }); return true;
  }

  if (p === '/overlay/note' && m === 'POST') {
    const b = await readBody(req);
    if (ctx.opReplay(res, b)) return true;
    const T = targetOverlay(b, u);
    if (!b.title || !b.summary) { send(res, 400, { ok: false, error: 'title and summary required' }); return true; }
    b.vec = await embed(noteEmbedText({ title: b.title, category: b.category, tags: b.tags, summary: b.summary }));

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
            const gs = (T.ws === state.workspace) ? state.graphStore : null;
            if (gs) graphStore.appendEvent(gs, 'note:' + id, { evt: 'note_vec_set', id, vec: v, actor: 'retry', ts: Date.now() });
          }
        } catch { /* best effort */ }
      }, 45000);
    }
    if (T.ws === state.workspace) {
      if (!state.overlay.note_nodes[id]) state.overlay.note_nodes[id] = T.ov.note_nodes[id];
      if (Array.isArray(b.knowledge) && b.knowledge.length > 0 && !state.overlay.knowledge[id]) {
        state.overlay.knowledge[id] = b.knowledge;
      }
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
        const gs = (T.ws === state.workspace) ? state.graphStore : null;
        if (gs) graphStore.appendEvent(gs, 'note:' + id, { evt: 'edge_added', from: 'note:' + id, to: taskKey, kind: 'context', weight: 1.0, actor: b.actor || 'record-decision', ts: Date.now() });
      }
    }
    // INGEST: route the note through the unified ingestNode funnel (autowireNoteProvider + markEagerJudge).
    // ingestNode detects the note: prefix, skips re-embed (vec already in note_nodes[id].vec via addNoteNode),
    // calls autowireNoteProvider to seed weight-0 candidate edges to relevant tasks/notes, then stamps
    // markEagerJudge so the heartbeat dispatches a judge immediately when edges were seeded.
    const ingestResult = await ctx.ingestNode(T.ov, buildGraph(T.ws), 'note:' + id, { title: b.title, summary: b.summary });
    T.save(); notifyChange();
    const resp = { ok: true, id, key: 'note:' + id, superseded, autowired: ingestResult.seeded, hint };
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
    T.save(); notifyChange();
    send(res, 200, { ok: true, gate_key: key, kind: b.kind, blocking_task_key: b.blocking_task_key });
    return true;
  }

  if (p === '/overlay/note/rewire' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const id = String(b.key).replace(/^note:/, '');
    const n = (T.ov.note_nodes || {})[id];
    if (!n) { send(res, 404, { ok: false, error: 'unknown note' }); return true; }
    if (!T.ov.judgedAtEpoch) T.ov.judgedAtEpoch = {};
    delete T.ov.judgedAtEpoch['note:' + id];
    T.save(); notifyChange();
    send(res, 200, { ok: true, key: 'note:' + id, requeued: true, autowired: 0 }); return true;
  }

  if (p === '/overlay/note/supersede' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.old_key || !b.new_key) { send(res, 400, { ok: false, error: 'old_key and new_key required' }); return true; }
    const oldId = String(b.old_key).replace(/^note:/, '');
    const newId = String(b.new_key).replace(/^note:/, '');
    const r = overlayStore.supersedeNote(T.ov, oldId, newId, b.at, T.ws);
    if (!r.ok) { send(res, 400, { ok: false, error: r.error }); return true; }
    overlayStore.markForRejudge(T.ov, 'note:' + oldId);
    T.save(); notifyChange();
    send(res, 200, { ok: true, old_key: 'note:' + oldId, new_key: 'note:' + newId, at: r.at }); return true;
  }

  if (p === '/overlay/block' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    overlayStore.setBlocked(T.ov, b.key, b.reason);
    T.save(); notifyChange();
    send(res, 200, { ok: true, key: b.key, blocked: T.ov.blocked[b.key] }); return true;
  }

  if (p === '/overlay/unblock' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const wasBlocked = overlayStore.isBlocked(T.ov, b.key);
    overlayStore.clearBlocked(T.ov, b.key);
    T.save(); notifyChange();
    send(res, 200, { ok: true, key: b.key, was_blocked: wasBlocked }); return true;
  }

  if (p === '/overlay/backfill-embeddings' && m === 'POST') {
    let notesEmbedded = 0, notesSkipped = 0, knEmbedded = 0, knSkipped = 0, failed = 0;
    const gs = state.graphStore || graphStore.open(path.join(state.workspace, '.graph'));
    const ts = new Date().toISOString();
    for (const n of Object.values(state.overlay.note_nodes || {})) {
      if (Array.isArray(n.vec)) { notesSkipped++; continue; }
      const v = await embed(noteEmbedText({ title: n.title, category: n.category, tags: n.tags, summary: n.summary }));
      if (v) {
        n.vec = v; notesEmbedded++;
        graphStore.appendEvent(gs, 'note:' + n.id, { evt: 'note_vec_set', id: n.id, vec: v, actor: 'backfill', ts });
      } else failed++;
    }
    for (const items of Object.values(state.overlay.knowledge || {})) {
      for (const it of (items || [])) {
        if (it && Array.isArray(it._vec)) { knSkipped++; continue; }
        const v = await embed(knowledgeText(it));
        if (v && it && typeof it === 'object') { it._vec = v; knEmbedded++; } else failed++;
      }
    }
    // TASK backfill (multi-vec schema): every real (non-note) task node that lacks a vec gets one
    // from its title+summary. buildGraph yields the authoritative label+summary per node.
    let tasksEmbedded = 0, tasksSkipped = 0;
    const g = buildGraph(state.workspace);
    for (const node of g.tasks) {
      if ((node.kind || 'task') === 'note') continue;
      const existing = state.overlay.taskVecs && state.overlay.taskVecs[node.id];
      if (Array.isArray(existing) && existing.length) { tasksSkipped++; continue; }
      const v = await embed(taskEmbedText({ title: node.label, summary: node.summary }));
      if (v) { overlayStore.setTaskVec(state.overlay, node.id, v); tasksEmbedded++; } else failed++;
    }
    overlayStore.save(state.workspace, state.overlay);
    notifyChange();
    send(res, 200, { ok: true, notes: { embedded: notesEmbedded, skipped: notesSkipped }, knowledge: { embedded: knEmbedded, skipped: knSkipped }, tasks: { embedded: tasksEmbedded, skipped: tasksSkipped }, failed }); return true;
  }

  if (p === '/overlay/reembed' && m === 'POST') {
    const body2 = await readBody(req).catch(() => ({}));
    const force2 = body2 && body2.force;
    let embedded = 0, skipped = 0, failed = 0;
    const gs2 = state.graphStore || graphStore.open(path.join(state.workspace, '.graph'));
    const ts2 = new Date().toISOString();
    for (const n of Object.values(state.overlay.note_nodes || {})) {
      if (!force2 && Array.isArray(n.vec) && n.vec.length === DIMS) { skipped++; continue; }
      const v = await embed(noteEmbedText({ title: n.title, category: n.category, tags: n.tags, summary: n.summary }));
      if (v) { n.vec = v; embedded++; graphStore.appendEvent(gs2, 'note:' + n.id, { evt: 'note_vec_set', id: n.id, vec: v, actor: 'reembed', ts: ts2 }); } else failed++;
    }
    overlayStore.save(state.workspace, state.overlay);
    notifyChange();
    send(res, 200, { ok: true, embedded, skipped, failed }); return true;
  }

  if (p === '/supersede' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.old_key || !b.new_key) { send(res, 400, { ok: false, error: 'old_key and new_key required' }); return true; }
    const note = `superseded by ${b.new_key}${b.reason ? ': ' + b.reason : ''}`;
    overlayStore.setStatus(T.ov, b.old_key, 'canceled', note);
    overlayStore.markForRejudge(T.ov, b.old_key);
    snapshotNative(T.ov, b.old_key);
    overlayStore.addEdge(T.ov, b.old_key, b.new_key, null, 'supersede');
    T.save(); notifyChange();
    send(res, 200, { ok: true, old_key: b.old_key, new_key: b.new_key }); return true;
  }

  return false;
};
