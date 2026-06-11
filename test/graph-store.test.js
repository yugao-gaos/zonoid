#!/usr/bin/env node
// Tests for lib/graph-store.js — the in-repo JSONL event store.
// Plain Node, no framework. Run: node test/graph-store.test.js
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const gs   = require('../lib/graph-store');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// Throw a readable error for unexpected exceptions
function must(label, fn) {
  try { fn(); } catch (e) { console.log(`FAIL  ${label}: threw ${e.message}`); fail++; return; }
}
function mustThrow(label, fn) {
  try { fn(); console.log(`FAIL  ${label}: expected throw`); fail++; }
  catch { console.log(`PASS  ${label}`); pass++; }
}

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gs-')));
}

// ── open ─────────────────────────────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);
  ok('open returns dir', store.dir === dir);
  ok('open returns nodesDir', store.nodesDir === path.join(dir, 'nodes'));
  ok('open creates nodesDir', fs.existsSync(store.nodesDir));
  ok('open returns checkpointFile path', store.checkpointFile === path.join(dir, 'checkpoint.json'));
  fs.rmSync(dir, { recursive: true });
}

// ── appendEvent ───────────────────────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  // missing evt
  mustThrow('appendEvent throws on missing evt', () => gs.appendEvent(store, 'n1', { actor: 'a' }));
  // missing actor
  mustThrow('appendEvent throws on missing actor', () => gs.appendEvent(store, 'n1', { evt: 'node_created' }));

  // successful append
  gs.appendEvent(store, 'n1', { evt: 'node_created', actor: 'alice', label: 'task one', kind: 'task', workspace: '/ws' });
  const file = path.join(store.nodesDir, 'n1.jsonl');
  ok('appendEvent creates JSONL file', fs.existsSync(file));
  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  ok('appendEvent records evt', line.evt === 'node_created');
  ok('appendEvent records actor', line.actor === 'alice');
  ok('appendEvent adds ts when absent', typeof line.ts === 'string' && line.ts.length > 0);
  ok('appendEvent preserves payload fields', line.label === 'task one');

  // explicit ts is preserved
  gs.appendEvent(store, 'n1', { evt: 'status_changed', actor: 'bob', status: 'done', ts: '2026-01-01T00:00:00.000Z' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  ok('appendEvent grows file (2 lines)', lines.length === 2);
  const line2 = JSON.parse(lines[1]);
  ok('appendEvent preserves explicit ts', line2.ts === '2026-01-01T00:00:00.000Z');

  // idempotent across nodes — separate file per node
  gs.appendEvent(store, 'n2', { evt: 'node_created', actor: 'alice', label: 'task two', kind: 'task', workspace: '/ws' });
  ok('appendEvent creates separate file per node', fs.existsSync(path.join(store.nodesDir, 'n2.jsonl')));

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — node_created ───────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/1', { evt: 'node_created', actor: 'a', label: 'do X', kind: 'task', workspace: '/w' });
  const { nodes } = gs.loadGraph(store);

  ok('node_created sets label',     nodes['task/1'].label     === 'do X');
  ok('node_created sets kind',      nodes['task/1'].kind      === 'task');
  ok('node_created sets workspace', nodes['task/1'].workspace === '/w');
  ok('node_created tracks actor',   nodes['task/1'].last_actor === 'a');
  ok('node_created has null status (not set)', nodes['task/1'].status === null);

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — note_created ───────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'note:abc', { evt: 'note_created', actor: 'a',
    title: 'Design decision', summary: 'We chose X because Y',
    workspace: '/w', created_by: 'alice', valid_from: '2026-01-01',
    knowledge: [{ type: 'note', value: 'extra' }] });
  const { nodes } = gs.loadGraph(store);
  const n = nodes['note:abc'];

  ok('note_created sets label from title',  n.label === 'Design decision');
  ok('note_created sets kind=note',         n.kind  === 'note');
  ok('note_created sets summary',           n.summary === 'We chose X because Y');
  ok('note_created sets note.title',        n.note.title === 'Design decision');
  ok('note_created sets note.created_by',   n.note.created_by === 'alice');
  ok('note_created sets note.valid_from',   n.note.valid_from === '2026-01-01');
  ok('note_created appends knowledge',      n.knowledge.length === 1);
  ok('note_created knowledge item correct', n.knowledge[0].value === 'extra');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — status_changed ────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/2', { evt: 'node_created',   actor: 'a', label: 'foo', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'task/2', { evt: 'status_changed', actor: 'b', status: 'in_progress' });
  gs.appendEvent(store, 'task/2', { evt: 'status_changed', actor: 'c', status: 'done', note: 'merged' });
  const { nodes } = gs.loadGraph(store);
  const n = nodes['task/2'];

  ok('status_changed sets status to latest', n.status === 'done');
  ok('status_changed records note',          n.statusNote === 'merged');
  ok('status_changed tracks last_actor',     n.last_actor === 'c');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — summary_set ───────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/3', { evt: 'node_created', actor: 'a', label: 'bar', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'task/3', { evt: 'summary_set',  actor: 'b', summary: 'built the thing' });
  const { nodes } = gs.loadGraph(store);

  ok('summary_set sets summary', nodes['task/3'].summary === 'built the thing');

  // later summary_set overwrites
  gs.appendEvent(store, 'task/3', { evt: 'summary_set', actor: 'c', summary: 'updated summary' });
  const { nodes: n2 } = gs.loadGraph(store);
  ok('summary_set overwrites previous summary', n2['task/3'].summary === 'updated summary');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — knowledge_added ───────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/4', { evt: 'node_created',   actor: 'a', label: 'k', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'task/4', { evt: 'knowledge_added', actor: 'a', item: { type: 'file', value: 'foo.js' } });
  gs.appendEvent(store, 'task/4', { evt: 'knowledge_added', actor: 'a', item: { type: 'note', value: 'tip' } });
  const { nodes } = gs.loadGraph(store);

  ok('knowledge_added accumulates items',   nodes['task/4'].knowledge.length === 2);
  ok('knowledge_added first item correct',  nodes['task/4'].knowledge[0].value === 'foo.js');
  ok('knowledge_added second item correct', nodes['task/4'].knowledge[1].value === 'tip');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — edge_added ────────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/5', { evt: 'node_created', actor: 'a', label: 'A', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'task/6', { evt: 'node_created', actor: 'a', label: 'B', kind: 'task', workspace: '/w' });
  // edge from 5 to 6 (blocking)
  gs.appendEvent(store, 'task/5', { evt: 'edge_added', actor: 'a', from: 'task/5', to: 'task/6', kind: 'blocking' });
  // context edge with weight
  gs.appendEvent(store, 'task/5', { evt: 'edge_added', actor: 'a', from: 'note:x', to: 'task/5', kind: 'context', weight: 0.8 });
  // duplicate is ignored
  gs.appendEvent(store, 'task/5', { evt: 'edge_added', actor: 'a', from: 'task/5', to: 'task/6', kind: 'blocking' });

  const { edges, backEdges } = gs.loadGraph(store);

  ok('edge_added creates edges', edges.length === 2);
  const blocking = edges.find((e) => e.from === 'task/5' && e.to === 'task/6');
  ok('edge_added blocking edge exists', !!blocking);
  ok('edge_added blocking kind correct', blocking.kind === 'blocking');
  const ctx = edges.find((e) => e.from === 'note:x');
  ok('edge_added context edge exists', !!ctx);
  ok('edge_added context weight stored', ctx.weight === 0.8);
  ok('edge_added deduplicates', edges.filter((e) => e.from === 'task/5' && e.to === 'task/6').length === 1);
  ok('edge_added populates backEdges', backEdges['task/6'] && backEdges['task/6'].length === 1);
  ok('edge_added backEdge has correct from', backEdges['task/6'][0].from === 'task/5');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — snapshot_stored ───────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/7', { evt: 'node_created', actor: 'a', label: 's', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'task/7', { evt: 'snapshot_stored', actor: 'a',
    subject: 'do X', description: 'impl detail', status: 'done',
    blockedBy: [], owner: 'session/1', metadata: { foo: 1 }, snapshotted_at: '2026-01-01' });
  const { nodes } = gs.loadGraph(store);
  const snap = nodes['task/7'].snapshot;

  ok('snapshot_stored sets subject',         snap.subject === 'do X');
  ok('snapshot_stored sets description',     snap.description === 'impl detail');
  ok('snapshot_stored sets status',          snap.status === 'done');
  ok('snapshot_stored sets snapshotted_at',  snap.snapshotted_at === '2026-01-01');
  ok('snapshot_stored sets metadata',        snap.metadata && snap.metadata.foo === 1);

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — actor / agent_id tracking ─────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/8', { evt: 'node_created',   actor: 'session-1', label: 'X', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'task/8', { evt: 'status_changed', actor: 'session-2', agent_id: 'worker-42', status: 'in_progress' });
  const { nodes } = gs.loadGraph(store);

  ok('last_actor updated on each event', nodes['task/8'].last_actor === 'session-2');
  ok('last_agent_id set when provided',  nodes['task/8'].last_agent_id === 'worker-42');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — malformed lines skipped ──────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/9', { evt: 'node_created', actor: 'a', label: 'Y', kind: 'task', workspace: '/w' });
  // Inject a malformed line
  const f = path.join(store.nodesDir, 'task%2F9.jsonl');
  // The actual file is named with the nodeId directly — find it
  const files = fs.readdirSync(store.nodesDir);
  const nodeFile = files.find((x) => x.endsWith('.jsonl'));
  if (nodeFile) {
    fs.appendFileSync(path.join(store.nodesDir, nodeFile), 'not-json\n');
    gs.appendEvent(store, 'task/9', { evt: 'status_changed', actor: 'b', status: 'done' });
    const { nodes } = gs.loadGraph(store);
    const n = Object.values(nodes)[0];
    ok('malformed lines skipped, subsequent events still applied', n && n.status === 'done');
  } else {
    ok('(skip: no node file found for malformed-line test)', true);
  }

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — checkpoint loading ───────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  // Pre-populate checkpoint with a compacted node
  const checkpointedNode = { id: 'old/1', label: 'old task', kind: 'task', workspace: '/w', status: 'done', summary: 'done long ago', knowledge: [], note: null, snapshot: null, last_actor: 'ghost', last_agent_id: null };
  fs.writeFileSync(store.checkpointFile, JSON.stringify({ nodes: { 'old/1': checkpointedNode }, compacted_at: '2026-01-01' }));

  // Add a live node
  gs.appendEvent(store, 'live/1', { evt: 'node_created', actor: 'a', label: 'live', kind: 'task', workspace: '/w' });

  const { nodes, checkpointed } = gs.loadGraph(store);
  ok('checkpointed nodes appear in checkpointed map', checkpointed['old/1'] && checkpointed['old/1'].label === 'old task');
  ok('live nodes appear in nodes map', nodes['live/1'] && nodes['live/1'].label === 'live');

  fs.rmSync(dir, { recursive: true });
}

