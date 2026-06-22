#!/usr/bin/env node
// Unit tests for the unknown-key rejection guard (task d42ebe37-ee9f-46b6-ae21-f6f82464d482/13).
// Asserts that every orchestrator-graph WRITE op rejects unknown task keys with a clear error
// and creates NO phantom node — symmetric with the existing READ-op guards.
//
// Run: node test/unknown-key-rejection.test.js
// No framework; no port binding; no daemon spawn.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ── shared test harness ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
}

// ── overlay helper ───────────────────────────────────────────────────────────
const ov = require('../lib/overlay');

function makeOv(extra = {}) {
  return { ...ov.EMPTY(), ...extra };
}

// ── nodeExistsInGraph (the core helper) ─────────────────────────────────────
const { nodeExistsInGraph } = require('../daemon.js');

{
  const graph = {
    tasks: [
      { id: 'sess-abc/1', label: 'real task', status: 'ready', deps: [], context_deps: [] },
      { id: 'note:note-xyz123', label: 'a note', kind: 'note', status: 'note', deps: [], context_deps: [] },
    ],
  };

  ok('1.1: nodeExistsInGraph returns true for known task key', nodeExistsInGraph(graph, 'sess-abc/1'));
  ok('1.2: nodeExistsInGraph returns true for note: prefixed key', nodeExistsInGraph(graph, 'note:note-xyz123'));
  ok('1.3: nodeExistsInGraph returns false for bare integer key', !nodeExistsInGraph(graph, '1'));
  ok('1.4: nodeExistsInGraph returns false for unknown task key', !nodeExistsInGraph(graph, 'unknown/99'));
  ok('1.5: nodeExistsInGraph returns false for null key', !nodeExistsInGraph(graph, null));
  ok('1.6: nodeExistsInGraph returns false when graph is null', !nodeExistsInGraph(null, 'sess-abc/1'));
  ok('1.7: nodeExistsInGraph returns false when tasks is empty', !nodeExistsInGraph({ tasks: [] }, 'sess-abc/1'));
}

// ── route handler test helpers ───────────────────────────────────────────────
// Build a minimal ctx that exposes the real route-handler interface:
// buildGraph returns a graph with KNOWN_KEY as the only real task,
// so any other key is "unknown".
const KNOWN_KEY  = 'sess-xyz/42';
const UNKNOWN_KEY = '1'; // bare integer — the phantom-node bug case
const UNKNOWN_TASK_KEY = 'codex/missing'; // valid shape, but not an existing graph node

function makeCtx(overlay, extraCtxFields = {}) {
  const _graph = {
    tasks: [
      { id: KNOWN_KEY, label: 'known task', status: 'ready', session: null, deps: [], context_deps: [] },
    ],
    ghosts: [],
  };
  let lastSent = null;
  const ctx = {
    get state() { return { overlay, workspace: '/tmp/test-ws', agents: {}, graphStore: null }; },
    send(res, status, body)       { lastSent = { status, body }; },
    sendOp(res, b, status, body)  { lastSent = { status, body }; },
    readBody: async ()            => ({}),
    notifyChange: ()              => {},
    buildGraph: ()                => _graph,
    nodeExistsInGraph,
    targetOverlay: (b)            => ({ ov: overlay, ws: '/tmp/test-ws', save: () => {} }),
    opReplay: ()                  => false,
    cosine: ()                    => 0,
    embed: async ()               => null,
    knowledgeText: ()             => '',
    snapshotNative: ()            => {},
    now: ()                       => new Date().toISOString(),
    suggestToks: ()               => new Set(),
    scoreNodeAgainstTokens: ()    => ({ score: 0 }),
    SUGGEST_DUP_THRESHOLD: 0.6,
    DIMS: 384,
    ALL_STATUSES: ['not_ready', 'ready', 'in_progress', 'tested', 'done', 'failed', 'canceled'],
    followups: { validate: () => null, apply: () => [], onBucketComplete: () => null },
    verdicts: {
      validate: () => null, apply: () => [],
      sweepStaleHolds: () => ({ released: [], flagged: [] }),
      lintProse: () => null,
    },
    agentsArr: ()    => [],
    saveAgents: ()   => {},
    cache: { agg: new Map(), aggAt: new Map() },
    loops: new Map(),
    saveLoops: () => {},
    judge: { judgingState: () => ({ judging: false, timedOut: false }), judgingTimeoutMs: () => 30000 },
    // configure_task (git/repo) path:
    resolveRepo: () => null,
    validateMetricSpec: () => null,
    validateBenchmark: () => null,
    taskTranscript: () => null,
    usageCached: () => null,
    git: { currentBranch: () => null },
    ingestNode: async () => ({ seeded: 0, vec: null }),
    graphStore: null,
    // agent lifecycle (touched in /overlay/status after the key check passes)
    touchAgent: () => {},
    writeTaskStatus: () => {},
    harness: { scheduler: { writeScheduledTask: () => ({ armed: false }) } },
    filedrop: { removeStubIfSnapshotted: () => false },
    readNativeTask: () => null,
    ...extraCtxFields,
  };
  return { ctx, getLastSent: () => lastSent };
}

