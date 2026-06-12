'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const overlayStore = require('../lib/overlay');
const followups = require('../lib/followups');
const verdicts = require('../lib/verdicts');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, buildGraph, state, targetOverlay,
    stopSignalFor, agentsArr, loops, saveLoops, ESCALATION_DEFAULTS, OPTIMIZE_DEFAULTS } = ctx;

  if (p === '/active-claim') {
    const sid = u.searchParams.get('session');
    const g = buildGraph(state.workspace);
    let all = g.tasks.filter((t) => t.status === 'in_progress').map((t) => ({ key: t.id, label: t.label, session: t.session, agent_id: t.agent_id }));
    if (sid && !all.some((t) => t.session === sid)) {
      const sessionDir = path.join(os.homedir(), '.claude', 'tasks', sid);
      try {
        for (const f of fs.readdirSync(sessionDir).filter((f) => f.endsWith('.json'))) {
          try {
            const t = JSON.parse(fs.readFileSync(path.join(sessionDir, f), 'utf8'));
            if (t && t.status === 'in_progress')
              all.push({ key: sid + '/' + t.id, label: t.subject || String(t.id), session: sid, agent_id: null });
          } catch { /* skip */ }
        }
      } catch { /* no tasks for session */ }
    }
    if (sid) {
      for (const t of all.filter((t) => t.session !== sid && t.agent_id && state.agents[t.agent_id]?.subagent_session === sid)) {
        all.push({ ...t, session: sid });
      }
    }
    const claims = sid ? all.filter((t) => t.session === sid) : all;
    send(res, 200, { claimed: claims.length > 0, claims }); return true;
  }

  if (p === '/session-info') {
    const sid = u.searchParams.get('session');
    if (!sid) { send(res, 400, { error: 'session required' }); return true; }
    const agents = agentsArr();
    const isSubagent = agents.some((a) => a.subagent_session === sid);
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
    const id = overlayStore.addGuidance(T.ov, { question: b.question, context: b.context, trigger: b.trigger, severity: b.severity });
    const effectiveSeverity = b.severity === 'review' ? 'review' : 'blocking';
    if (effectiveSeverity !== 'review') { for (const L of loops.values()) L.active = false; saveLoops(); }
    T.save(); notifyChange();
    send(res, 200, { ok: true, id }); return true;
  }

  if (p === '/guidance' && m === 'GET') {
    const all = overlayStore.pendingGuidance(targetOverlay(null, u).ov);
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
    } else if (action && action.kind === 'follow-up' && (b.decision === 'approve' || b.decision === 'reject')) {
      const fr = followups.resolveGate(T.ov, action, b.decision);
      if (fr) Object.assign(result, fr);
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : b.decision);
    } else if (action && action.kind === 'stale-hold' && (b.decision === 'release' || b.decision === 'keep')) {
      const sr = verdicts.resolveStaleHold(T.ov, action, b.decision, b.answer);
      if (sr) Object.assign(result, sr);
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : b.decision);
    } else if (action && action.kind === 'force_claim_cap') {
      // Dashboard-only approval: reset the force-claim counter for this task so the agent can retry.
      if (T.ov.forceClaims && action.taskKey) delete T.ov.forceClaims[action.taskKey];
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : (b.decision || 'approved'));
      result.reset_task_key = action.taskKey;
    } else {
      overlayStore.resolveGuidance(T.ov, b.id, b.answer != null ? b.answer : b.decision);
    }
    T.save(); notifyChange();
    result.pending = overlayStore.pendingGuidance(T.ov).length;
    send(res, 200, result); return true;
  }

  return false;
};