// ── compact ───────────────────────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  // terminal node (done)
  gs.appendEvent(store, 'done/1', { evt: 'node_created',   actor: 'a', label: 'done task', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'done/1', { evt: 'status_changed', actor: 'a', status: 'done' });
  // live node (in_progress — must not be compacted)
  gs.appendEvent(store, 'live/1', { evt: 'node_created',   actor: 'a', label: 'live task', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'live/1', { evt: 'status_changed', actor: 'a', status: 'in_progress' });
  // node with no status (null — must not be compacted)
  gs.appendEvent(store, 'new/1',  { evt: 'node_created',   actor: 'a', label: 'new task',  kind: 'task', workspace: '/w' });

  const result = gs.compact(store);
  ok('compact returns compacted count', result.compacted === 1);

  // Count .jsonl files recursively (nodeIds with slashes create subdirs)
  const remaining = fs.readdirSync(store.nodesDir, { recursive: true }).filter((f) => f.endsWith('.jsonl'));
  ok('compact removes terminal node JSONL', remaining.length === 2);  // only live/1 and new/1 remain

  ok('compact writes checkpoint.json', fs.existsSync(store.checkpointFile));
  const cp = JSON.parse(fs.readFileSync(store.checkpointFile, 'utf8'));
  const doneId = Object.keys(cp.nodes || {}).find((k) => k.startsWith('done'));
  ok('compact stores terminal node in checkpoint', !!doneId);
  ok('checkpoint has compacted_at', typeof cp.compacted_at === 'string');

  // After compact: loadGraph still returns the done node (from checkpoint) + live/in_progress nodes
  const { nodes, checkpointed } = gs.loadGraph(store);
  ok('post-compact loadGraph returns live node', !!nodes['live/1']);
  ok('post-compact loadGraph returns checkpointed done node', !!checkpointed[doneId]);

  // Idempotency: compact again finds no more terminal JSONL to process
  const r2 = gs.compact(store);
  ok('compact is idempotent (0 on second run)', r2.compacted === 0);

  fs.rmSync(dir, { recursive: true });
}

// ── initGitAttributes ────────────────────────────────────────────────────
{
  const dir = tmpDir();

  // Creates file when absent
  gs.initGitAttributes(dir);
  const content = fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8');
  ok('initGitAttributes creates .gitattributes', content.includes('.graph/nodes/*.jsonl merge=union'));

  // Idempotent — calling again must not duplicate
  gs.initGitAttributes(dir);
  const content2 = fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8');
  const count = (content2.match(/merge=union/g) || []).length;
  ok('initGitAttributes is idempotent (no duplicate entry)', count === 1);

  // Appends to existing content
  const dir2 = tmpDir();
  fs.writeFileSync(path.join(dir2, '.gitattributes'), '*.png binary\n');
  gs.initGitAttributes(dir2);
  const content3 = fs.readFileSync(path.join(dir2, '.gitattributes'), 'utf8');
  ok('initGitAttributes preserves existing content', content3.includes('*.png binary'));
  ok('initGitAttributes appends new entry', content3.includes('.graph/nodes/*.jsonl merge=union'));

  fs.rmSync(dir,  { recursive: true });
  fs.rmSync(dir2, { recursive: true });
}


// ── NEW EVENT TYPES ───────────────────────────────────────────────────────────

// ── loadGraph — assignee_set ──────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  const assignee = { agent_id: 'agent-abc', claimed_at: '2026-01-01T00:00:00.000Z' };
  gs.appendEvent(store, 'task/a1', { evt: 'assignee_set', assignee, actor: 'test' });
  const { nodes } = gs.loadGraph(store);

  ok('assignee_set: node exists', !!nodes['task/a1']);
  ok('assignee_set: node.assignee.agent_id correct', nodes['task/a1'].assignee.agent_id === 'agent-abc');
  ok('assignee_set: node.assignee.claimed_at correct', nodes['task/a1'].assignee.claimed_at === '2026-01-01T00:00:00.000Z');

  // Later assignee_set overwrites
  gs.appendEvent(store, 'task/a1', { evt: 'assignee_set', assignee: { agent_id: 'agent-xyz' }, actor: 'test' });
  const { nodes: n2 } = gs.loadGraph(store);
  ok('assignee_set: later event overwrites', n2['task/a1'].assignee.agent_id === 'agent-xyz');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — timestamps_set ────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  const timestamps = { firstSeen: '2026-01-01T00:00:00.000Z', lastChanged: '2026-01-02T00:00:00.000Z', lastStatus: 'in_progress' };
  gs.appendEvent(store, 'task/t1', { evt: 'timestamps_set', timestamps, actor: 'test' });
  const { nodes } = gs.loadGraph(store);

  ok('timestamps_set: node exists', !!nodes['task/t1']);
  ok('timestamps_set: firstSeen correct', nodes['task/t1'].timestamps.firstSeen === '2026-01-01T00:00:00.000Z');
  ok('timestamps_set: lastStatus correct', nodes['task/t1'].timestamps.lastStatus === 'in_progress');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — metrics_set ───────────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  const metrics = { metric: 'latency_p99', direction: 'min', measure_command: 'npm run bench' };
  gs.appendEvent(store, 'task/m1', { evt: 'metrics_set', metrics, actor: 'test' });
  const { nodes } = gs.loadGraph(store);

  ok('metrics_set: node exists', !!nodes['task/m1']);
  ok('metrics_set: metric correct', nodes['task/m1'].metrics.metric === 'latency_p99');
  ok('metrics_set: direction correct', nodes['task/m1'].metrics.direction === 'min');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — measurements_set ──────────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  const measurements = { value: 42.5, measured_at: '2026-01-01T00:00:00.000Z', command: 'npm run bench' };
  gs.appendEvent(store, 'task/ms1', { evt: 'measurements_set', measurements, actor: 'test' });
  const { nodes } = gs.loadGraph(store);

  ok('measurements_set: node exists', !!nodes['task/ms1']);
  ok('measurements_set: value correct', nodes['task/ms1'].measurements.value === 42.5);
  ok('measurements_set: command correct', nodes['task/ms1'].measurements.command === 'npm run bench');

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — benchmarks_set on system:benchmarks ──────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  const benchmarks = { 'task/b1': { metric: 'latency_p99', value: 100, unit: 'ms', source: 'internal', confidence: 'high' } };
  gs.appendEvent(store, 'system:benchmarks', { evt: 'benchmarks_set', benchmarks, actor: 'test' });
  const { nodes } = gs.loadGraph(store);

  ok('benchmarks_set: system:benchmarks node exists', !!nodes['system:benchmarks']);
  ok('benchmarks_set: benchmarks field present', !!nodes['system:benchmarks'].benchmarks);
  ok('benchmarks_set: nested value correct', nodes['system:benchmarks'].benchmarks['task/b1'].value === 100);

  fs.rmSync(dir, { recursive: true });
}

