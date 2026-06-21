'use strict';
const {
  routeSteer, selectModels, formatNoteSummaries, formatScaffoldList,
} = require('./prompt-heuristic');
const { readyInjection, markReadyInjected } = require('./ready-flag-cache');
const { isHeadlessEnabled } = require('./headless-drain');

const GATE_REMINDER = '[Orch gate] Dispatcher/main sessions must NOT call start_task — dispatch background subagents to claim and execute work instead. Claim only the task matching the work at hand — NEVER force-claim a task to unlock edits for unrelated work; create a new task instead. Force-claims are capped at 3 per task; over cap requires user approval on the dashboard.';
const HEARTBEAT = '[Orchestrator heartbeat] Call ScheduleWakeup(delaySeconds=7200, reason="idle heartbeat", prompt="<<autonomous-loop-dynamic>>") to keep this session alive for background work. On wakeup: check ready tasks + active loop via next_action. If BOTH are empty (nothing ready, no active loop) — do NOT reschedule. Let the loop end.';
const SELF_LEARN = '[Self-learning mode] This task has a metric spec. You must: (1) call branch_task before editing, (2) measure baseline before changes, (3) follow branch→implement→measure→judge loop.';
const LOOP_DIRECTIVE = '[Loop] This is substantive work. Keep looping until the USER\'S REQUEST is DONE — not forever: call ScheduleWakeup(delaySeconds=120, reason="request loop", prompt="<<autonomous-loop-dynamic>>") to schedule the next tick whenever the request is still in progress, and stop scheduling once it is complete. On each slack tick, opportunistically drain regular ready work via next_action; standing judge/label/learner drains are owned by the daemon headless drain runner. Many such request-loops can run concurrently.';

function joinCtx(parts) {
  return parts.filter(Boolean).join('\n');
}

function buildJudgeNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  const key = pressure.harness_task_key || 'followup/harness-judge-drain';
  return `[Subconscious pressure] judge backlog: ${pressure.depth || 0} item(s) (${pressure.dupClusters || 0} duplicate cluster(s)) for ${key}. Daemon/Subconscious owns maintenance orchestration; keep the foreground request flow and call ask_subconscious if this pressure changes the next action.`;
}

function buildLearnerNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  const key = pressure.harness_task_key || 'followup/harness-learner-drain';
  return `[Subconscious pressure] learner backlog: ${pressure.depth || 0} candidate(s) in ${pressure.repoName || 'repo'} for ${key}. Daemon/Subconscious owns maintenance orchestration; keep the foreground request flow and call ask_subconscious if this pressure changes the next action.`;
}

function buildLabelNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  const key = pressure.harness_task_key || 'followup/harness-label-drain';
  return `[Subconscious pressure] grader backlog: ${pressure.depth || 0} gradable journal row(s) for ${key}. Daemon/Subconscious owns maintenance orchestration; keep the foreground request flow and call ask_subconscious if this pressure changes the next action.`;
}

/**
 * Assemble additionalContext + routing fields from classify inputs.
 */
function assembleClassifyResponse(opts) {
  const {
    prompt,
    sessionId,
    heuristic,
    contextClassify: cc,
    hasMetricSpec,
    readyEntry,
    autostartLine,
    judgePressure,
    labelPressure,
    learnerPressure,
    orchGateOff,
    inflightWorkers,
    hasActiveLoop,
  } = opts;

  const gateDecision = cc.gate_decision || 'abstain';
  const complexity = cc.complexity ?? 0.5;
  const models = selectModels(complexity, gateDecision);

  const parts = [];
  const steer = routeSteer(heuristic.decision);
  if (steer) parts.push(steer);

  parts.push(`[Model routing] Recommended: main=${models.main_model}, subagent=${models.sub_model} (complexity=${complexity}, gate=${gateDecision})`);

  if (gateDecision === 'inject') {
    const notes = formatNoteSummaries(cc.top_notes);
    if (notes) parts.push(`[Graph context] Relevant prior knowledge found:\n${notes}`);
  } else if (gateDecision === 'scaffold') {
    const scaffold = formatScaffoldList(cc.scaffold_keys);
    if (scaffold) {
      parts.push(`[Subconscious scaffold] Relevant prior work found — ask_subconscious for the verdict, context, anchor, pressure, and approval posture before opening flat files. Use these task anchors as inputs:\n${scaffold}`);
    }
  }

  if (hasMetricSpec) parts.push(SELF_LEARN);

  // AUTO mode: the daemon already started the loop — emit the confirmation and SUPPRESS the soft
  // nudge (we still mark the per-session busy flag so a later non-auto tick doesn't re-nudge).
  let ready = { text: '', injected: false };
  if (autostartLine) {
    markReadyInjected(sessionId);
    parts.push(autostartLine);
    ready = { text: autostartLine, injected: true };
  } else {
    ready = readyInjection(sessionId, prompt, hasActiveLoop);
    if (ready.text) parts.push(ready.text);
  }

  if (inflightWorkers) parts.push(inflightWorkers);

  parts.push(GATE_REMINDER);
  parts.push(HEARTBEAT);

  const substantive = heuristic.decision !== 'solo'
    || complexity >= 0.4
    || gateDecision === 'inject'
    || gateDecision === 'scaffold';
  if (substantive) parts.push(LOOP_DIRECTIVE);

  if (!orchGateOff && !isHeadlessEnabled()) {
    const judgeNudge = buildJudgeNudge(judgePressure);
    const labelNudge = buildLabelNudge(labelPressure);
    const learnerNudge = buildLearnerNudge(learnerPressure);
    if (judgeNudge) parts.push(judgeNudge);
    if (labelNudge) parts.push(labelNudge);
    if (learnerNudge) parts.push(learnerNudge);
  }

  const additionalContext = joinCtx(parts);

  return {
    decision: heuristic.decision,
    reason: heuristic.reason,
    prompt: heuristic.prompt,
    main_model: models.main_model,
    sub_model: models.sub_model,
    complexity,
    gate_decision: gateDecision,
    context_classify: cc,
    additional_context: additionalContext,
    ready: {
      cached: !!readyEntry,
      count: readyEntry ? readyEntry.count : 0,
      labels: readyEntry ? readyEntry.labels : [],
      injected: ready.injected,
    },
  };
}

module.exports = {
  assembleClassifyResponse,
  buildJudgeNudge,
  buildLabelNudge,
  buildLearnerNudge,
  GATE_REMINDER,
  HEARTBEAT,
  LOOP_DIRECTIVE,
};
