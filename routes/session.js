'use strict';
const path = require('path');
const overlayStore = require('../lib/overlay');
const followups = require('../lib/followups');
const verdicts = require('../lib/verdicts');
const judge = require('../lib/judge');
const { listDispatcherChildren } = require('../lib/dispatcher-children');
const { attributionMeta } = require('../lib/dispatcher-attribution');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, buildGraph, state, targetOverlay,
    stopSignalFor, agentsArr, loops, saveLoops, ESCALATION_DEFAULTS, OPTIMIZE_DEFAULTS } = ctx;

  if (p === '/active-claim') {
    const sid = u.searchParams.get('session');
    const g = buildGraph(state.workspace);
    let all = g.tasks.filter((t) => t.status === 'in_progress').map((t) => ({ key: t.id, label: t.label, session: t.session, agent_id: t.agent_id }));
    if (sid && !all.some((t) => t.session === sid)) {
      for (const t of ctx.harness.tasks.readSessionTasksRaw(sid)) {
        if (t.status === 'in_progress')
          all.push({ key: sid + '/' + t.id, label: t.subject || String(t.id), session: sid, agent_id: null });
      }
    }
    if (sid) {
      for (const t of all.filter((t) => t.session !== sid && t.agent_id && (
        state.agents[t.agent_id]?.subagent_session === sid ||
        // hookless background workers (run_in_background Agent-tool spawns): SubagentStart hook
        // does NOT fire so they self-register via start_task with session=their own UUID.
        // touchAgent nulls subagent_session when it equals session, so match by session+agent_tool_spawn.
        (state.agents[t.agent_id]?.agent_tool_spawn && state.agents[t.agent_id]?.session === sid)
      ))) {
        all.push({ ...t, session: sid });
      }
    }
    if (sid) {
      const T = targetOverlay(null, u);
      const cs = T.ov.claimSessions;
      if (cs) {
        for (const t of all.filter((t) => t.session !== sid)) {
          if (cs[t.key] === sid && !all.some((x) => x.key === t.key && x.session === sid))
            all.push({ ...t, session: sid });
        }
      }
    }
    const claims = sid ? all.filter((t) => t.session === sid) : all;
    send(res, 200, { claimed: claims.length > 0, claims }); return true;
  }

  if (p === '/dispatcher/children') {
    const sid = u.searchParams.get('session');
    if (!sid) { send(res, 400, { error: 'session required' }); return true; }
    const meta = attributionMeta(sid, ctx);
    send(res, 200, { children: listDispatcherChildren(sid, ctx), ...meta }); return true;
  }

  if (p === '/session-info') {
    const sid = u.searchParams.get('session');
    if (!sid) { send(res, 400, { error: 'session required' }); return true; }
    const agents = agentsArr();
    const isSubagent = agents.some((a) =>
      a.state === 'running' &&
      a.subagent_session &&
      a.subagent_session === sid &&
      a.subagent_session !== a.session
    );
    send(res, 200, { session: sid, is_subagent: isSubagent }); return true;
  }

  if (p === '/should-stop') {
    const sid = u.searchParams.get('session');
    const actor = u.searchParams.get('agent') || null;
    const sig = stopSignalFor(sid, { actor, hook: true });
    send(res, 200, sig ? { stop: true, ...sig } : { stop: false }); return true;
  }

  if (p === '/config' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (b.test_cmds && typeof b.test_cmds === 'object') {
      const bad = Object.keys(b.test_cmds).find((rp) => !path.isAbsolute(rp));
      if (bad) { send(res, 400, { ok: false, error: `test_cmds keys must be absolute repo paths: got "${bad}"` }); return true; }
      for (const [rp, cmd] of Object.entries(b.test_cmds)) overlayStore.setTestCmd(T.ov, rp, cmd);
    }
    if (b.require_review != null) T.ov.config.require_review = !!b.require_review;
    if (b.self_plan != null) T.ov.config.self_plan = !!b.self_plan;
    if (b.cost_gate != null) T.ov.config.cost_gate = !!b.cost_gate;
    if (b.stale_minutes != null) T.ov.config.stale_minutes = Number(b.stale_minutes);
    if (b.archive_after_days != null) T.ov.config.archive_after_days = Number(b.archive_after_days);
    if (b.escalation && typeof b.escalation === 'object') {
      const cur = T.ov.config.escalation || ESCALATION_DEFAULTS();
      for (const k of Object.keys(ESCALATION_DEFAULTS())) if (b.escalation[k] != null) cur[k] = !!b.escalation[k];
      T.ov.config.escalation = cur;
    }
    if (b.optimize && typeof b.optimize === 'object') {
      const cur = { ...OPTIMIZE_DEFAULTS(), ...(T.ov.config.optimize || {}) };
      if (b.optimize.epsilon != null) cur.epsilon = Number(b.optimize.epsilon);
      if (b.optimize.diminishing_rounds != null) cur.diminishing_rounds = Number(b.optimize.diminishing_rounds);
      T.ov.config.optimize = cur;
    }
    T.save();
    send(res, 200, { ok: true, config: T.ov.config }); return true;
  }

  if (p === '/guidance' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.question) { send(res, 400, { ok: false, error: 'question required' }); return true; }

    // SEAM: gate the escalation BEFORE it reaches the user. request_guidance is meant to be a LAST
    // RESORT — so first run the ask-vs-predict gate over the question + recalled preference notes
    // (the same recall+gate+journal path POST /ask-gate uses). A confident, specific, project-local
    // preference match auto-resolves the question from that note (predicted answer + provenance,
    // journaled) WITHOUT touching the pending guidance queue or pausing the loop. Hard-override
    // triggers (irreversible/outward/high-impact/scope/repeated-failure) can never predict — the
    // gate forces 'ask', so they always escalate. Only plain question escalations are gated;
    // structured action-guidance (dup-cluster, follow-up approval) is daemon-internal, not a
    // user-preference question, so it bypasses. Pass gate:false to bypass explicitly.
    // (A) ORIGIN BINDING: resolve the claiming task (the requester's in_progress claim) so the
    // staleness sweep can auto-resolve this escalation once that task completes. recalledNotes holds
    // the note keys the ask-gate recalled (populated below) so a superseded trigger note also clears it.
    const originTask = (() => {
      const sid = b.session_id || u.searchParams.get('session');
      if (!sid) return null;
      const g = buildGraph(T.ws);
      const claim = g.tasks.find((t) => t.status === 'in_progress' && t.session === sid);
      return claim ? claim.id : null;
    })();
    let recalledNotes = [];

    const gateable = b.gate !== false && !b.action;
    if (gateable) {
      const flags = {
        irreversible: !!b.irreversible, outward: !!(b.outward || b.outwardFacing),
        highImpact: !!b.highImpact, scopeExpansion: !!b.scopeExpansion, repeatedFailure: !!b.repeatedFailure,
      };
      const decision = b.context ? `${b.question}\n${b.context}` : b.question;
      const { runAskGate, answeredDownstream } = require('../lib/ask-gate-recall');
      const r = await runAskGate(ctx, T.ws, { decision, flags, tags: b.tags, seam: 'guidance' });
      if (r.topKey) recalledNotes = [String(r.topKey).replace(/^note:/, '')];
      if (r.decision === 'predict') {
        // Auto-answer from the matched preference note. Record a RESOLVED guidance item carrying the
        // predicted answer + provenance (so the dashboard shows what was decided and why) — it never
        // enters the pending queue and never pauses the loop. The verdict is already journaled.
        const provenance = { key: r.topKey, title: r.appliedNote && (r.appliedNote.title || r.appliedNote.label) || null, summary: r.appliedNote && r.appliedNote.summary || null };
        const answer = provenance.summary || provenance.title || '';
        const id = overlayStore.addGuidance(T.ov, { question: b.question, context: b.context, trigger: b.trigger, severity: b.severity, origin_task: originTask, origin_notes: recalledNotes });
        overlayStore.annotateGuidance(T.ov, id, { predicted: true, predictedFrom: provenance, gateReason: r.reason });
        overlayStore.resolveGuidance(T.ov, id, answer);
        T.save(); notifyChange();
        send(res, 200, { ok: true, id, predicted: true, answer, appliedNote: provenance, reason: r.reason }); return true;
      }
      // ANSWERED-DOWNSTREAM (EL-2/D, fix Mode-1 over-escalation): the preference pass said ASK, but
      // the answer may already live in the graph as a DECISION/CORRECTION note the preference pool
      // never consults. Run a SECOND, stricter recall pass over that pool; on a confident "already
      // answered" hit, auto-resolve the question from that note instead of pausing the loop — same
      // predicted:true shape as above. CONSERVATIVE by design (a wrong hit silently drops a real
      // question), and hard-override questions are short-circuited inside answeredDownstream so they
      // ALWAYS escalate regardless of any note match.
      const ds = await answeredDownstream(ctx, T.ws, { decision, flags, tags: b.tags, seam: 'guidance' });
      if (ds) {
        if (ds.provenance.key) recalledNotes = [String(ds.provenance.key).replace(/^note:/, '')];
        const id = overlayStore.addGuidance(T.ov, { question: b.question, context: b.context, trigger: b.trigger, severity: b.severity, origin_task: originTask, origin_notes: recalledNotes });
        overlayStore.annotateGuidance(T.ov, id, { predicted: true, predictedFrom: ds.provenance, gateReason: ds.reason });
        overlayStore.resolveGuidance(T.ov, id, ds.answer);
        T.save(); notifyChange();
        send(res, 200, { ok: true, id, predicted: true, answer: ds.answer, appliedNote: ds.provenance, reason: ds.reason }); return true;
      }
      // r.decision === 'ask' AND no downstream answer → fall through to the normal escalation below.
    }

    const id = overlayStore.addGuidance(T.ov, { question: b.question, context: b.context, trigger: b.trigger, severity: b.severity, origin_task: originTask, origin_notes: recalledNotes });
    const effectiveSeverity = b.severity === 'review' ? 'review' : 'blocking';
    if (effectiveSeverity !== 'review') { for (const L of loops.values()) L.active = false; saveLoops(); }
    T.save(); notifyChange();
    send(res, 200, { ok: true, id }); return true;
  }

  if (p === '/guidance' && m === 'GET') {
    const T = targetOverlay(null, u);
    const settled = judge.resolveSettledClusterGuidance(T.ov);
    if (settled.length) { T.save(); notifyChange(); }
    const all = overlayStore.pendingGuidance(T.ov);
    send(res, 200, { pending: all.filter((g) => g.severity !== 'review'), review: all.filter((g) => g.severity === 'review') }); return true;
  }

  if (p === '/guidance/resolve' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const item = Array.isArray(T.ov.guidance) ? T.ov.guidance.find((g) => g.id === b.id) : null;
    if (!item) { send(res, 404, { ok: false, error: 'unknown guidance id' }); return true; }
    const action = item.action || null;
    const result = { ok: true };
    if (action && action.kind === 'dup-cluster' && (b.decision === 'consolidate' || b.decision === 'distinct')) {
      const keys = (action.keys || []).map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k);
      if (b.decision === 'distinct') {
        overlayStore.markClusterDistinct(T.ov, keys);
        result.decision = 'distinct';
      } else {
        let keepKeyRaw = b.keep ? String(b.keep) : null;
        if (!keepKeyRaw) {
          const sorted = keys.slice().sort((ka, kb) => {
            const na = T.ov.note_nodes[ka.replace(/^note:/, '')];
            const nb = T.ov.note_nodes[kb.replace(/^note:/, '')];
            return Date.parse((na && na.created_at) || 0) - Date.parse((nb && nb.created_at) || 0);
          });
          keepKeyRaw = sorted[sorted.length - 1] || keys[0];
        }
        const keep = String(keepKeyRaw).replace(/^note:/, '');
        const keepKey = 'note:' + keep;
        const supersededNow = [];
        for (const oldKey of keys) {
          if (oldKey === keepKey) continue;
          const oldId = String(oldKey).replace(/^note:/, '');
          const r = overlayStore.supersedeNote(T.ov, oldId, keep, undefined, T.ws);
          if (r && r.ok) supersededNow.push('note:' + oldId);
        }
        overlayStore.repointEdges(T.ov, supersededNow, keepKey);
        if (!T.ov.judgedClusters) T.ov.judgedClusters = {};
        const judge = require('../lib/judge');
        judge.stampCluster(T.ov.judgedClusters, [keepKey, ...supersededNow], T.ov.epoch || 0);
        result.decision = 'consolidate'; result.keep = keepKey; result.superseded = supersededNow;
      }
      overlayStore.resolveGuidance(T.ov, b.id, b.decision);
    } else if (action && action.kind === 'follow-up') {
      let decision = (b.decision === 'approve' || b.decision === 'reject') ? b.decision : null;
      if (!decision && b.answer != null) {
        const ans = String(b.answer).trim().toLowerCase();
        if (/^(approve|approved|yes|ok|okay|y)$/.test(ans)) decision = 'approve';
        else if (/^(reject|rejected|no|n)$/.test(ans)) decision = 'reject';
      }
      if (!decision) {
        send(res, 400, { ok: false, error: 'follow-up requires Approve or Reject (typed answers: approve/yes or reject/no)' });
        return true;
      }
      const fr = followups.resolveGate(T.ov, action, decision);
      if (fr) Object.assign(result, fr);
      result.decision = decision;
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : decision);
    } else if (action && action.kind === 'stale-hold' && (b.decision === 'release' || b.decision === 'keep')) {
      const sr = verdicts.resolveStaleHold(T.ov, action, b.decision, b.answer);
      if (sr) Object.assign(result, sr);
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : b.decision);
    } else if (action && action.kind === 'force_claim_cap') {
      // Dashboard-only approval: reset the force-claim counter for this task so the agent can retry.
      if (T.ov.forceClaims && action.taskKey) delete T.ov.forceClaims[action.taskKey];
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : (b.decision || 'approved'));
      result.reset_task_key = action.taskKey;
    } else if (action && action.kind === 'cost_gate' && (b.decision === 'approve' || b.decision === 'reject')) {
      // Cost-gate approval: 'approve' unblocks the task so the loop can spawn it; 'reject' keeps it
      // blocked (the block was set when the guidance was filed — nothing to do on reject).
      if (b.decision === 'approve' && action.taskKey) {
        overlayStore.clearBlocked(T.ov, action.taskKey);
        result.unblocked_task_key = action.taskKey;
      }
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : b.decision);
      result.decision = b.decision;
    } else {
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : b.decision);
    }
    const healed = followups.healOrphanHolds(T.ov);
    if (healed.length) result.healed_orphan_holds = healed;
    T.save(); notifyChange();
    result.pending = overlayStore.pendingGuidance(T.ov).length;
    send(res, 200, result); return true;
  }

  return false;
};