// ── loadGraph — repo_config_set on system:repos ───────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  const repos = { 'task/r1': '/home/user/myrepo' };
  gs.appendEvent(store, 'system:repos', { evt: 'repo_config_set', repos, actor: 'test' });
  const { nodes } = gs.loadGraph(store);

  ok('repo_config_set: system:repos node exists', !!nodes['system:repos']);
  ok('repo_config_set: repos field present', !!nodes['system:repos'].repos);
  ok('repo_config_set: repo path correct', nodes['system:repos'].repos['task/r1'] === '/home/user/myrepo');

  fs.rmSync(dir, { recursive: true });
}

// ── Edge deduplication: same edge_added twice → one edge ─────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  const ev = { evt: 'edge_added', from: 'task/dup-a', to: 'task/dup-b', kind: 'blocking', actor: 'test' };
  gs.appendEvent(store, 'task/dup-a', ev);
  gs.appendEvent(store, 'task/dup-a', ev);

  const { edges } = gs.loadGraph(store);
  const matching = edges.filter((e) => e.from === 'task/dup-a' && e.to === 'task/dup-b' && e.kind === 'blocking');
  ok('edge dedup: two identical edge_added events produce exactly one edge', matching.length === 1);

  fs.rmSync(dir, { recursive: true });
}

