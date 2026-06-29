'use strict';

function judgeTools(deps) {
  const { q, UI_URI, PORT, runSubconsciousAssignment } = deps;
  return [
  { name: 'get_judge_next', description: 'Fetch pending judge items from /judge/next. Pass node to actively resolve a task\'s judging hold before retrying start_task; this only exposes the existing judge queue and does not auto-approve edges.', inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'Optional node/task key for /judge/next?node=...' }, budget: { type: 'number' } }, additionalProperties: false }, run: (a, call) => call('GET', `/judge/next?${q({ node: a && a.node, budget: a && a.budget })}`) },
{ name: 'submit_judge_verdict', description: 'Submit explicit judge verdicts to /judge/verdict. Use keepEdge/pruneEdge verdicts returned from get_judge_next to clear a judging hold, or repairTask/taskDecision for decision-lane items.', inputSchema: { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: true } }, keepEdge: { type: 'object', additionalProperties: true }, pruneEdge: { type: 'object', additionalProperties: true }, createEdge: { type: 'object', additionalProperties: true }, consolidate: { type: 'object', additionalProperties: true }, surfaceCluster: { type: 'object', additionalProperties: true }, repairTask: { type: 'object', additionalProperties: true }, taskDecision: { type: 'object', additionalProperties: true }, markJudged: { type: 'string' }, item: { type: 'object', additionalProperties: true } }, additionalProperties: false }, run: (a, call) => {
    const body = a || {};
    if (!Array.isArray(body.verdicts) && !body.keepEdge && !body.pruneEdge && !body.createEdge && !body.consolidate && !body.surfaceCluster && !body.repairTask && !body.taskDecision && !body.markJudged && !body.item) return { error: 'pass at least one judge verdict' };
    return call('POST', '/judge/verdict', body);
  } }
  ];
}

module.exports = judgeTools;