function makeReq(body = {}) {
  let _body = body;
  return {
    readBody: async () => _body,
    method: 'POST',
    headers: {},
  };
}

function makeSP(params = {}) {
  return { searchParams: { get: (k) => params[k] != null ? String(params[k]) : null } };
}

// ── SECTION 2: /overlay/status (set_status / start_task / complete_task) ─────
(async () => {
  const overlayRoute = require('../routes/overlay');
  const taskRoute    = require('../routes/task');
  const gitRoute     = require('../routes/git');

  // 2.1: unknown key is rejected
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: UNKNOWN_KEY, status: 'in_progress', agent_id: 'test-agent' });
    const route = overlayRoute(ctx);
    await route('/overlay/status', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('2.1: /overlay/status rejects unknown key with 404', r && r.status === 404);
    ok('2.2: /overlay/status error mentions the unknown key', r && r.body && r.body.error && r.body.error.includes(UNKNOWN_KEY));
    ok('2.3: /overlay/status does NOT set status on phantom key', !o.status[UNKNOWN_KEY]);
  }
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: UNKNOWN_TASK_KEY, status: 'done', summary: 'syntactic phantom', agent_id: 'test-agent' });
    const route = overlayRoute(ctx);
    await route('/overlay/status', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('2.3b: /overlay/status rejects syntactically valid unknown key with 404', r && r.status === 404);
    ok('2.3c: /overlay/status does NOT create snapshot for syntactic unknown key', !(o.snapshots && o.snapshots[UNKNOWN_TASK_KEY]));
  }

  // 2.4: known key is accepted
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    // Simulate the worktree requirement by setting a fake git entry
    if (!o.git) o.git = {};
    o.git[KNOWN_KEY] = { worktree: '/tmp/fake-wt', branch: 'orch/attempt/sess-xyz-42' };
    // For a non-in_progress status we don't need all the agent/session machinery:
    ctx.readBody = async () => ({ key: KNOWN_KEY, status: 'done', summary: 'test done', agent_id: 'test-agent' });
    const route = overlayRoute(ctx);
    await route('/overlay/status', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    // 200 or some other non-404 error (the session gate may fire) — the key is not rejected
    ok('2.4: /overlay/status known key is NOT rejected with unknown-key 404', !(r && r.status === 404 && r.body && r.body.error && r.body.error.includes('unknown task')));
  }

  // ── SECTION 3: /overlay/block (block_task) ───────────────────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: UNKNOWN_KEY, reason: 'test' });
    const route = overlayRoute(ctx);
    await route('/overlay/block', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('3.1: /overlay/block rejects unknown key with 404', r && r.status === 404);
    ok('3.2: /overlay/block does NOT set blocked on phantom key', !(o.blocked && o.blocked[UNKNOWN_KEY]));
  }

  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: KNOWN_KEY, reason: 'block the known one' });
    const route = overlayRoute(ctx);
    await route('/overlay/block', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('3.3: /overlay/block known key returns 200', r && r.status === 200);
    ok('3.4: /overlay/block known key sets blocked', !!(o.blocked && o.blocked[KNOWN_KEY]));
  }

  // ── SECTION 4: /overlay/unblock (unblock_task) ───────────────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: UNKNOWN_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/unblock', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('4.1: /overlay/unblock rejects unknown key with 404', r && r.status === 404);
  }

  {
    const o = makeOv();
    ov.setBlocked(o, KNOWN_KEY, 'was blocked');
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: KNOWN_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/unblock', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('4.2: /overlay/unblock known key returns 200', r && r.status === 200);
  }

  // ── SECTION 5: /overlay/edge (add_dependency) ────────────────────────────
  // 5.1: both endpoints unknown → reject
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ from: UNKNOWN_KEY, to: 'another-phantom/5' });
    const route = overlayRoute(ctx);
    await route('/overlay/edge', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('5.1: /overlay/edge rejects phantom from-key with 404', r && r.status === 404);
    ok('5.2: /overlay/edge creates no edge when from is unknown', o.edges.length === 0);
  }

  // 5.3: known from, unknown to → reject
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ from: KNOWN_KEY, to: UNKNOWN_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/edge', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('5.3: /overlay/edge rejects phantom to-key with 404', r && r.status === 404);
    ok('5.4: /overlay/edge creates no edge when to is unknown', o.edges.length === 0);
  }
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ from: KNOWN_KEY, to: UNKNOWN_TASK_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/edge', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('5.4b: /overlay/edge rejects syntactically valid unknown to-key with 404', r && r.status === 404);
    ok('5.4c: /overlay/edge creates no snapshot for syntactic unknown to-key', !(o.snapshots && o.snapshots[UNKNOWN_TASK_KEY]));
    ok('5.4d: /overlay/edge creates no edge for syntactic unknown to-key', o.edges.length === 0);
  }

  // 5.5: note:xxx endpoints are accepted (notes ARE in the graph)
  {
    const o = makeOv();
    // Manually add a note node so the graph returns it
    const { ctx, getLastSent } = makeCtx(o);
    // Override buildGraph to include a note node
    ctx.buildGraph = () => ({
      tasks: [
        { id: KNOWN_KEY, label: 'known task', status: 'ready', session: null, deps: [], context_deps: [] },
        { id: 'note:note-abc123', label: 'a note', kind: 'note', status: 'note', deps: [], context_deps: [] },
      ],
      ghosts: [],
    });
    ctx.readBody = async () => ({ from: 'note:note-abc123', to: KNOWN_KEY, kind: 'context' });
    const route = overlayRoute(ctx);
    await route('/overlay/edge', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('5.5: /overlay/edge accepts note: → task edge', r && r.status === 200);
    ok('5.6: /overlay/edge creates edge for note → task', o.edges.length >= 1);
  }

  // 5.7: cross-workspace ghost edge (fromWorkspace set) — `from` skip is not validated
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ from: 'foreign-key/1', to: KNOWN_KEY, fromWorkspace: '/other/ws', kind: 'blocking' });
    const route = overlayRoute(ctx);
    await route('/overlay/edge', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('5.7: /overlay/edge accepts ghost edge (fromWorkspace set, from not validated locally)', r && r.status === 200);
  }

  // ── SECTION 6: /overlay/edge/remove (remove_dependency) ─────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ from: UNKNOWN_KEY, to: KNOWN_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/edge/remove', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('6.1: /overlay/edge/remove rejects phantom from-key with 404', r && r.status === 404);
  }

  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ from: KNOWN_KEY, to: UNKNOWN_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/edge/remove', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('6.2: /overlay/edge/remove rejects phantom to-key with 404', r && r.status === 404);
  }

  // ── SECTION 7: /overlay/note wires_to (record_decision wires_to) ─────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({
      title: 'test note',
      summary: 'test summary',
      wires_to: [UNKNOWN_KEY],
    });
    const route = overlayRoute(ctx);
    await route('/overlay/note', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('7.1: /overlay/note rejects unknown wires_to key with 404', r && r.status === 404);
    // Confirm no note was created (note_nodes is empty since we rejected early)
    ok('7.2: /overlay/note creates no note when wires_to has unknown key', Object.keys(o.note_nodes || {}).length === 0);
  }

  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({
      title: 'test note',
      summary: 'test summary',
      wires_to: [KNOWN_KEY],
    });
    const route = overlayRoute(ctx);
    await route('/overlay/note', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('7.3: /overlay/note known wires_to key returns 200', r && r.status === 200);
  }

  // ── SECTION 8: /task/metric (configure_task metric) ──────────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({
      key: UNKNOWN_KEY,
      spec: { metric: 'latency', direction: 'min', measure_command: 'echo 1' },
    });
    const route = taskRoute(ctx);
    await route('/task/metric', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('8.1: /task/metric rejects unknown key with 404', r && r.status === 404);
    ok('8.2: /task/metric creates no metric spec on phantom key', !(o.metrics && o.metrics[UNKNOWN_KEY]));
  }

  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({
      key: KNOWN_KEY,
      spec: { metric: 'latency', direction: 'min', measure_command: 'echo 1' },
    });
    const route = taskRoute(ctx);
    await route('/task/metric', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('8.3: /task/metric known key returns 200', r && r.status === 200);
  }

  // ── SECTION 9: /task/benchmark (configure_task benchmark) ────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({
      key: UNKNOWN_KEY,
      benchmark: { metric: 'latency', value: 100, source: 'https://example.com' },
    });
    // Wire up the validator since we now hit it
    ctx.validateBenchmark = (b) => {
      if (!b.metric) return 'metric required';
      if (b.value == null) return 'value required';
      if (!b.source) return 'source required';
      return null;
    };
    const route = taskRoute(ctx);
    await route('/task/benchmark', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('9.1: /task/benchmark rejects unknown key with 404', r && r.status === 404);
  }

  // ── SECTION 10: /mark-root (mark_root) ───────────────────────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ task_key: UNKNOWN_KEY, reason: 'test' });
    const route = taskRoute(ctx);
    await route('/mark-root', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('10.1: /mark-root rejects unknown key with 404', r && r.status === 404);
    ok('10.2: /mark-root creates no unwired entry for phantom key', !(o.notes && o.notes[UNKNOWN_KEY]));
  }

  {
    const o = makeOv();
    o.unwired = { [KNOWN_KEY]: true };
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ task_key: KNOWN_KEY, reason: 'genuine root' });
    const route = taskRoute(ctx);
    await route('/mark-root', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('10.3: /mark-root known key returns 200', r && r.status === 200);
  }

  // ── SECTION 11: /git/repo (configure_task repo_path) ─────────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: UNKNOWN_KEY, repo_path: '/some/path' });
    const route = gitRoute(ctx);
    await route('/git/repo', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('11.1: /git/repo rejects unknown key with 404', r && r.status === 404);
    ok('11.2: /git/repo creates no repo entry on phantom key', !(o.repos && o.repos[UNKNOWN_KEY]));
  }

  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: KNOWN_KEY, repo_path: '/some/path' });
    const route = gitRoute(ctx);
    await route('/git/repo', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('11.3: /git/repo known key returns 200', r && r.status === 200);
  }

  // ── SECTION 12: /supersede (supersede_task) ───────────────────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ old_key: UNKNOWN_KEY, new_key: KNOWN_KEY, reason: 'test' });
    const route = overlayRoute(ctx);
    await route('/supersede', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('12.1: /supersede rejects unknown old_key with 404', r && r.status === 404);
    ok('12.2: /supersede does NOT cancel phantom old_key', !(o.status && o.status[UNKNOWN_KEY]));
  }

  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ old_key: KNOWN_KEY, new_key: UNKNOWN_KEY, reason: 'test' });
    const route = overlayRoute(ctx);
    await route('/supersede', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('12.3: /supersede rejects unknown new_key with 404', r && r.status === 404);
  }

  // ── SECTION 13: /overlay/knowledge (attach_knowledge) ────────────────────
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: UNKNOWN_KEY, item: { type: 'note', value: 'test' } });
    const route = overlayRoute(ctx);
    await route('/overlay/knowledge', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('13.1: /overlay/knowledge rejects unknown key with 404', r && r.status === 404);
    ok('13.2: /overlay/knowledge creates no knowledge entry on phantom key', !(o.knowledge && o.knowledge[UNKNOWN_KEY]));
  }

  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ key: KNOWN_KEY, item: { type: 'note', value: 'test' } });
    const route = overlayRoute(ctx);
    await route('/overlay/knowledge', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('13.3: /overlay/knowledge known key returns 200', r && r.status === 200);
  }

  // ── SECTION 14: retire-phantom-nodes.js cleanup script ───────────────────
  {
    // Create a temp graph dir with phantom nodes "1" and "3" (bare integers),
    // and a real node "d42ebe37/1" (has a slash — not a phantom).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-retire-test-'));
    const nodesDir = path.join(tmpDir, 'nodes');
    fs.mkdirSync(nodesDir, { recursive: true });

    // Phantom node "1" — status ready (not terminal)
    const phantom1 = path.join(nodesDir, '1.jsonl');
    fs.writeFileSync(phantom1,
      JSON.stringify({ evt: 'status_changed', id: '1', status: 'in_progress', actor: 'overlay-sync', ts: '2026-06-15T00:00:00Z' }) + '\n' +
      JSON.stringify({ evt: 'status_changed', id: '1', status: 'ready', actor: 'overlay-sync', ts: '2026-06-15T01:00:00Z' }) + '\n'
    );

    // Phantom node "3" — already canceled (should be skipped as already terminal)
    const phantom3 = path.join(nodesDir, '3.jsonl');
    fs.writeFileSync(phantom3,
      JSON.stringify({ evt: 'status_changed', id: '3', status: 'canceled', actor: 'overlay-sync', ts: '2026-06-15T00:00:00Z' }) + '\n'
    );

    // Real node (has slash separator — encoded as subdir)
    // The codec: keys with '/' create subdirs. Key "d42ebe37/1" → file "d42ebe37/1.jsonl"
    const realDir = path.join(nodesDir, 'd42ebe37');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, '1.jsonl'),
      JSON.stringify({ evt: 'status_changed', id: 'd42ebe37/1', status: 'done', actor: 'overlay-sync', ts: '2026-06-15T00:00:00Z' }) + '\n'
    );

    // Run the script in dry-run mode — no writes
    const { spawnSync } = require('child_process');
    const dry = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'retire-phantom-nodes.js'),
      tmpDir,
    ], { encoding: 'utf8' });

    ok('14.1: retire-phantom-nodes dry-run exits 0', dry.status === 0);
    ok('14.2: dry-run identifies phantom1 (status ready) as candidate', dry.stdout.includes('to retire (non-terminal): 1'));
    ok('14.3: dry-run identifies phantom3 (status canceled) as already terminal', dry.stdout.includes('already terminal:      1'));

    // Verify dry-run did NOT write anything
    const afterDry = fs.readFileSync(phantom1, 'utf8');
    ok('14.4: dry-run does not modify phantom1 file', !afterDry.includes('retire-phantom-nodes'));

    // Run the script with --apply
    const apply = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'retire-phantom-nodes.js'),
      tmpDir,
      '--apply',
    ], { encoding: 'utf8' });

    ok('14.5: retire-phantom-nodes --apply exits 0', apply.status === 0);

    // Verify phantom1 now has a canceled status line
    const afterApply = fs.readFileSync(phantom1, 'utf8');
    ok('14.6: --apply appended canceled event to phantom1', afterApply.includes('"status":"canceled"') && afterApply.includes('retire-phantom-nodes'));

    // Verify phantom3 was NOT touched (already canceled)
    const phantom3After = fs.readFileSync(phantom3, 'utf8');
    const linesP3 = phantom3After.trim().split('\n').length;
    ok('14.7: --apply did NOT touch phantom3 (already canceled)', linesP3 === 1);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── SECTION 15: /overlay/gate (create_gate) ───────────────────────────────
  // 15.1: unknown blocking_task_key is rejected with 404
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ kind: 'human-approval', blocking_task_key: UNKNOWN_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/gate', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('15.1: /overlay/gate rejects unknown blocking_task_key with 404', r && r.status === 404);
    ok('15.2: /overlay/gate error mentions the unknown key', r && r.body && r.body.error && r.body.error.includes(UNKNOWN_KEY));
    // Confirm no gate node was written into the overlay
    const gateKeys = Object.keys(o.status || {}).filter((k) => k.startsWith('gate:'));
    ok('15.3: /overlay/gate creates no gate node when blocking_task_key is unknown', gateKeys.length === 0);
  }

  // 15.4: known blocking_task_key is accepted
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({ kind: 'human-approval', blocking_task_key: KNOWN_KEY });
    const route = overlayRoute(ctx);
    await route('/overlay/gate', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('15.4: /overlay/gate known blocking_task_key returns 200', r && r.status === 200);
    ok('15.5: /overlay/gate response includes gate_key', r && r.body && typeof r.body.gate_key === 'string');
  }

  // ── SECTION 16: /subconscious/assignment prepare dependency validation ──
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtx(o);
    ctx.readBody = async () => ({
      workspace: '/tmp/test-ws',
      action: 'prepare',
      task_key: 'codex/new-task',
      subject: 'New task',
      parent_task_keys: [UNKNOWN_TASK_KEY],
      repo_path: '/tmp/test-ws',
    });
    const route = require('../routes/subconscious')(ctx);
    await route('/subconscious/assignment', 'POST', { headers: {} }, {}, makeSP(), null);
    const r = getLastSent();
    ok('16.1: /subconscious/assignment prepare rejects unknown dependency with 404', r && r.status === 404);
    ok('16.2: /subconscious/assignment prepare creates no impl snapshot after unknown dependency', !(o.snapshots && o.snapshots['codex/new-task']));
    ok('16.3: /subconscious/assignment prepare creates no dependency snapshot after unknown dependency', !(o.snapshots && o.snapshots[UNKNOWN_TASK_KEY]));
    ok('16.4: /subconscious/assignment prepare creates no dependency edges after unknown dependency', o.edges.length === 0);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
