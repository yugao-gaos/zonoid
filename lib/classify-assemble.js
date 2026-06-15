'use strict';
const crypto = require('crypto');
const {
  routeSteer, selectModels, formatNoteSummaries, formatScaffoldList,
} = require('./prompt-heuristic');
const { readyInjection, markReadyInjected } = require('./ready-flag-cache');

const GATE_REMINDER = '[Orch gate] Dispatcher/main sessions must NOT call start_task — dispatch background subagents to claim and execute work instead. Claim only the task matching the work at hand — NEVER force-claim a task to unlock edits for unrelated work; create a new task instead. Force-claims are capped at 3 per task; over cap requires user approval on the dashboard.';
const HEARTBEAT = '[Orchestrator heartbeat] Call ScheduleWakeup(delaySeconds=7200, reason="idle heartbeat", prompt="<<autonomous-loop-dynamic>>") to keep this session alive for background work. On wakeup: check ready tasks + active loop via next_action. If BOTH are empty (nothing ready, no active loop) — do NOT reschedule. Let the loop end.';
const SELF_LEARN = '[Self-learning mode] This task has a metric spec. You must: (1) call branch_task before editing, (2) measure baseline before changes, (3) follow branch→implement→measure→judge loop.';
const LOOP_DIRECTIVE = '[Loop] This is substantive work. Keep looping until the USER\'S REQUEST is DONE — not forever: call ScheduleWakeup(delaySeconds=120, reason="request loop", prompt="<<autonomous-loop-dynamic>>") to schedule the next tick whenever the request is still in progress, and stop scheduling once it is complete. On each slack tick, opportunistically drain ready eager-judge work and the standing judge/label/learner queue (via next_action) so judging and labeling ride this real work instead of an idle timer. Many such request-loops can run concurrently.';

function joinCtx(parts) {
  return parts.filter(Boolean).join('\n');
}

function buildJudgeNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  const key = pressure.harness_task_key || 'followup/harness-judge-drain';
  const n = Math.max(1, Math.min(pressure.available || 1, Math.ceil((pressure.depth || 0) / 20)));
  const agentList = Array.from({ length: n }, (_, i) => {
    const suffix = crypto.randomBytes(4).toString('hex').slice(0, 8);
    return `agent_id="judge-drain-${suffix}-${i + 1}"`;
  }).join(', ');
  return `[Judge] backlog: ${pressure.depth || 0} items (${pressure.dupClusters || 0} dup-clusters) — dispatch **${n}** background self-learn-edge-judge subagent${n > 1 ? 's' : ''} in parallel this turn (model: sonnet — NOT haiku, verdict discrimination degrades; budget 20 each); do not block the user's request on them. Spawn all ${n} as concurrent background subagents in a single turn. Each subagent MUST: (1) call mcp__orchestrator-graph__start_task with task_key="${key}" and its own agent_id (${agentList}) BEFORE judging; (2) call mcp__orchestrator-graph__complete_task with the same task_key and agent_id, and a summary including the count of items judged, AFTER finishing.`;
}

function buildLearnerNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  const suffix = crypto.randomBytes(4).toString('hex').slice(0, 8);
  const key = pressure.harness_task_key || 'followup/harness-learner-drain';
  return `[Learner] backlog: ${pressure.depth || 0} candidate(s) in ${pressure.repoName || 'repo'} — dispatch ONE background subagent this turn; do not block the user's request on it. The subagent MUST: (1) call mcp__orchestrator-graph__start_task with task_key="${key}" and agent_id="learner-drain-${suffix}" BEFORE running; (2) run \`node scripts/onboard-learn.js --repo ${pressure.repoPath || 'REPO'} --in ${pressure.outDir || 'OUTDIR'} --drain --batch 20\` and wait for it to complete; (3) call mcp__orchestrator-graph__complete_task with the same task_key and agent_id, and a summary including remaining count, AFTER finishing.`;
}

function buildLabelNudge(pressure) {
  if (!pressure || !pressure.nudge) return '';
  const suffix = crypto.randomBytes(4).toString('hex').slice(0, 8);
  const key = pressure.harness_task_key || 'followup/harness-label-drain';
  return `[Grader] backlog: ${pressure.depth || 0} gradable journal rows — dispatch ONE background subagent (cheap/default model; this is a deterministic script run, no LLM reasoning needed) this turn; do not block the user's request on it. The subagent MUST: (1) call mcp__orchestrator-graph__start_task with task_key="${key}" and agent_id="label-drain-${suffix}" BEFORE running; (2) run \`node scripts/gate-label.js\` and read the coverage summary from its stdout; (3) call mcp__orchestrator-graph__complete_task with the same task_key and agent_id, and a summary including the newly-labeled count from the script's coverage output, AFTER finishing.`;
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
      parts.push(`[Graph scaffold] Relevant prior work found — consult search_knowledge or these tasks before opening flat files:\n${scaffold}`);
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

  if (!orchGateOff) {
    const jn = buildJudgeNudge(judgePressure);
    if (jn) parts.push(jn);
    const ln = buildLabelNudge(labelPressure);
    if (ln) parts.push(ln);
    const lrn = buildLearnerNudge(learnerPressure);
    if (lrn) parts.push(lrn);
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
