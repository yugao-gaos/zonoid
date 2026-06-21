'use strict';
const overlayStore = require('./overlay');
const judge = require('./judge');
const {
  classifyHeuristic, selectModels, routeSteer, formatNoteSummaries, formatScaffoldList,
} = require('./prompt-heuristic');
const { refreshReadyFlag, readyInjection } = require('./ready-flag-cache');
const { contextClassify } = require('./context-classify-core');
const { inflightWorkersContext } = require('./dispatcher-children');
const { isHeadlessEnabled } = require('./headless-drain');

const GATE_REMINDER = '[Orch gate] Dispatcher/main sessions must NOT call start_task — dispatch background subagents to claim and execute work instead. Claim only the task matching the work at hand — NEVER force-claim a task to unlock edits for unrelated work; create a new task instead. Force-claims are capped at 3 per task; over cap requires user approval on the dashboard.';
const HEARTBEAT = '[Orchestrator heartbeat] Call ScheduleWakeup(delaySeconds=7200, reason="idle heartbeat", prompt="<<autonomous-loop-dynamic>>") to keep this session alive for background work. On wakeup: check ready tasks + active loop via next_action. If BOTH are empty (nothing ready, no active loop) — do NOT reschedule. Let the loop end.';
const SELF_LEARN = '[Self-learning mode] This task has a metric spec. You must: (1) call branch_task before editing, (2) measure baseline before changes, (3) follow branch→implement→measure→judge loop.';

function appendCtx(parts, line) {
  if (!line) return;
  parts.push(line);
}

function judgeNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  return `[Subconscious pressure] judge backlog: ${pressure.depth || 0} item(s) (${pressure.dupClusters || 0} duplicate cluster(s)) for ${pressure.harness_task_key}. Daemon/Subconscious owns maintenance orchestration; keep the foreground request flow and call ask_subconscious if this pressure changes the next action.`;
}

function labelNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  return `[Subconscious pressure] grader backlog: ${pressure.depth || 0} gradable journal row(s) for ${pressure.harness_task_key}. Daemon/Subconscious owns maintenance orchestration; keep the foreground request flow and call ask_subconscious if this pressure changes the next action.`;
}

function resolveActiveClaimMetric(ctx, sessionId) {
  if (!sessionId) return false;
  const { buildGraph, state, harness, targetOverlay } = ctx;
  const g = buildGraph(state.workspace);
  let claims = g.tasks.filter((t) => t.status === 'in_progress' && t.session === sessionId);
  if (!claims.length) {
    for (const t of harness.tasks.readSessionTasksRaw(sessionId)) {
      if (t.status === 'in_progress') claims.push({ id: `${sessionId}/${t.id}` });
    }
  }
  const T = targetOverlay(null, { searchParams: new URLSearchParams() });
  const cs = T.ov.claimSessions || {};
  for (const t of g.tasks.filter((x) => x.status === 'in_progress')) {
    if (cs[t.id] === sessionId && !claims.some((c) => c.id === t.id)) claims.push(t);
  }
  const key = claims[0] && claims[0].id;
  if (!key) return false;
  return !!((T.ov.metrics && T.ov.metrics[key]) || null);
}

/**
 * Build finished hook injection text + routing fields (mirrors hooks/classify.sh assembly).
 */
async function composeClassify(opts, ctx) {
  const prompt = String(opts.prompt || '').trim();
  const sessionId = opts.session_id || null;
  const orchGateOff = !!opts.orch_gate_off;

  const heuristic = classifyHeuristic(prompt);
  const cc = await contextClassify(prompt, ctx);
  const models = selectModels(cc.complexity, cc.gate_decision);

  const parts = [];
  appendCtx(parts, routeSteer(heuristic.decision));
  appendCtx(parts, `[Model routing] Recommended: main=${models.main_model}, subagent=${models.sub_model} (complexity=${cc.complexity}, gate=${cc.gate_decision})`);

  if (cc.gate_decision === 'inject') {
    const notes = formatNoteSummaries(cc.top_notes);
    if (notes) {
      appendCtx(parts, `[Graph context] Relevant prior knowledge found:\n${notes}`);
    }
  } else if (cc.gate_decision === 'scaffold') {
    const scaffold = formatScaffoldList(cc.scaffold_keys);
    if (scaffold) {
      appendCtx(parts, `[Subconscious scaffold] Relevant prior work found — ask_subconscious for the verdict, context, anchor, pressure, and approval posture before opening flat files. Use these task anchors as inputs:\n${scaffold}`);
    }
  }

  if (resolveActiveClaimMetric(ctx, sessionId)) appendCtx(parts, SELF_LEARN);

  const readyEntry = refreshReadyFlag(sessionId, () => {
    const g = ctx.buildGraph(ctx.state.workspace);
    return g.tasks.filter((t) => t.status === 'ready').map((t) => ({ key: t.id, label: t.label }));
  });
  const readyBlock = readyInjection(sessionId, prompt);
  appendCtx(parts, readyBlock.text);

  appendCtx(parts, inflightWorkersContext(sessionId, ctx));

  appendCtx(parts, GATE_REMINDER);
  appendCtx(parts, HEARTBEAT);

  let judgePressure = null;
  let labelPressure = null;
  if (!orchGateOff && !isHeadlessEnabled() && ctx.judgePressure) {
    judgePressure = ctx.judgePressure();
    appendCtx(parts, judgeNudge(judgePressure));
  }
  if (!orchGateOff && !isHeadlessEnabled() && ctx.labelPressure) {
    labelPressure = ctx.labelPressure();
    appendCtx(parts, labelNudge(labelPressure));
  }

  const additional_context = parts.join('\n');

  return {
    decision: heuristic.decision,
    reason: heuristic.reason,
    prompt: heuristic.prompt,
    ...models,
    complexity: cc.complexity,
    gate_decision: cc.gate_decision,
    context_classify: cc,
    additional_context,
    ready: {
      cached: !!readyEntry,
      count: readyEntry ? readyEntry.count : 0,
      labels: readyEntry ? readyEntry.labels : [],
      injected: readyBlock.injected,
      flag_ts: readyEntry ? readyEntry.ts : null,
    },
    judge_pressure: judgePressure,
    label_pressure: labelPressure,
  };
}

function logRoute(state, nowFn, maxRoutes, heuristic) {
  state.routes.push({
    ts: nowFn(),
    prompt: heuristic.prompt,
    decision: heuristic.decision,
    reason: String(heuristic.reason || '').slice(0, 280),
  });
  if (state.routes.length > maxRoutes) state.routes.shift();
}

module.exports = { composeClassify, logRoute, judgeNudge, labelNudge };
