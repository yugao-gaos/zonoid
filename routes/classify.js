'use strict';
const judge = require('../lib/judge');
const judgeRoute = require('./judge');
const labelRoute = require('./label');
const { contextClassify } = require('../lib/context-classify-core');
const { classifyHeuristic } = require('../lib/prompt-heuristic');
const { refreshReadyFlag } = require('../lib/ready-flag-cache');
const { assembleClassifyResponse } = require('../lib/classify-assemble');
const { inflightWorkersContext, listDispatcherChildren } = require('../lib/dispatcher-children');
const { rowKey, readJsonl, journalPath, labeledPath } = require('../scripts/gate-label');
const { HARNESS_LEARNER_DRAIN_KEY, ensureHarnessLearnerDrainTask } = require('../lib/harness-task');
const { JUDGE_DEPTH, LABEL_DEPTH, computePressureNudge } = require('../lib/pressure-nudge');

const DRAIN_TASK_KEYS = new Set([
  judgeRoute.HARNESS_JUDGE_DRAIN_KEY,
  labelRoute.HARNESS_LABEL_DRAIN_KEY,
  HARNESS_LEARNER_DRAIN_KEY,
]);

function judgePressure(overlay, buildGraph, ws) {
  const queue = judge.buildQueue(overlay);
  const depth = queue.length;
  const dupClusters = queue.filter((i) => i.kind === 'dup-cluster').length;
  const gate = computePressureNudge({
    depth,
    depthThreshold: JUDGE_DEPTH,
    buildGraph,
    ws,
    overlay,
    harnessKey: judgeRoute.HARNESS_JUDGE_DRAIN_KEY,
    // Eager dispatch (task C) is the PRIMARY trigger; suppress the periodic catch-up nudge while it
    // is actively draining freshly-wired nodes — fallback only when eager is not keeping up.
    eagerActive: judge.eagerJudgePending(overlay),
  });
  return { depth, dupClusters, nudge: gate.nudge, harness_task_key: judgeRoute.HARNESS_JUDGE_DRAIN_KEY };
}

function labelPressure(state, buildGraph) {
  const ws = state.workspace;
  if (!ws) return { depth: 0, nudge: false, harness_task_key: labelRoute.HARNESS_LABEL_DRAIN_KEY };
  const journalRows = readJsonl(journalPath(ws));
  const labeledRows = readJsonl(labeledPath(ws));
  const labeledKeys = new Set(labeledRows.map((r) => r._key).filter(Boolean));
  const TERMINAL = new Set(['done', 'tested', 'failed', 'canceled']);
  const g = buildGraph ? buildGraph(ws) : null;
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
  const gate = computePressureNudge({
    depth,
    depthThreshold: LABEL_DEPTH,
    buildGraph,
    ws,
    overlay: state.overlay,
    harnessKey: labelRoute.HARNESS_LABEL_DRAIN_KEY,
  });
  return { depth, nudge: gate.nudge, harness_task_key: labelRoute.HARNESS_LABEL_DRAIN_KEY };
}

function learnerPressure(ws, sessionId, ctx) {
  const onboardDir = require('path').join(__dirname, '..', 'bench', 'onboard');
  let best = null;
  try {
    const subdirs = require('fs').readdirSync(onboardDir, { withFileTypes: true })
      .filter(function(d) { return d.isDirectory(); })
      .map(function(d) { return d.name; });
    for (const repoName of subdirs) {
      const outDir = require('path').join(onboardDir, repoName);
      const qf = require('path').join(outDir, 'onboard-queue.json');
      let q = null;
      try { q = JSON.parse(require('fs').readFileSync(qf, 'utf8')); } catch (e) { continue; }
      const remaining = (q.total || 0) - (q.cursor || 0);
      if (remaining <= 0) continue;
      let repoPath = null;
      const reportFile = require('path').join(outDir, 'onboard-learn-report.json');
      try { repoPath = JSON.parse(require('fs').readFileSync(reportFile, 'utf8')).repo || null; } catch (e2) { }
      if (!repoPath || repoPath === '__INSTALL_DIR__') repoPath = repoName;
      if (!best || best.depth < remaining) {
        best = { depth: remaining, repoPath: repoPath, outDir: outDir, repoName: repoName, nudge: false, harness_task_key: HARNESS_LEARNER_DRAIN_KEY };
      }
    }
  } catch (e3) { }
  if (!best) return { depth: 0, nudge: false, harness_task_key: HARNESS_LEARNER_DRAIN_KEY };
  const buildGraph = ctx.buildGraph;
  const state = ctx.state;
  const gate = computePressureNudge({
    depth: best.depth,
    depthThreshold: 1,
    buildGraph: buildGraph,
    ws: ws,
    overlay: state.overlay,
    harnessKey: HARNESS_LEARNER_DRAIN_KEY,
  });
  let nudge = gate.nudge;
  if (nudge && sessionId) {
    const children = listDispatcherChildren(sessionId, ctx);
    const nonDrainWorkers = children.filter(function(c) { return !DRAIN_TASK_KEYS.has(c.task_key); });
    if (nonDrainWorkers.length) nudge = false;
  }
  return Object.assign({}, best, { nudge: nudge });
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
  ensureHarnessLearnerDrainTask(T.ov, () => { T.save(); notifyChange(); });

  const jp = orchGateOff ? null : judgePressure(state.overlay, buildGraph, state.workspace);
  const lp = orchGateOff ? null : labelPressure(state, buildGraph);
  const lrp = orchGateOff ? null : learnerPressure(state.workspace, sessionId, ctx);

  const result = assembleClassifyResponse({
    prompt,
    sessionId,
    heuristic,
    contextClassify: cc,
    hasMetricSpec: sessionHasMetricSpec(sessionId, ctx),
    readyEntry,
    judgePressure: jp,
    labelPressure: lp,
    learnerPressure: lrp,
    orchGateOff,
    inflightWorkers: inflightWorkersContext(sessionId, ctx),
  });

  send(res, 200, result);
  return true;
};

module.exports._setLastJudgeNudgeAt = () => {};
module.exports._setLastLabelNudgeAt = () => {};
module.exports._judgePressure = judgePressure;
module.exports._labelPressure = labelPressure;
module.exports._learnerPressure = learnerPressure;