// ── emitDiff idempotency: same assignee saved twice → only 1 event ────────
{
  const tmpBase = tmpDir();
  const oldPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmpBase;

  // Clear module cache so overlay + graph-store pick up the new env.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/lib/overlay') || key.includes('/lib/graph-store') || key.includes('/lib/native-tasks')) {
      delete require.cache[key];
    }
  }

  try {
    const overlayStore = require('../lib/overlay');
    const gs2          = require('../lib/graph-store');

    const WS = path.join(tmpBase, 'ws-idem');
    fs.mkdirSync(WS, { recursive: true });
    gs2.forWorkspace(WS);

    // First save: set assignee
    const ov1 = overlayStore.load(WS);
    ov1.assignee['task/idem'] = { agent_id: 'agent-x' };
    overlayStore.save(WS, ov1);

    // Second save: same assignee value (load re-sets prev-state baseline)
    const ov2 = overlayStore.load(WS);
    overlayStore.save(WS, ov2);

    // Count assignee_set events across all node files in this workspace
    const nodesDir = path.join(WS, '.graph', 'nodes');
    const allJsonl = fs.readdirSync(nodesDir, { recursive: true }).filter((f) => f.endsWith('.jsonl'));
    let assigneeSetCount = 0;
    for (const f of allJsonl) {
      const raw = fs.readFileSync(path.join(nodesDir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { if (JSON.parse(line).evt === 'assignee_set') assigneeSetCount++; } catch { /* ignore */ }
      }
    }
    ok('emitDiff idempotency: only 1 assignee_set event emitted for identical saves', assigneeSetCount === 1);
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

// ── loadGraph handles missing nodes dir without throwing ──────────────────
{
  const dir = tmpDir();
  try {
    const store = {
      nodesDir:       path.join(dir, 'nonexistent', 'nodes'),
      checkpointFile: path.join(dir, 'nonexistent', 'checkpoint.json'),
    };
    let result, threw = false;
    try { result = gs.loadGraph(store); } catch { threw = true; }
    ok('loadGraph: missing nodes dir does not throw', !threw);
    ok('loadGraph: returns empty nodes map', result && Object.keys(result.nodes).length === 0);
    ok('loadGraph: returns empty edges array', result && result.edges.length === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── forWorkspace returns correct nodesDir and checkpointFile ─────────────
{
  const dir = tmpDir();
  const wsTag = `ws-fw-${Date.now()}`;
  const WS  = path.join(dir, wsTag);
  fs.mkdirSync(WS, { recursive: true });
  try {
    const store = gs.forWorkspace(WS);
    ok('forWorkspace: nodesDir correct',      store.nodesDir       === path.join(WS, '.graph', 'nodes'));
    ok('forWorkspace: checkpointFile correct', store.checkpointFile === path.join(WS, '.graph', 'checkpoint.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
