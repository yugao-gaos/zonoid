'use strict';
const judge = require('../lib/judge');
const judgeRoute = require('./judge');
const labelRoute = require('./label');
const { contextClassify } = require('../lib/context-classify-core');
const { classifyHeuristic } = require('../lib/prompt-heuristic');
const { refreshReadyFlag } = require('../lib/ready-flag-cache');
const { assembleClassifyResponse } = require('../lib/classify-assemble');
const { rowKey, readJsonl, journalPath, labeledPath } = require('../scripts/gate-label');

const NUDGE_DEPTH = 30;
const NUDGE_LABEL_DEPTH = 10;
const NUDGE_INTERVAL_MS = 3600000;
let _lastJudgeNudgeAt = 0;
let _lastLabelNudgeAt = 0;

function judgePressure(overlay) {
  const queue = judge.buildQueue(overlay);
  const depth = queue.length;
  const dupClusters = queue.filter((i) => i.kind === 'dup-cluster').length;
  let nudge = false;
  if (depth >= NUDGE_DEPTH) {
    const now = Date.now();
    if (now - _lastJudgeNudgeAt >= NUDGE_INTERVAL_MS) {
      _lastJudgeNudgeAt = now;
      nudge = true;
    }
  }
  return { depth, dupClusters, nudge, harness_task_key: judgeRoute.HARNESS_JUDGE_DRAIN_KEY };
}

function labelPressure(state) {
  const ws = state.workspace;
  if (!ws) return { depth: 0, nudge: false, harness_task_key: labelRoute.HARNESS_LABEL_DRAIN_KEY };
  const journalRows = readJsonl(journalPath(ws));
  const labeledRows = readJsonl(labeledPath(ws));
  const labeledKeys = new Set(labeledRows.map((r) => r._key).filter(Boolean));
  const TERMINAL = new Set(['done', 'tested', 'failed', 'canceled']);
  const g = state._buildGraph ? state._buildGraph(ws) : null;
  const statusById = g ? new Map(g.tasks.map((t) => [t.id, t.status])) : new Map();
  let depth = 0;
  for (const row of journalRows) {
    if (!row.task_key) continue;
    const key = rowKey(row);
    if (labeledKeys.has(key)) continue;
    const status = statusById.get(row.task_key);
    if (!status || !TERMINAL.has(status)) continue;
    depth++;
  }
  let nudge = false;
  if (depth >= NUDGE_LABEL_DEPTH) {
    const now = Date.now();
    if (now - _lastLabelNudgeAt >= NUDGE_INTERVAL_MS) {
      _lastLabelNudgeAt = now;
      nudge = true;
    }
  }
  return { depth, nudge, harness_task_key: labelRoute.HARNESS_LABEL_DRAIN_KEY };
}

function sessionHasMetricSpec(sessionId, ctx) {
  if (!sessionId) return false;
  const { buildGraph, state, targetOverlay, harness } = ctx;
  const g = buildGraph(state.workspace);
  for (const t of g.tasks) {
    if (t.status === 'in_progress' && t.session === sessionId) {
      const metric = state.overlay.metrics && state.overlay.metrics[t.id];
      if (metric) return true;
    }
  }
  for (const t of harness.tasks.readSessionTasksRaw(sessionId)) {
    if (t.status !== 'in_progress') continue;
    const key = `${sessionId}/${t.id}`;
    const metric = state.overlay.metrics && state.overlay.metrics[key];
    if (metric) return true;
  }
  const T = targetOverlay(null, { searchParams: new URLSearchParams() });
  const cs = T.ov.claimSessions;
  if (cs) {
    for (const [key, sid] of Object.entries(cs)) {
      if (sid !== sessionId) continue;
      const metric = state.overlay.metrics && state.overlay.metrics[key];
      if (metric) return true;
    }
  }
  return false;
}

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, buildGraph, state, now, MAX_ROUTES, targetOverlay, notifyChange } = ctx;

  if (p !== '/classify' || m !== 'POST') return false;

  const b = await readBody(req);
  const prompt = String(b.prompt || '').trim();
  if (!prompt) {
    send(res, 400, { ok: false, error: 'prompt required' });
    return true;
  }

  const sessionId = b.session_id ? String(b.session_id) : null;
  const orchGateOff = b.orch_gate_off === true || b.orch_gate_off === 1 || b.orch_gate_off === '1';

  const heuristic = classifyHeuristic(prompt);

  state.routes.push({
    ts: now(),
    prompt: heuristic.prompt,
    decision: heuristic.decision,
    reason: String(heuristic.reason || '').slice(0, 280),
  });
  if (state.routes.length > MAX_ROUTES) state.routes.shift();

  const cc = await contextClassify(prompt, ctx);

  const readyEntry = refreshReadyFlag(sessionId, () => {
    const g = buildGraph(state.workspace);
    return g.tasks.filter((t) => t.status === 'ready').map((t) => ({ key: t.id, label: t.label }));
  });

  const T = targetOverlay(b, u);
  judgeRoute.ensureHarnessJudgeDrainTask(T.ov, () => { T.save(); notifyChange(); });
  labelRoute.ensureHarnessLabelDrainTask(T.ov, () => { T.save(); notifyChange(); });

  const jp = orchGateOff ? null : judgePressure(state.overlay);
  const lp = orchGateOff ? null : labelPressure({ ...state, _buildGraph: buildGraph });

  const result = assembleClassifyResponse({
    prompt,
    sessionId,
    heuristic,
    contextClassify: cc,
    hasMetricSpec: sessionHasMetricSpec(sessionId, ctx),
    readyEntry,
    judgePressure: jp,
    labelPressure: lp,
    orchGateOff,
  });

  send(res, 200, result);
  return true;
};

module.exports._setLastJudgeNudgeAt = (ts) => { _lastJudgeNudgeAt = ts; };
module.exports._setLastLabelNudgeAt = (ts) => { _lastLabelNudgeAt = ts; };
module.exports._judgePressure = judgePressure;
module.exports._labelPressure = labelPressure;
