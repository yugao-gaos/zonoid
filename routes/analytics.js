'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const overlayStore = require('../lib/overlay');
const costflow = require('../lib/costflow');
const usageAccounting = require('../lib/usage-accounting');
const { readLocalClaim } = require('../lib/git-claims');
const { agreementRate } = require('../lib/shadow-journal');
const { getPromotionState } = require('../lib/promotion-gate');
const { estimatedSavings } = require('../lib/economy');

function sessionsFromOverlay(ov) {
  const snap = ov && ov.usage_reconcile_snapshot;
  if (snap && Array.isArray(snap.sessions) && snap.sessions.length) return snap.sessions;
  const bySession = new Map();
  for (const slice of Object.values((ov && ov.usage_records) || {})) {
    if (!slice || !slice.session_id) continue;
    const prev = bySession.get(slice.session_id) || { id: slice.session_id, total: 0, claimed: 0 };
    prev.total += (slice.usage && slice.usage.output_tokens) || 0;
    bySession.set(slice.session_id, prev);
  }
  return [...bySession.values()];
}

function claimedOutputForSession(session, claims, ownTok) {
  if (!session || !session.id) return 0;
  const sid = session.id;
  const transcript = session.path || session.transcript_path || session.transcript || null;
  let total = 0;
  for (const c of claims || []) {
    if (!c || !c.id) continue;
    const claimTranscript = c.transcript || c.transcript_path || c.path || null;
    const matchesTranscript = claimTranscript && (transcript ? claimTranscript === transcript : claimTranscript === sid);
    const matchesSession = !claimTranscript && c.session && c.session === sid;
    if (matchesTranscript || matchesSession) {
      total += ownTok.get(c.id) || 0;
    }
  }
  return total;
}

function nonEmptyString(raw) {
  const value = String(raw == null ? '' : raw).trim();
  return value || null;
}

function normalizeSessionRef(raw) {
  const value = nonEmptyString(raw);
  if (!value) return null;
  const base = path.basename(value, path.extname(value)).replace(/^rollout-/, '');
  return nonEmptyString(base);
}

function sessionUuidSuffix(raw) {
  const value = normalizeSessionRef(raw);
  if (!value) return null;
  const m = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return m ? m[0] : null;
}

function addSessionRepresentation(out, raw) {
  const value = nonEmptyString(raw);
  if (!value) return;
  out.add(value);
  const normalized = normalizeSessionRef(value);
  if (normalized) out.add(normalized);
  const suffix = sessionUuidSuffix(value);
  if (suffix) out.add(suffix);
}

function representedSessionIds(sessions) {
  const out = new Set();
  for (const s of sessions || []) {
    if (!s) continue;
    addSessionRepresentation(out, s.id);
    addSessionRepresentation(out, s.session_id);
    addSessionRepresentation(out, s.path);
    addSessionRepresentation(out, s.transcript_path);
    addSessionRepresentation(out, s.transcript);
  }
  return out;
}

function sessionGroupingKey(session) {
  if (!session) return null;
  return nonEmptyString(session.path)
    || nonEmptyString(session.transcript_path)
    || nonEmptyString(session.transcript)
    || nonEmptyString(session.id)
    || nonEmptyString(session.session_id);
}

function representedSessionIndex(sessions) {
  const byRef = new Map();
  for (const s of sessions || []) {
    const key = sessionGroupingKey(s);
    if (!key) continue;
    const refs = new Set();
    addSessionRepresentation(refs, s.id);
    addSessionRepresentation(refs, s.session_id);
    addSessionRepresentation(refs, s.path);
    addSessionRepresentation(refs, s.transcript_path);
    addSessionRepresentation(refs, s.transcript);
    for (const ref of refs) if (!byRef.has(ref)) byRef.set(ref, s);
  }
  return { byRef };
}

function representedSessionRow(index, raw) {
  if (!index) return null;
  const value = nonEmptyString(raw);
  if (!value) return null;
  if (index.byRef.has(value)) return index.byRef.get(value);
  const normalized = normalizeSessionRef(value);
  if (normalized && index.byRef.has(normalized)) return index.byRef.get(normalized);
  const suffix = sessionUuidSuffix(value);
  return suffix ? (index.byRef.get(suffix) || null) : null;
}

