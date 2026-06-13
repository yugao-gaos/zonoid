#!/usr/bin/env node
// Unit tests for lib/prompt-heuristic.js — mirrors hooks/classify.sh Python heuristics.
'use strict';
const { classifyHeuristic, selectModels } = require('../lib/prompt-heuristic');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

ok('solo: simple fix', classifyHeuristic('fix the login button color').decision === 'solo');
ok('workflow: audit keyword', classifyHeuristic('audit every file in the auth module').decision === 'workflow');
ok('team: compare perspectives', classifyHeuristic('compare pros and cons of redis vs postgres').decision === 'team');
ok('loop: keep running until', classifyHeuristic('keep running tests until green').decision === 'loop');
ok('workflow: list-shaped', classifyHeuristic('do a, b, c, d, e tasks').decision === 'workflow');

const models = selectModels(0.2, 'abstain');
ok('model: low complexity abstain -> sonnet', models.main_model === 'claude-sonnet-4-6');
ok('model: high complexity inject -> fable', selectModels(0.8, 'inject').main_model === 'claude-fable-5');
ok('model: default -> opus', selectModels(0.5, 'abstain').main_model === 'claude-opus-4-8');

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
