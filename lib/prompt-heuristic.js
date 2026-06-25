'use strict';

const TEAM_SIG = ['compare', 'perspective', 'perspectives', 'debate', 'pros and cons', "devil's advocate", 'critique', 'brainstorm', 'trade-off', 'tradeoff', 'different angles', 'weigh', ' vs ', ' versus '];
const WF_SIG = ['all ', 'every ', 'each ', 'audit', 'refactor', 'migrate', 'across ', 'for each', 'sweep', 'every file', 'all files', 'entire codebase', 'throughout', 'rename all', 'update all'];
const LOOP_SIG = ['keep running', 'until', 'watch', 'monitor', 'retry', 'each time', 'whenever', 'poll'];

function hitSignals(low, sigs) {
  return sigs.filter((x) => low.includes(x)).map((x) => x.trim());
}

/** Offline solo/workflow/team/loop heuristic — mirrors hooks/classify.sh inline Python. */
function classifyHeuristic(prompt) {
  const trimmed = String(prompt || '').trim();
  const low = trimmed.toLowerCase();
  const words = low.split(/\s+/).filter(Boolean).length;
  const th = hitSignals(low, TEAM_SIG);
  const wh = hitSignals(low, WF_SIG);
  const lh = hitSignals(low, LOOP_SIG);
  const listShaped = low.split(',').length - 1 >= 3 || (trimmed.match(/\b\d+[\.\)]/g) || []).length >= 3;
  const multiStep = words >= 40 && (low.split(' and ').length - 1) >= 2;

  if (lh.length) {
    return { decision: 'loop', reason: `iterative/loop signals: ${lh.slice(0, 4).join(', ')}`, prompt: trimmed.slice(0, 280) };
  }
  if (th.length) {
    return { decision: 'team', reason: `comparison/perspective signals: ${th.slice(0, 4).join(', ')}`, prompt: trimmed.slice(0, 280) };
  }
  if (wh.length || listShaped || multiStep) {
    const bits = wh.slice(0, 4);
    if (listShaped) bits.push('list-shaped');
    if (multiStep) bits.push('long multi-step');
    return {
      decision: 'workflow',
      reason: bits.length ? `parallelizable signals: ${bits.join(', ')}` : 'parallelizable structure',
      prompt: trimmed.slice(0, 280),
    };
  }
  return { decision: 'solo', reason: 'single-focus task', prompt: trimmed.slice(0, 280) };
}

function selectModels(complexity, gateDecision) {
  let mainModel = 'claude-opus-4-8';
  if (complexity < 0.4 && gateDecision === 'abstain') mainModel = 'claude-sonnet-4-6';
  else if (complexity > 0.7 || gateDecision === 'inject') mainModel = 'claude-fable-5';
  let subModel;
  if (mainModel === 'claude-fable-5') subModel = 'claude-opus-4-8 (fast)';
  else if (mainModel === 'claude-opus-4-8') subModel = 'claude-sonnet-4-6';
  else subModel = 'claude-sonnet-4-6';
  return { main_model: mainModel, sub_model: subModel };
}

const ROUTE_STEER = {
  loop: '[Orchestrator router] This task is iterative/convergent. Use the orchestrator-loop skill or a run-test-fix Agent loop rather than a one-shot workflow.',
  workflow: '[Orchestrator router] This task looks parallelizable. Strongly prefer invoking the orchestrator-loop skill, which decomposes the work and runs it through the Workflow tool. If the task is genuinely linear, you may proceed solo.',
  team: '[Orchestrator router] This task benefits from multiple independent perspectives. Consider an agent team (one teammate per angle), or if Agent Teams is not enabled, fall back to the orchestrator-loop skill (Workflow). Declare dependencies where one angle needs another\'s output.',
};

function routeSteer(decision) {
  return ROUTE_STEER[decision] || '';
}

function formatNoteSummaries(topNotes) {
  if (!topNotes || !topNotes.length) return '';
  return topNotes.slice(0, 5).map((n) => `- ${n.title || '(untitled)'}: ${n.summary || ''}`).join('\n');
}

function formatScaffoldList(scaffoldKeys) {
  if (!scaffoldKeys || !scaffoldKeys.length) return '';
  return scaffoldKeys.slice(0, 3).map((x) => `- ${x.key || ''} : ${x.label || ''}`).join('\n');
}

module.exports = {
  classifyHeuristic, selectModels, routeSteer, formatNoteSummaries, formatScaffoldList,
};
