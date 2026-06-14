#!/usr/bin/env node
// Test: usage_recorded graph events so cost survives overlay reset.
// Verifies that when a usage slice is recorded for a task and then the overlay is
// "reset" (re-loaded from checkpoint / graph-store), the token data for that task
// is still present in the reloaded overlay's usage_records.
// Plain Node, no framework. Run: node test/usage-recorded-graph-event.test.js
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-ev-')));
}

// Clear module cache for a clean slate with each tmp dir.
function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
      delete require.cache[key];
    }
  }
  const overlay    = require('../lib/overlay');
  const graphStore = require('../lib/graph-store');
  return { overlay, graphStore };
}

// ── Test 1: usage_recorded event round-trips through graph-store ──────────
{
  const tmpBase = tmpDir();
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmpBase;

  try {
    const { overlay, graphStore } = freshModules();

    const WS = path.join(tmpBase, 'ws-usage');
    fs.mkdirSync(WS, { recursive: true });
    graphStore.forWorkspace(WS);

    // Record a usage slice for a task.
    const ov = overlay.load(WS);
    const TASK_KEY = 'task/usage-test-1';
    const AGENT_ID = 'agent-abc123';
    const slice = {
      harness: 'claude',
      agent_id: AGENT_ID,
      session_id: 'sess-xyz',
      task_key: TASK_KEY,
      startedAt: '2026-06-14T10:00:00.000Z',
      endedAt:   '2026-06-14T10:05:00.000Z',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100, by_model: {} },
      human: { tokens: 10, chars: 60, messages: 1, dropped: 0 },
      overhead: { tokens: 0, by_category: {} },
    };
    if (!ov.usage_records) ov.usage_records = {};
    ov.usage_records[AGENT_ID] = slice;
    overlay.save(WS, ov);

    // Verify a usage_recorded event was emitted to the graph-store.
    const store = graphStore.forWorkspace(WS);
    const g = graphStore.loadGraph(store);
    const taskNode = g.nodes[TASK_KEY];
    ok('graph-store node exists for task after usage_recorded event', !!taskNode);
    ok('node.usage_records is populated', !!taskNode && !!taskNode.usage_records);
    ok('node.usage_records[agent_id] is present', !!taskNode && !!taskNode.usage_records && !!taskNode.usage_records[AGENT_ID]);
    ok('node.usage_records[agent_id].usage.input_tokens correct', taskNode && taskNode.usage_records && taskNode.usage_records[AGENT_ID] && taskNode.usage_records[AGENT_ID].usage.input_tokens === 1000);
    ok('node.usage_records[agent_id].usage.output_tokens correct', taskNode && taskNode.usage_records && taskNode.usage_records[AGENT_ID] && taskNode.usage_records[AGENT_ID].usage.output_tokens === 200);

    // Simulate overlay reset: clear the module cache and reload from scratch.
    // The overlay file persists (local fields), and the graph-store events persist.
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
        delete require.cache[key];
      }
    }
    const overlay2    = require('../lib/overlay');
    const graphStore2 = require('../lib/graph-store');
    graphStore2.forWorkspace(WS);

    const ov2 = overlay2.load(WS);
    ok('after overlay reset: usage_records is populated', !!(ov2.usage_records && Object.keys(ov2.usage_records).length > 0));
    ok('after overlay reset: agent slice present', !!(ov2.usage_records && ov2.usage_records[AGENT_ID]));
    const restoredSlice = ov2.usage_records && ov2.usage_records[AGENT_ID];
    ok('after overlay reset: input_tokens survives', restoredSlice && restoredSlice.usage && restoredSlice.usage.input_tokens === 1000);
    ok('after overlay reset: output_tokens survives', restoredSlice && restoredSlice.usage && restoredSlice.usage.output_tokens === 200);
    ok('after overlay reset: task_key preserved', restoredSlice && restoredSlice.task_key === TASK_KEY);
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = oldPluginData;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
        delete require.cache[key];
      }
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ── Test 2: slices without a task_key are NOT persisted to graph-store ────
{
  const tmpBase = tmpDir();
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmpBase;

  try {
    const { overlay, graphStore } = freshModules();

    const WS = path.join(tmpBase, 'ws-notask');
    fs.mkdirSync(WS, { recursive: true });
    graphStore.forWorkspace(WS);

    const ov = overlay.load(WS);
    const AGENT_ID = 'agent-notask';
    const slice = {
      harness: 'claude',
      agent_id: AGENT_ID,
      session_id: 'sess-xyz',
      task_key: null, // no task attribution
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
      human: { tokens: 0, chars: 0, messages: 0, dropped: 0 },
      overhead: { tokens: 0, by_category: {} },
    };
    if (!ov.usage_records) ov.usage_records = {};
    ov.usage_records[AGENT_ID] = slice;
    overlay.save(WS, ov);

    // No task node should exist since task_key is null
    const store = graphStore.forWorkspace(WS);
    const g = graphStore.loadGraph(store);
    const hasUsageRecordedEvents = Object.values(g.nodes).some(n => n.usage_records && Object.keys(n.usage_records).length > 0);
    ok('slices without task_key are not persisted to graph-store', !hasUsageRecordedEvents);
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = oldPluginData;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
        delete require.cache[key];
      }
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ── Test 3: idempotency — second save with same data emits only one event ─
{
  const tmpBase = tmpDir();
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmpBase;

  try {
    const { overlay, graphStore } = freshModules();

    const WS = path.join(tmpBase, 'ws-idem');
    fs.mkdirSync(WS, { recursive: true });
    graphStore.forWorkspace(WS);

    const ov = overlay.load(WS);
    const TASK_KEY = 'task/idem-1';
    const AGENT_ID = 'agent-idem-x';
    const slice = {
      harness: 'claude', agent_id: AGENT_ID, session_id: 'sess', task_key: TASK_KEY,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
      human: { tokens: 0, chars: 0, messages: 0, dropped: 0 },
      overhead: { tokens: 0, by_category: {} },
    };
    ov.usage_records[AGENT_ID] = slice;
    overlay.save(WS, ov);

    // Second save with identical data
    const ov2 = overlay.load(WS);
    overlay.save(WS, ov2);

    // Count usage_recorded events across all node files
    const nodesDir = path.join(WS, '.graph', 'nodes');
    const allJsonl = fs.readdirSync(nodesDir, { recursive: true }).filter(f => f.endsWith('.jsonl'));
    let evCount = 0;
    for (const f of allJsonl) {
      const raw = fs.readFileSync(path.join(nodesDir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { if (JSON.parse(line).evt === 'usage_recorded') evCount++; } catch { /* ignore */ }
      }
    }
    ok('idempotency: only 1 usage_recorded event emitted for identical saves', evCount === 1);
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = oldPluginData;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
        delete require.cache[key];
      }
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ── Test 4: multiple agents attributed to the same task all survive reset ─
{
  const tmpBase = tmpDir();
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmpBase;

  try {
    const { overlay, graphStore } = freshModules();

    const WS = path.join(tmpBase, 'ws-multi');
    fs.mkdirSync(WS, { recursive: true });
    graphStore.forWorkspace(WS);

    const ov = overlay.load(WS);
    const TASK_KEY = 'task/multi-agent-1';
    for (const [agentId, out] of [['agent-A', 100], ['agent-B', 200], ['agent-C', 300]]) {
      ov.usage_records[agentId] = {
        harness: 'claude', agent_id: agentId, session_id: 'sess', task_key: TASK_KEY,
        usage: { input_tokens: out * 5, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
        human: { tokens: 0, chars: 0, messages: 0, dropped: 0 },
        overhead: { tokens: 0, by_category: {} },
      };
    }
    overlay.save(WS, ov);

    // Clear and reload
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
        delete require.cache[key];
      }
    }
    const overlay3    = require('../lib/overlay');
    const graphStore3 = require('../lib/graph-store');
    graphStore3.forWorkspace(WS);

    const ov3 = overlay3.load(WS);
    ok('multi-agent: agent-A survives reset', !!(ov3.usage_records && ov3.usage_records['agent-A']));
    ok('multi-agent: agent-B survives reset', !!(ov3.usage_records && ov3.usage_records['agent-B']));
    ok('multi-agent: agent-C survives reset', !!(ov3.usage_records && ov3.usage_records['agent-C']));
    ok('multi-agent: agent-A output_tokens correct', ov3.usage_records && ov3.usage_records['agent-A'] && ov3.usage_records['agent-A'].usage.output_tokens === 100);
    ok('multi-agent: agent-C output_tokens correct', ov3.usage_records && ov3.usage_records['agent-C'] && ov3.usage_records['agent-C'].usage.output_tokens === 300);
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = oldPluginData;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
        delete require.cache[key];
      }
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
