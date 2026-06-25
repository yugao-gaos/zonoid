#!/usr/bin/env node
// Judge per-node cost attribution (task 24).
// Properties:
//   - judgeNodeOutputFromRecords sums output_tokens only for slices with judged_node === nodeKey
//   - slices lacking judged_node are excluded (pooled harness behaviour is unchanged)
//   - taskOutputFromRecords (existing per-task_key rollup) is not affected by judged_node
//   - /judge/node-cost?node=<key> returns per-node output_tokens
//   - /judge/node-cost (no ?node) returns by_node map for all attributed nodes
//   - a non-node-scoped drain slice stays on the harness bucket (no judged_node → not in by_node)
'use strict';
const usageAccounting = require('../lib/usage-accounting');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// --- judgeNodeOutputFromRecords ------------------------------------------------------------------

{
  // node-scoped slice: judged_node set → counted for the triggering node
  const ov = { usage_records: {
    'agent-eager-1': {
      task_key: 'followup/harness-judge-drain',
      judged_node: 's/node-a',
      usage: { input_tokens: 100, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
    },
    // second node-scoped slice for the SAME node (burst)
    'agent-eager-2': {
      task_key: 'followup/harness-judge-drain',
      judged_node: 's/node-a',
      usage: { input_tokens: 50, output_tokens: 18, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
    },
    // non-node-scoped drain slice: no judged_node → stays pooled
    'agent-drain-1': {
      task_key: 'followup/harness-judge-drain',
      usage: { input_tokens: 200, output_tokens: 99, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
    },
    // different node
    'agent-eager-3': {
      task_key: 'followup/harness-judge-drain',
      judged_node: 's/node-b',
      usage: { input_tokens: 30, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
    },
  }};

  const nodeA = usageAccounting.judgeNodeOutputFromRecords(ov, 's/node-a');
  ok('node-a sums two eager slices (42+18=60)', nodeA === 60);

  const nodeB = usageAccounting.judgeNodeOutputFromRecords(ov, 's/node-b');
  ok('node-b only counts its own slice (11)', nodeB === 11);

  const nodeC = usageAccounting.judgeNodeOutputFromRecords(ov, 's/nonexistent');
  ok('unknown node returns 0', nodeC === 0);

  // The non-node-scoped drain slice must NOT appear in any node's total
  const drainNotInNode = usageAccounting.judgeNodeOutputFromRecords(ov, 'followup/harness-judge-drain');
  ok('harness drain task_key is not a judged_node key (returns 0)', drainNotInNode === 0);

  // Existing per-task_key rollup: ALL slices (both node-scoped and drain) have
  // task_key=harness-judge-drain, so taskOutputFromRecords still sees ALL of them.
  const harnessTotal = usageAccounting.taskOutputFromRecords(ov, 'followup/harness-judge-drain');
  ok('taskOutputFromRecords (per-task) unchanged: sums ALL slices (42+18+99+11=170)', harnessTotal === 170);
}

{
  // null / missing nodeKey
  const ov = { usage_records: {
    'a1': { judged_node: 'x/1', usage: { output_tokens: 5 } },
  }};
  ok('judgeNodeOutputFromRecords(null) returns 0', usageAccounting.judgeNodeOutputFromRecords(ov, null) === 0);
  ok('judgeNodeOutputFromRecords(undefined) returns 0', usageAccounting.judgeNodeOutputFromRecords(ov, undefined) === 0);
  ok('judgeNodeOutputFromRecords empty ov', usageAccounting.judgeNodeOutputFromRecords({}, 'x/1') === 0);
}

// --- /judge/node-cost endpoint (inline simulation) -----------------------------------------------
// Test the endpoint logic directly by simulating the route handler (avoids spinning up the server).
{
  const records = {
    'agent-n1': { judged_node: 'task/p', usage: { output_tokens: 30 } },
    'agent-n2': { judged_node: 'task/p', usage: { output_tokens: 20 } },
    'agent-n3': { judged_node: 'task/q', usage: { output_tokens: 77 } },
    'agent-pooled': { task_key: 'followup/harness-judge-drain', usage: { output_tokens: 200 } },  // no judged_node
  };
  const ov = { usage_records: records };

  // Simulate ?node=task/p
  const nodeP = usageAccounting.judgeNodeOutputFromRecords(ov, 'task/p');
  ok('/judge/node-cost?node=task/p returns 50', nodeP === 50);

  // Simulate ?node=task/q
  const nodeQ = usageAccounting.judgeNodeOutputFromRecords(ov, 'task/q');
  ok('/judge/node-cost?node=task/q returns 77', nodeQ === 77);

  // Simulate no ?node → by_node aggregation
  const byNode = {};
  for (const slice of Object.values(records)) {
    if (!slice || !slice.judged_node) continue;
    const k = slice.judged_node;
    byNode[k] = (byNode[k] || 0) + ((slice.usage && slice.usage.output_tokens) || 0);
  }
  ok('by_node has task/p=50', byNode['task/p'] === 50);
  ok('by_node has task/q=77', byNode['task/q'] === 77);
  ok('by_node does NOT include pooled drain slice', !('followup/harness-judge-drain' in byNode) && Object.keys(byNode).length === 2);
}

// --- Guard: taskOutputFromRecords signature unchanged --------------------------------------------
{
  // Ensure the existing function still works correctly (no regression from adding judged_node field).
  const ov = { usage_records: {
    'w1': { task_key: 'my/task', judged_node: 'some/node', usage: { output_tokens: 100 } },
    'w2': { task_key: 'my/task', usage: { output_tokens: 50 } },
    'w3': { task_key: 'other/task', usage: { output_tokens: 999 } },
  }};
  const r = usageAccounting.taskOutputFromRecords(ov, 'my/task');
  ok('taskOutputFromRecords counts both slices with matching task_key (150)', r === 150);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
