'use strict';
const overlayStore = require('../lib/overlay');
const filedropGc = require('../lib/filedrop-gc');
const judge = require('../lib/judge');
const graphStore = require('../lib/graph-store');
const path = require('path');
const { noteEmbedText } = require('../lib/node-tags');
const newlyReady = require('../lib/newly-ready');
const { requeueStandingHarness } = require('../lib/harness-task');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, sendOp, readBody, notifyChange, buildGraph, state, targetOverlay,
    embed, knowledgeText, snapshotNative, now, suggestToks, scoreNodeAgainstTokens,
    SUGGEST_DUP_THRESHOLD, DIMS } = ctx;

  if (p === '/overlay/edge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.from || !b.to) { send(res, 400, { ok: false, error: 'from and to required' }); return true; }
    overlayStore.addEdge(T.ov, b.from, b.to, b.fromWorkspace, b.kind, b.weight);
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
        a.state === 'running' &&
        a.subagent_session &&
        a.subagent_session === claimSid &&
        a.subagent_session !== a.session
      );
      if (!isSubagent) {
        send(res, 409, { ok: false, error: 'dispatcher sessions cannot claim tasks' }); return true;
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
    if (b.status === 'in_progress' && T.ov.metrics && T.ov.metrics[b.key]) {
      const branch = git.currentBranch(T.ws);
      if (!branch || !branch.startsWith('orch/attempt/')) {
        send(res, 409, { ok: false, error: 'self-learning mode: task has a metric spec — call branch_task first before editing' }); return true;
      }
    }
    const readyBefore = newlyReady.isTerminalStatus(b.status)
      ? newlyReady.readyKeys(buildGraph(T.ws))
      : null;
    if (b.status === 'canceled') T.ov.cancel_requested[b.key] = now();
    else if ((b.force || b.reopen) && cur === 'canceled') delete T.ov.cancel_requested[b.key];
    overlayStore.setStatus(T.ov, b.key, b.status, b.note);
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
    const NATIVE_STATUS = { in_progress: 'in_progress', done: 'completed', tested: 'completed' };
    const ns = NATIVE_STATUS[b.status];
    if (['done', 'tested', 'failed', 'canceled'].includes(b.status)) snapshotNative(T.ov, b.key, ns);
    let followUpResults = null;
    let bucketCleanup = null;
    if (b.status === 'done' && Array.isArray(b.follow_ups) && b.follow_ups.length) {
      followUpResults = followups.apply(T.ov, b.key, b.follow_ups);
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
    const DUP_THRESHOLD = 0.70; // title-vec cosine; see calibration note above
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
      if (bestMatch) {
        send(res, 200, {
          ok: false,
          duplicate: true,
          match: { key: bestMatch.key, title: bestMatch.title, summary: bestMatch.summary, score: Math.round(bestMatch.score * 10000) / 10000 },
          hint: 'Near-duplicate of an existing note. If same fact: do not re-record. If this UPDATES the fact: re-call with supersedes:"' + bestMatch.key + '". If genuinely distinct: re-call with force:true.',
        });
        return true;
      }
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
    T.save(); notifyChange();
    sendOp(res, b, 200, { ok: true, id, key: 'note:' + id, superseded, autowired: 0, hint }); return true;
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
      const v = await embed(n.title || '');
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
    overlayStore.save(state.workspace, state.overlay);
    notifyChange();
    send(res, 200, { ok: true, notes: { embedded: notesEmbedded, skipped: notesSkipped }, knowledge: { embedded: knEmbedded, skipped: knSkipped }, failed }); return true;
  }

  if (p === '/overlay/reembed' && m === 'POST') {
    const body2 = await readBody(req).catch(() => ({}));
    const force2 = body2 && body2.force;
    let embedded = 0, skipped = 0, failed = 0;
    const gs2 = state.graphStore || graphStore.open(path.join(state.workspace, '.graph'));
    const ts2 = new Date().toISOString();
    for (const n of Object.values(state.overlay.note_nodes || {})) {
      if (!force2 && Array.isArray(n.vec) && n.vec.length === DIMS) { skipped++; continue; }
      const v = await embed(n.title || '');
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
    snapshotNative(T.ov, b.old_key);
    overlayStore.addEdge(T.ov, b.old_key, b.new_key, null, 'supersede');
    T.save(); notifyChange();
    send(res, 200, { ok: true, old_key: b.old_key, new_key: b.new_key }); return true;
  }

  return false;
};