function sessionSnapshotTotal(session) {
  if (!session) return null;
  const total = Number(session.total);
  return Number.isFinite(total) ? Math.max(0, total) : null;
}

function sessionIsRepresented(represented, raw) {
  if (!represented) return true;
  const value = nonEmptyString(raw);
  if (!value) return false;
  if (represented.has(value)) return true;
  const normalized = normalizeSessionRef(value);
  if (normalized && represented.has(normalized)) return true;
  const suffix = sessionUuidSuffix(value);
  return !!(suffix && represented.has(suffix));
}

function attributionSessionForTask(repo, ov, task, represented) {
  const id = task && task.id;
  const graphSession = nonEmptyString(task && task.session);
  const overlaySession = id && ov && ov.claimSessions && nonEmptyString(ov.claimSessions[id]);
  if (overlaySession) return sessionIsRepresented(represented, overlaySession) ? overlaySession : graphSession;
  const durableClaim = id ? readLocalClaim(repo, id) : null;
  const durableSession = durableClaim && nonEmptyString(durableClaim.session_id);
  if (durableSession) return sessionIsRepresented(represented, durableSession) ? durableSession : graphSession;
  return graphSession;
}

function harnessNameForWorkspace(state, ov, workspace, fallback) {
  const sessions = Object.values((state && state.sessions) || {})
    .filter((s) => s && s.workspace === workspace && s.harness)
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  if (sessions.length) return sessions[0].harness;
  if (ov && ov.usage_reconcile_snapshot && ov.usage_reconcile_snapshot.harness) return ov.usage_reconcile_snapshot.harness;
  if (process.env.ZONOID_HARNESS) return process.env.ZONOID_HARNESS;
  return fallback || 'claude';
}

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, buildGraph, state, targetOverlay, taskTranscript, usageCached,
    respCacheGet, respCachePut, isTruthy, now, harness, harnessRegistry } = ctx;

  if (p === '/costflow' && m === 'GET') {
    const cfWs = u.searchParams.get('workspace');
    if (!cfWs) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const T = targetOverlay(null, u);
    const harnessName = harnessNameForWorkspace(state, T.ov, T.ws, harness && harness.name);
    let activeHarness = harness;
    try { if (harnessRegistry && harnessName) activeHarness = harnessRegistry.get(harnessName); } catch { activeHarness = harness; }
    const cfKey = `costflow|${cfWs}|${harnessName}|${u.searchParams.get('since') || ''}`;
    const cfHit = respCacheGet(cfWs, cfKey);
    if (cfHit !== undefined) { send(res, 200, cfHit); return true; }
    const g = buildGraph(T.ws);
    const stWs = { ...state, overlay: T.ov };
    const sessList = sessionsFromOverlay(T.ov);
    const representedSessions = representedSessionIds(sessList);
    const representedIndex = representedSessionIndex(sessList);
    const claims = g.tasks.filter((t) => t.kind !== 'note').map((t) => {
      const session = attributionSessionForTask(T.ws, T.ov, t, representedSessions);
      const snapshotSession = representedSessionRow(representedIndex, session);
      const snapshotTranscript = sessionGroupingKey(snapshotSession);
      return {
        id: t.id,
        session,
        transcript: taskTranscript(t.id, session, true, stWs) || snapshotTranscript,
        snapshot_session: snapshotSession,
        window: { start: t.firstSeen, end: t.lastChanged },
        work_sessions: (T.ov.work_sessions && T.ov.work_sessions[t.id]) || null,
      };
    });
    const tr = activeHarness.transcripts;
    const taskUsageFromAgent = tr.taskUsageFromAgent || (() => null);
    const usageOutputOnly = (tp, claim) => {
      if (claim && claim.id) {
        const fromRec = usageAccounting.taskOutputFromRecords(T.ov, claim.id);
        if (fromRec > 0) return { total: fromRec, task_specific: true };
      }
      const snapshotSession = (claim && claim.snapshot_session)
        || representedSessionRow(representedIndex, tp)
        || representedSessionRow(representedIndex, claim && claim.session);
      const snapshotTotal = sessionSnapshotTotal(snapshotSession);
      if (snapshotTotal != null) return { total: snapshotTotal };
      if (tp) {
        if (activeHarness && activeHarness.name === 'codex' && activeHarness.usage && typeof activeHarness.usage.sample === 'function') {
          const slice = activeHarness.usage.sample(tp, { transcript_path: tp });
          return { total: (slice && slice.usage && slice.usage.output_tokens) || 0 };
        }
        const u2 = usageCached(tp);
        return { total: (u2 && u2.output_tokens) || 0 };
      }
      const aid = claim && claim.id && stWs.overlay.assignee[claim.id];
      const agent = aid && stWs.agents && stWs.agents[aid];
      const ru = agent && taskUsageFromAgent(agent);
      return { total: (ru && ru.output_tokens) || 0 };
    };
    const ownTok = costflow.splitSessionTokens(claims, usageOutputOnly);
    const merged = usageAccounting.sumUsageRecords(T.ov);
    let rawInput = merged.totals.input_tokens || 0;
    let rawOutput = merged.totals.output_tokens || 0;
    let rawCacheRead = merged.totals.cache_read_input_tokens || 0;
    const rawByModel = merged.totals.by_model || {};
    const supersededIds = new Set((T.ov.edges || []).filter(e => e.kind === 'supersede').map(e => e.from));
    const isExplorationTask = (t) => t.kind === 'note' || supersededIds.has(t.id) || t.status === 'canceled' || t.status === 'failed' || !!(t.git && t.git.branch && t.git.branch.startsWith('orch/attempt/'));
    let mergedBranches = null;
    try {
      const out = execFileSync('git', ['-C', T.ws, 'branch', '--merged', 'HEAD'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      mergedBranches = new Set(out.split('\n').map(b => b.replace(/^\*?\s+/, '').trim()).filter(Boolean));
    } catch { mergedBranches = new Set(); }
    let overlayDirty = false;
    const nodes = g.tasks.map((t) => {
      let merged = !!(t.git && t.git.merged);
      if (!merged && t.git && t.git.branch && mergedBranches && mergedBranches.has(t.git.branch)) {
        merged = true;
        overlayStore.setGit(T.ov, t.id, { merged: true, merged_at: now() });
        overlayDirty = true;
      }
      return { id: t.id, own: ownTok.get(t.id) || 0, merged, exploration: isExplorationTask(t), label: t.label };
    });
    if (overlayDirty) { T.save(); ctx.notifyChange(); }
    const seen = new Set(nodes.map((n) => n.id));
    for (const gh of g.ghosts) {
      const gid = `ghost:${gh.workspace}|${gh.key}`;
      if (!seen.has(gid)) { nodes.push({ id: gid, own: 0, merged: false, label: gh.label || '' }); seen.add(gid); }
    }
    const edges = [];
    for (const t of g.tasks) {
      for (const d of t.deps || []) if (seen.has(d)) edges.push({ from: d, to: t.id, weight: 1 });
      for (const d of t.context_deps || []) if (seen.has(d)) edges.push({ from: d, to: t.id, weight: (t.context_weights && t.context_weights[d]) ?? overlayStore.DEFAULT_CONTEXT_WEIGHT });
    }
    const sessions = sessList.map((s) => {
      const id = s.id;
      const sessTotal = s.total;
      let total = sessTotal || 0;
      if (!total) {
        const recTotal = [...Object.values(T.ov.usage_records || {})]
          .filter((s) => s && s.session_id === id)
          .reduce((sum, s) => sum + ((s.usage && s.usage.output_tokens) || 0), 0);
        total = recTotal;
      }
      return { id, total, claimed: claimedOutputForSession(s, claims, ownTok) };
    });
    const catchalls = costflow.sessionCatchalls(sessions, g.tasks, overlayStore.DEFAULT_CONTEXT_WEIGHT);
    for (const cn of catchalls.nodes) if (!seen.has(cn.id)) { nodes.push(cn); seen.add(cn.id); }
    for (const ce of catchalls.edges) if (seen.has(ce.from) && seen.has(ce.to)) edges.push(ce);
    const CATCHALL_ESCALATE_TOKENS = ctx.CATCHALL_ESCALATE_TOKENS;
    const escalated = new Set((T.ov.guidance || []).map((gd) => gd.sessionKey).filter(Boolean));
    let escDirty = false;
    for (const cn of catchalls.nodes) {
      if (cn.own < CATCHALL_ESCALATE_TOKENS || catchalls.edges.some((e) => e.from === cn.id)) continue;
      const sid = cn.id.slice('session:'.length);
      if (escalated.has(sid)) continue;
      const gid = overlayStore.addGuidance(T.ov, {
        question: `Session ${sid.slice(0, 8)} burned ${(cn.own / 1e6).toFixed(1)}M tokens with zero graph-visible outputs. Real waste, or missing task nodes?`,
        context: `cost-flow catch-all: ${Math.round(cn.own)} unattributed tokens in main-session transcript ${sid}.jsonl and no task/note created by that session. Either the work evaporated (waste) or it produced something the graph never captured (record it as a task/note so the cost can flow).`,
        trigger: 'low_confidence_high_impact', severity: 'review',
      });
      const item = (T.ov.guidance || []).find((x) => x.id === gid);
      if (item) item.sessionKey = sid;
      escalated.add(sid); escDirty = true;
    }
    if (escDirty) { T.save(); ctx.notifyChange(); }
    const flow = costflow.computeFlow(nodes, edges);
    const human = merged.human || { tokens: 0, files: 0 };
    const rnd = (x) => Math.round(x);
    const explorationIds = new Set(g.tasks.filter(isExplorationTask).map((t) => t.id));
    const kindOf = (id) => (id.startsWith('session:') ? 'session' : undefined);
    const wasteExploration = [], wasteTrapped = [];
    for (const w of flow.waste) {
      const isExp = explorationIds.has(w.task) ||
        (w.members && w.members.length > 0 && w.members.every((m2) => explorationIds.has(m2)));
      (isExp ? wasteExploration : wasteTrapped).push(w);
    }
    const productive = rnd(flow.totals.productive);
    const explorationTok = rnd(wasteExploration.reduce((s, w) => s + w.trapped, 0));
    const trappedTok = rnd(wasteTrapped.reduce((s, w) => s + w.trapped, 0));
    // gross_totals: BILLING basis — Σ by_model (gross, pre-baseline). Reconciles exactly with by_model rows.
    // totals.*: ATTRIBUTION basis — net-of-baseline delta. Used for token-economy, productivity%, autonomy.
    const byModelEmit = Object.fromEntries(Object.entries(rawByModel).map(([m2,v])=>[m2,{input_tokens:rnd(v.input_tokens),output_tokens:rnd(v.output_tokens),cache_read:rnd(v.cache_read_input_tokens)}]));
    const grossTotals = Object.values(byModelEmit).reduce((acc, v) => {
      acc.input_tokens += v.input_tokens || 0;
      acc.output_tokens += v.output_tokens || 0;
      acc.cache_read += v.cache_read || 0;
      return acc;
    }, { input_tokens: 0, output_tokens: 0, cache_read: 0 });
    send(res, 200, respCachePut(cfWs, cfKey, {
      workspace: T.ws,
      autonomy_score: human.tokens > 0 ? Math.round((flow.totals.productive / human.tokens) * 10) / 10 : null,
      human,
      // totals: net-of-baseline (DELTA/attribution) — token-economy, productivity%, autonomy
      totals: { total: productive + explorationTok + trappedTok, productive, exploration: explorationTok, trapped: trappedTok, input_tokens: rnd(rawInput), output_tokens: rnd(rawOutput), cache_read: rnd(rawCacheRead) },
      // gross_totals: gross/pre-baseline (BILLING) — Σ by_model, for billing %, plan quota, "X% of output"
      gross_totals: grossTotals,
      by_model: byModelEmit,
      // cost: DOLLAR overlay (CDX-3). Daemon SUMS already-computed per-slice cost.usd (adapter-priced
      // from pricing.json); it does NOT price here. source is weakest-wins ('estimated' if any
      // contributing slice was a chars/4 estimate, else 'real'). ADDITIVE to the token figures above.
      cost: { usd: Math.round(((merged.cost && merged.cost.usd) || 0) * 100) / 100, source: (merged.cost && merged.cost.source) || 'real', by_model: (merged.cost && merged.cost.by_model) || {} },
      sessions: { count: catchalls.nodes.length, unattributed: rnd(catchalls.nodes.reduce((s, n) => s + n.own, 0)) },
      results: flow.results.map((r) => ({ task: r.task, kind: kindOf(r.task), label: r.label, members: r.members.length > 1 ? r.members : undefined, T: rnd(r.T), own: rnd(r.own), inherited: rnd(r.inherited) })),
      waste: wasteTrapped.map((w) => ({ task: w.task, kind: kindOf(w.task), label: w.label, members: w.members.length > 1 ? w.members : undefined, trapped: rnd(w.trapped) })),
      exploration: wasteExploration.map((w) => ({ task: w.task, kind: kindOf(w.task), label: w.label, members: w.members.length > 1 ? w.members : undefined, tokens: rnd(w.trapped) })),
    })); return true;
  }

  if (p === '/harness/overhead' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace set' }); return true; }
    const merged = usageAccounting.sumUsageRecords(T.ov);
    const overhead = usageAccounting.sumOverhead(T.ov);
    const human = merged.human || { tokens: 0, chars: 0, messages: 0, dropped: 0 };
    const totalSessionInput = (merged.totals.input_tokens || 0) + (merged.totals.cache_read_input_tokens || 0);
    const system_reminder_est = Math.max(0, totalSessionInput - overhead.tokens - human.tokens);

    // self_maintenance: aggregate output_tokens attributed to tasks whose label starts with
    // "harness:" — these are recurrent self-maintenance tasks (e.g. judge drain). Uses the same
    // output_tokens convention as the bench methodology and costflow's usageOutputOnly split.
    // Added as a new field; existing fields are unchanged (backward-compatible).
    let selfMaintenanceTokens = 0;
    try {
      const g = buildGraph(T.ws);
      const usageOutputOnly = (tp, claim) => {
        if (claim && claim.id) {
          const fromRec = usageAccounting.taskOutputFromRecords(T.ov, claim.id);
          if (fromRec > 0) return { total: fromRec, task_specific: true };
        }
        const u2 = usageCached(tp);
        return { total: (u2 && u2.output_tokens) || 0 };
      };
      const harnessTaskIds = g.tasks
        .filter((t) => t.kind !== 'note' && typeof t.label === 'string' && t.label.startsWith('harness:'))
        .map((t) => t.id);
      if (harnessTaskIds.length > 0) {
        const stWs = { ...state, overlay: T.ov };
        const claims = harnessTaskIds.map((id) => {
          const t = g.tasks.find((x) => x.id === id);
          return { id, transcript: taskTranscript(id, t && t.session, true, stWs), window: { start: t && t.firstSeen, end: t && t.lastChanged } };
        });
        const ownTok = costflow.splitSessionTokens(claims, usageOutputOnly);
        for (const id of harnessTaskIds) selfMaintenanceTokens += ownTok.get(id) || 0;
      }
    } catch { /* best effort — never fail the response */ }

    send(res, 200, { overhead, human, total_input_est: overhead.tokens + human.tokens, total_session_input: totalSessionInput, system_reminder_est, harness_fraction: totalSessionInput > 0 ? Math.round(((overhead.tokens + system_reminder_est) / totalSessionInput) * 1000) / 1000 : 0, self_maintenance: { tokens: Math.round(selfMaintenanceTokens), description: 'output_tokens attributed to harness-prefixed self-maintenance tasks (e.g. judge drain)' } }); return true;
  }

  // Per-node judging-cost rollup: sums output_tokens from usage slices whose judged_node equals
  // the requested node key. Only node-scoped eager dispatches carry judged_node; non-node-scoped
  // harness drain slices lack it and stay pooled on the harness bucket (unchanged). The existing
  // per-task_key rollup (/costflow) is also unaffected.
  // ?node=<key>        — cost for a specific node
  // (no ?node)         — cost for ALL nodes that have at least one attributed slice
  if (p === '/judge/node-cost' && m === 'GET') {
    const T = targetOverlay(null, u);
    const nodeKey = u.searchParams.get('node') || null;
    const records = Object.values((T.ov && T.ov.usage_records) || {});
    if (nodeKey) {
      const output_tokens = usageAccounting.judgeNodeOutputFromRecords(T.ov, nodeKey);
      send(res, 200, { node: nodeKey, output_tokens }); return true;
    }
    // Aggregate all nodes that appear as judged_node on any slice.
    const byNode = {};
    for (const slice of records) {
      if (!slice || !slice.judged_node) continue;
      const k = slice.judged_node;
      byNode[k] = (byNode[k] || 0) + ((slice.usage && slice.usage.output_tokens) || 0);
    }
    send(res, 200, { by_node: byNode }); return true;
  }

  // Rework-aware per-task cost rollup. Accumulates across ALL agent-run finishes that touched a
  // task (worker re-runs after kick-back + judge runs), role-tagged implementation vs review, so
  // cost(task) = Σimpl + Σreview and rework is visible. Source: ov.task_costs, populated on every
  // /agent/done (decoupled from terminal complete_task). Tokens are daemon-parsed from the agent
  // transcript by claim-window correlation (the 2b42bcb mechanism) — no trust on agent self-count.
  // ?task=<key>  — rollup for one task: { task_key, impl_tokens, review_tokens, total, attempts }
  // (no ?task)   — { tasks: [ ...rollups ] } for every task with at least one contribution
  if (p === '/task/cost' && m === 'GET') {
    const T = targetOverlay(null, u);
    const taskKey = u.searchParams.get('task') || null;
    if (taskKey) {
      const roll = usageAccounting.taskCost(T.ov, taskKey)
        || { task_key: taskKey, impl_tokens: 0, review_tokens: 0, total: 0, attempts: 0 };
      send(res, 200, roll); return true;
    }
    const tasks = Object.keys((T.ov && T.ov.task_costs) || {})
      .map((k) => usageAccounting.taskCost(T.ov, k))
      .filter(Boolean);
    send(res, 200, { tasks }); return true;
  }

  // GET /metrics/agreement — agreement rate between learned shadow model and Sonnet's verdict.
  // Reads the last ?window= (default 200) rows from .graph/shadow-journal.jsonl and computes
  // the fraction where shadow_verdict === verdict.
  // Response: { ok, agreement: { total, agreed, rate, window_used, window } | null }
  if (p === '/metrics/agreement' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required — pass ?workspace=' }); return true; }
    const windowParam = parseInt(u.searchParams.get('window') || '200', 10);
    const win = (Number.isFinite(windowParam) && windowParam > 0) ? windowParam : 200;
    const result = agreementRate(T.ws, win);
    const agreement = result ? { ...result, window: win } : null;
    const promotionState = getPromotionState(T.ws);
    send(res, 200, { ok: true, agreement, promoted: !!promotionState.promoted, promotionState: promotionState.promoted ? promotionState : null });
    return true;
  }

  // GET /metrics/economy — Sonnet judge calls avoided by promoted learned model.
  // Reads .graph/gate-labeled.jsonl and counts rows where by === 'model'.
  // Cost is estimated; label as such in the response.
  if (p === '/metrics/economy' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required — pass ?workspace=' }); return true; }
    const economy = estimatedSavings(T.ws);
    send(res, 200, { ok: true, economy });
    return true;
  }

  if (p === '/cron/usage' && m === 'GET') {
    const usageFile = path.join(__dirname, '..', 'logs', 'cron-token-usage.jsonl');
    const entries = [];
    try {
      const lines = fs.readFileSync(usageFile, 'utf8').split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { entries.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
    } catch { /* file missing -> empty */ }
    entries.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const byTaskMap = {};
    for (const e of entries) {
      const k = e.task || '(unknown)';
      if (!byTaskMap[k]) byTaskMap[k] = { lastRun: e.ts || null, totalInput: 0, totalOutput: 0, totalCache: 0, runCount: 0 };
      const g = byTaskMap[k];
      g.totalInput  += e.input_tokens  || 0;
      g.totalOutput += e.output_tokens || 0;
      g.totalCache  += e.cache_read_tokens || 0;
      g.runCount++;
      if (!g.lastRun || String(e.ts || '') > String(g.lastRun)) g.lastRun = e.ts || null;
    }
    send(res, 200, { entries: entries.slice(0, 200), byTask: byTaskMap }); return true;
  }

  return false;
};

module.exports._internal = { sessionsFromOverlay, claimedOutputForSession, harnessNameForWorkspace, representedSessionIds };
