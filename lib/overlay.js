// Per-workspace overlay store: the things native tasks can't hold —
// cross-session dependency edges, richer statuses, and notes. Persisted to disk so it
// survives daemon restarts and is shared by every session in the workspace.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encodeWorkspace } = require('./native-tasks');
const graphStore = require('./graph-store');
const { normalizeTags, normalizeCategory } = require('./node-tags');
const runtimePaths = require('./runtime-paths');

const DIR = runtimePaths.runtimePath('overlay');
// edges: cross-session/workspace deps · status: richer-status overrides · notes: freeform
// summaries: on-complete "interface" summary per task (Tier-1 context) · knowledge: Tier-2
// context items per task · assignee: which agent is working a task (for live animation)
// timestamps: per-task { firstSeen, lastChanged, lastStatus } — daemon-observed task lifecycle
// features: per-feature-key { feature_branch, feature_worktree, base, createdAt } — the feature-tier
//   integration surface (orch/feature/<key>) grouping a feature's attempt tasks. Workers fork
//   attempts off feature_branch and auto-merge back into it (tier-1); feature->main is gated (tier-2).
//   Lightweight record (no new node kind) — enough for the dashboard to show feature -> tasks.
// git: per-task { branch, worktree, head, createdAt } — the isolated attempt worktree for a task
// repos: per-task absolute path of the TARGET git repo the loop should branch/measure/merge on,
//   when it differs from the daemon workspace. Absent ⇒ fall back to the workspace (back-compat).
// metrics: per-task INLINE metric spec for the metric-driven loop — { metric, direction (min|max),
//   measure_command, parse?, target?, guardrails? }. The objective an attempt's measure node runs &
//   the judge weighs. Absent ⇒ no metric (rationale-only judging, back-compat).
// measurements: per-task measured value(s) the measure node produced — { value, guardrails:{...},
//   measured_at, command, baseline?:{ value, guardrails, measured_at } }. `baseline` is the target
//   repo's current-main reference (no attempt applied) the judge weighs attempts against.
// benchmarks: per-task researched competitor/industry-average reference for the metric — { metric,
//   value, unit?, source, note?, confidence? (low|med|high), researched_at? }. The EXTERNAL axis the
//   judge compares the winning attempt's measured value against (beyond our own baseline). Absent ⇒
//   baseline-only judging (back-compat). Set by the self-learn-benchmark research agent.
// cancel_requested: per-task ISO timestamp — advisory cooperative-cancel flag set when a task is
//   canceled, so an in-flight worker can poll and self-terminate (cancel-wins concurrency).
// stop_requested: per-agent_id ISO timestamp — advisory cooperative-stop flag (cross-session agent
//   control). The worker polls it and self-terminates; no cross-process kill.
// guidance: escalation queue — items { id, question, context, trigger, ts, resolved, answer? }.
//   A pending (unresolved) item halts the autonomous loop until the user answers.
// optimize: per-problem converged-vs-iterate bookkeeping for the metric-driven loop (⑥) —
//   { closed?:bool, decision?, verdicts?:int (verdict count at last decision), at? }. `closed` ⇒
//   the loop has stopped iterating this problem (converged/budget/stuck); `verdicts` lets the loop
//   re-decide ONLY after a NEW judge round lands (count increased), so an 'iterate' can't tight-loop.
// epoch: monotonic counter bumped whenever a note/task node is ADDED — the "the graph changed"
//   watermark the incremental edge-judge keys off of. judgedAtEpoch: per-note-key map (key ->
//   epoch at which it was last adjudicated; absent/0 = never). A note is re-pullable by the judge
//   only when judgedAtEpoch[key] < epoch, so a 'no edge' verdict (stamps =epoch) keeps it out of the
//   queue until the graph actually changes. judgeCursor: persisted position the judge walks the work
//   queue from (advances + wraps across ticks; survives daemon restart so it never re-walks the whole
//   graph). All three are part of the RAG-candidate → agent-adjudicator edge pipeline (see lib/judge.js).
// judgedClusters: per dup-cluster-signature map (signature -> epoch at which the cluster was last
//   adjudicated by the node-judge). A cluster is re-judgeable only when its stored epoch < epoch OR
//   its membership (hence signature) changed — the NODE-dedup analogue of judgedAtEpoch for edges.
// snapshots: per-task adopted/frozen copy of native fields ({ subject, description, status,
//   blockedBy, owner, metadata, snapshotted_at }). Claude native tasks are adopted at first sight
//   (buildGraph); the snapshot is authoritative for structure while the native file is a live echo.
//   When the native file is gone (cleanupPeriodDays retention sweep) aggregateWorkspace falls back
//   to this snapshot. Pre-adoption back-compat: terminal status still mints a snapshot if none yet.
//   Also the substrate for DAEMON-ORIGINATED follow-up tasks (keys 'followup/<id>', no native file
//   ever exists — see lib/followups.js): same fallback serves them as live graph nodes.
// distinctClusters: per dup-cluster-signature map (signature -> ISO timestamp) marking a cluster the
//   user definitively judged DISTINCT ("don't ask again"). dupClusters/the judge queue SKIP any
//   signature present here forever — a deliberate, user-made call (only the user can say two
//   same-recall notes are genuinely different facts). Unlike judgedClusters (epoch-gated, re-judgeable
//   when membership/epoch changes) this is permanent for that exact member set.
const EMPTY = () => ({ edges: [], unwired: {}, status: {}, notes: {}, summaries: {}, knowledge: {}, assignee: {}, timestamps: {}, config: {}, git: {}, features: {}, repos: {}, metrics: {}, measurements: {}, benchmarks: {}, note_nodes: {}, snapshots: {}, cancel_requested: {}, stop_requested: {}, guidance: [], optimize: {}, epoch: 0, judgedAtEpoch: {}, judgeCursor: 0, judgedClusters: {}, distinctClusters: {}, forceClaims: {}, blocked: {}, usage_records: {}, task_costs: {}, usage_reconcile: {}, usage_reconcile_snapshot: null, dispatcher_focus: {}, taskVecs: {}, eagerJudge: {}, judgingSince: {}, edgeRejudge: {}, eagerJudgeLease: {}, spawnLease: {}, pendingDup: {}, entity_nodes: {}, claimSessions: {}, git_claims: {}, git_users: {}, work_sessions: {} });

// Default relevance weight for context edges (0..1). Pre-existing context edges with no stored
// `weight` read as this, so the field is backward-compatible (substrate for relevance traversal).
const DEFAULT_CONTEXT_WEIGHT = 0.5;
// Read an edge's relevance weight: only context edges carry one; absent ⇒ default. Returns null for
// non-context edges (blocking/supersede carry no weight). Clamps to [0,1] defensively.
function edgeWeight(e) {
  if (!e || e.kind !== 'context') return null;
  const w = typeof e.weight === 'number' ? e.weight : DEFAULT_CONTEXT_WEIGHT;
  return Math.max(0, Math.min(1, w));
}

// Collision-free overlay filename: encodeWorkspace is lossy (both `/` and `.` → `-`), so distinct
// workspaces could map to ONE file and clobber each other (review H2). Use a content hash, keeping a
// readable basename prefix for debuggability.
function fileFor(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${base}-${h}.json`);
}
// Pre-hash filename — read for one-time migration of overlays written before the H2 fix.
function legacyFileFor(workspace) {
  return path.join(DIR, `${encodeWorkspace(workspace)}.json`);
}

// Collision-free diagnostics filename (separate from overlay config, survives regeneration).
function diagnosticsFileFor(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${base}-${h}.diagnostics.json`);
}

function load(workspace) {
  let base;
  let o = null;
  try { o = JSON.parse(fs.readFileSync(fileFor(workspace), 'utf8')); }
  catch { try { o = JSON.parse(fs.readFileSync(legacyFileFor(workspace), 'utf8')); } catch { o = null; } }
  base = o ? { ...EMPTY(), ...o } : EMPTY();

  // Rehydrate shared fields from graph-store (edges, status, summaries, knowledge, note_nodes, snapshots).
  // Wrapped in try/catch — must never break load() for workspaces with no graph yet.
  try {
    const store = graphStore.forWorkspace(workspace);
    const g = graphStore.loadGraph(store);

    // edges
    if (g.edges.length) base.edges = g.edges;

    // Process both live nodes and checkpointed nodes the same way.
    const allNodes = { ...g.checkpointed, ...g.nodes };
    for (const [id, node] of Object.entries(allNodes)) {
      // status — skip the 'ready' sentinel: emitDiff writes status:'ready' when an override
      // was DELETED (releaseClaim / verdict release), because the append-only log can't express
      // deletion. Re-importing it as an explicit override would short-circuit dep derivation
      // (an override always wins in the scheduler), so 'ready' replays as "no override".
      if (node.status != null && node.status !== 'ready') base.status[id] = node.status;

      // summaries
      if (node.summary != null) base.summaries[id] = node.summary;

      // knowledge
      if (Array.isArray(node.knowledge) && node.knowledge.length > 0) base.knowledge[id] = node.knowledge;

      // note_nodes — reconstruct from graph node shape
      // Node keys are stored as 'note:' + bareId; strip the prefix so note_nodes
      // is keyed by the bare noteId (matching what addNoteNode returns).
      if (node.kind === 'note' && node.note) {
        const bareId = id.startsWith('note:') ? id.slice(5) : id;
        base.note_nodes[bareId] = {
          id: bareId,
          title:      node.note.title      || null,
          summary:    node.note.summary    || null,
          category:   node.note.category   || null,
          tags:       Array.isArray(node.note.tags) ? node.note.tags : [],
          created_by: node.note.created_by || null,
          created_at: node.note.valid_from || null,
          validFrom:  node.note.valid_from || null,
          knowledge:  Array.isArray(node.knowledge) ? node.knowledge : [],
          vec:        Array.isArray(node.vec) ? node.vec : null,
          validTo:     node.validTo     || null,
          supersededBy: node.supersededBy || null,
          supersedes:  node.supersedes  || null,
        };
      }

      // snapshots
      if (node.snapshot != null) base.snapshots[id] = node.snapshot;

      // assignee
      if (node.assignee != null) base.assignee[id] = node.assignee;

      // timestamps
      if (node.timestamps != null) base.timestamps[id] = node.timestamps;

      // metrics
      if (node.metrics != null) base.metrics[id] = node.metrics;

      // measurements
      if (node.measurements != null) base.measurements[id] = node.measurements;

      // usage_records — restore per-task usage records that survived via graph-store events
      if (node.usage_records && typeof node.usage_records === 'object') {
        for (const [agentId, slice] of Object.entries(node.usage_records)) {
          if (slice && agentId && !base.usage_records[agentId]) {
            base.usage_records[agentId] = slice;
          }
        }
      }
    }

    // benchmarks (stored on system:benchmarks node)
    const benchNode = allNodes['system:benchmarks'];
    if (benchNode && benchNode.benchmarks) base.benchmarks = benchNode.benchmarks;

    // repos (stored on system:repos node)
    const reposNode = allNodes['system:repos'];
    if (reposNode && reposNode.repos) base.repos = reposNode.repos;
  } catch { /* graph-store not yet initialised — fall back to empty shared fields */ }

  // Rehydrate diagnostics from separate storage
  try {
    const diag = getDiagnostics(workspace);
    if (diag) base.diagnostics = diag;
  } catch { /* diagnostics file not yet created or corrupt — fall back to empty */ }

  // Set prev-state baseline so the next emitDiff diff starts from the correct state
  // (otherwise it would re-emit everything as "new").
  try { graphStore.setPrevState(workspace, base); } catch { /* best-effort */ }

  return base;
}

function save(workspace, overlay, opts = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const dest = fileFor(workspace);
  const tmp = `${dest}.${process.pid}.tmp`;            // atomic write: temp + rename (review H1)
  const LOCAL_FIELDS = [
    'git', 'cancel_requested', 'stop_requested', 'config', 'unwired',
    'judgedAtEpoch', 'judgeCursor', 'judgedClusters', 'distinctClusters',
    // No graph-store event type covers these; without them here they'd be silently
    // dropped on every save/load round-trip (notes/guidance/optimize/epoch).
    'notes', 'guidance', 'optimize', 'epoch',
    // force-claim cap counters — must persist across daemon restarts
    'forceClaims',
    // explicit per-task block flags — must persist across daemon restarts + graph rebuilds
    'blocked',
    // MS3 usage accounting — hot-path agent slices + cold-path reconcile watermarks
    'usage_records', 'usage_reconcile', 'usage_reconcile_snapshot',
    // Rework-aware, role-tagged per-task cost rollup (accumulates across agent-run finishes).
    // Local-only: no graph-store event type covers it, so it must round-trip via the overlay file.
    'task_costs',
    'dispatcher_focus',
    // Runtime execution state and local diagnostics. Git-synced claim files are advisory audit
    // records; these local fields are the daemon's live/session view and must not enter graph-store.
    'claimSessions', 'git_claims', 'git_users', 'work_sessions', 'spawnLease',
    // TASK embeddings: { taskKey -> [vec, ...] } (multi-vec schema). Local-only — no graph-store
    // event type covers them, so they must round-trip through the overlay file like notes/git.
    'taskVecs',
    // EAGER JUDGE (task C): node keys with fresh unjudged candidate edges awaiting immediate
    // adjudication. Persisted so a daemon restart mid-burst doesn't drop the eager dispatch.
    'eagerJudge',
    // JUDGING→READY gate (task D): wall-clock anchor { nodeKey -> ms } for the judging timeout.
    // Persisted so a daemon restart does NOT reset the deadlock-prevention clock (the timeout is
    // measured from when edges were seeded, not from boot).
    'judgingSince',
    // Event-triggered re-judgment map.
    'edgeRejudge',
    // EAGER JUDGE LEASE (task 27): per-node dispatch lease.
    'eagerJudgeLease',
    // PENDING-DUP defer-to-judge (write-time dup guard): { noteKey -> { match, score } } for notes
    // ADMITTED provisional on a dup-guard fire. A pending_dup note is RETRIEVAL-INVISIBLE (excluded
    // from /search recall) and enqueued for the dup-judge. Persisted so the invisibility + the queued
    // adjudication survive a daemon restart (a dropped entry would silently make the note visible).
    'pendingDup',
    // ENTITY NODES (Phase 2: conversational-memory entity layer): { entityId -> {id,kind,name,type,...} }
    // No graph-store event type yet — local-only round-trip via the overlay file (same as note_nodes).
    'entity_nodes',
  ];
  const localOnly = Object.fromEntries(LOCAL_FIELDS.map(k => [k, overlay[k] ?? EMPTY()[k]]));
  fs.writeFileSync(tmp, JSON.stringify(localOnly, null, 2));
  fs.renameSync(tmp, dest);
  if (opts.deferred) {
    setImmediate(() => { try { emitDiff(workspace, overlay); } catch {} });
  } else {
    try { emitDiff(workspace, overlay); } catch { /* best-effort — never break the overlay save */ }
  }
}

// Emit graph-store events for any shared fields that changed since the last save.
// Wrapped in try/catch by the caller — failures must not surface to callers of save().
function emitDiff(workspace, overlay) {
  const store = graphStore.forWorkspace(workspace);
  const prev  = graphStore.getPrevState(workspace);
  const ts    = new Date().toISOString();

  // edges — emit edge_added for each edge not in prev (matched by from+to+kind+fromWorkspace)
  const edgeSig = (e) => `${e.from}\0${e.to}\0${e.kind || 'blocking'}\0${e.fromWorkspace || ''}`;
  const prevEdgeBySig = new Map((prev.edges || []).map((e) => [edgeSig(e), e]));
  for (const e of (overlay.edges || [])) {
    const sig = edgeSig(e);
    const prevE = prevEdgeBySig.get(sig);
    if (prevE) {
      // EXISTING edge: edge_added's sig (from+to+kind+fromWorkspace) is invariant under keepEdge's
      // IN-PLACE promotion (weight 0→score, judged false→true, by→'judge'), so the new-edge branch
      // skips it and the promotion never reaches the event log — on a non-live reload the original
      // weight-0/unjudged edge_added wins (replay dedupes on first sight), so the kept edge stays
      // retrieval-invisible. Emit edge_promoted to carry the changed judging fields; graph-store's
      // replay applies it onto the already-seen edge. Only when a tracked field actually changed, so
      // genuinely-new edges (handled below) and unchanged edges never double-emit.
      const changed = prevE.weight !== e.weight || prevE.judged !== e.judged
        || prevE.by !== e.by || prevE.score !== e.score;
      if (changed) {
        const ev = { evt: 'edge_promoted', from: e.from, to: e.to, kind: e.kind || 'blocking', actor: 'overlay-sync', ts };
        if (e.fromWorkspace) ev.fromWorkspace = e.fromWorkspace;
        if (typeof e.weight === 'number') ev.weight = e.weight;
        if (e.by !== undefined) ev.by = e.by;
        if (e.judged !== undefined) ev.judged = e.judged;
        if (typeof e.score === 'number') ev.score = e.score;
        if (e.origin !== undefined) ev.origin = e.origin;
        graphStore.appendEvent(store, e.from, ev);
      }
      continue;
    }
    const ev = { evt: 'edge_added', from: e.from, to: e.to, kind: e.kind || 'blocking', actor: 'overlay-sync', ts };
    if (e.fromWorkspace) ev.fromWorkspace = e.fromWorkspace;
    if (typeof e.weight === 'number') ev.weight = e.weight;
    // Persist edge judging metadata (by/judged/score/origin) so the judging→ready gate survives a
    // daemon restart — without these the reloaded edge loses judged:false and the gate silently no-ops.
    if (e.by !== undefined) ev.by = e.by;
    if (e.judged !== undefined) ev.judged = e.judged;
    if (typeof e.score === 'number') ev.score = e.score;
    if (e.origin !== undefined) ev.origin = e.origin;
    graphStore.appendEvent(store, e.from, ev);
  }
  for (const e of (prev.edges || [])) {
    const sig = edgeSig(e);
    const stillPresent = (overlay.edges || []).some((cur) => edgeSig(cur) === sig);
    if (stillPresent) continue;
    const ev = { evt: 'edge_removed', from: e.from, to: e.to, kind: e.kind || 'blocking', actor: 'overlay-sync', ts };
    if (e.fromWorkspace) ev.fromWorkspace = e.fromWorkspace;
    graphStore.appendEvent(store, e.from, ev);
  }

  // status — emit status_changed for each key whose value changed
  for (const [nodeId, status] of Object.entries(overlay.status || {})) {
    if ((prev.status || {})[nodeId] === status) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'status_changed', id: nodeId, workspace, status, actor: 'overlay-sync', ts });
  }
  // status cleared — a key present in prev but now ABSENT had its override deleted (releaseClaim:
  // a swept/stale claim re-derives to available). The event log is append-only, so without an
  // explicit event the persisted store would keep replaying the stale 'in_progress' on the next
  // load(). Emit 'ready' so the released state survives a daemon restart (restart resilience).
  for (const nodeId of Object.keys(prev.status || {})) {
    if (Object.prototype.hasOwnProperty.call(overlay.status || {}, nodeId)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'status_changed', id: nodeId, workspace, status: 'ready', actor: 'overlay-sync', ts });
  }

  // summaries — emit summary_set for each key whose value changed
  for (const [nodeId, summary] of Object.entries(overlay.summaries || {})) {
    if ((prev.summaries || {})[nodeId] === summary) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'summary_set', id: nodeId, workspace, summary, actor: 'overlay-sync', ts });
  }

  // knowledge — emit knowledge_added for each new item beyond the previously seen count
  for (const [nodeId, items] of Object.entries(overlay.knowledge || {})) {
    if (!Array.isArray(items)) continue;
    const prevLen = (prev.knowledge || {})[nodeId] || 0;
    for (let i = prevLen; i < items.length; i++) {
      graphStore.appendEvent(store, nodeId, { evt: 'knowledge_added', id: nodeId, workspace, item: items[i], actor: 'overlay-sync', ts });
    }
  }

  // note_nodes — emit note_created for each key not in prev
  for (const [noteId, n] of Object.entries(overlay.note_nodes || {})) {
    if ((prev.note_nodes || {})[noteId]) continue;
    graphStore.appendEvent(store, 'note:' + noteId, { evt: 'note_created', id: noteId, workspace, title: n.title, summary: n.summary, created_by: n.created_by, valid_from: n.validFrom || n.valid_from, vec: Array.isArray(n.vec) ? n.vec : null, vecs: (Array.isArray(n.vecs) && n.vecs.length) ? n.vecs : null, actor: 'overlay-sync', ts });
  }

  // snapshots — emit snapshot_stored for each new key or changed snapshotted_at
  for (const [nodeId, snap] of Object.entries(overlay.snapshots || {})) {
    const prevSnap = (prev.snapshots || {})[nodeId];
    if (prevSnap && prevSnap.snapshotted_at === snap.snapshotted_at) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'snapshot_stored', id: nodeId, workspace, subject: snap.subject, description: snap.description, status: snap.status, blockedBy: snap.blockedBy, owner: snap.owner, metadata: snap.metadata, snapshotted_at: snap.snapshotted_at, actor: 'overlay-sync', ts });
  }

  // assignee — emit assignee_set for each key whose value changed
  for (const [nodeId, assignee] of Object.entries(overlay.assignee || {})) {
    if (JSON.stringify((prev.assignee || {})[nodeId]) === JSON.stringify(assignee)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'assignee_set', id: nodeId, workspace, assignee, actor: 'overlay-sync', ts });
  }

  // timestamps — emit timestamps_set for each key whose value changed
  for (const [nodeId, timestamps] of Object.entries(overlay.timestamps || {})) {
    if (JSON.stringify((prev.timestamps || {})[nodeId]) === JSON.stringify(timestamps)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'timestamps_set', id: nodeId, workspace, timestamps, actor: 'overlay-sync', ts });
  }

  // metrics — emit metrics_set for each key whose value changed
  for (const [nodeId, metrics] of Object.entries(overlay.metrics || {})) {
    if (JSON.stringify((prev.metrics || {})[nodeId]) === JSON.stringify(metrics)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'metrics_set', id: nodeId, workspace, metrics, actor: 'overlay-sync', ts });
  }

  // measurements — emit measurements_set for each key whose value changed
  for (const [nodeId, measurements] of Object.entries(overlay.measurements || {})) {
    if (JSON.stringify((prev.measurements || {})[nodeId]) === JSON.stringify(measurements)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'measurements_set', id: nodeId, workspace, measurements, actor: 'overlay-sync', ts });
  }

  // usage_records — emit usage_recorded for each new agent_id slice attributed to a task
  for (const [agentId, slice] of Object.entries(overlay.usage_records || {})) {
    if ((prev.usage_records || {})[agentId]) continue; // already emitted
    const taskKey = slice && slice.task_key;
    if (!taskKey || !slice) continue; // only persist slices that are attributed to a task
    graphStore.appendEvent(store, taskKey, { evt: 'usage_recorded', id: taskKey, workspace, agent_id: agentId, slice, actor: 'overlay-sync', ts });
  }

  // benchmarks — emit benchmarks_set on system:benchmarks node for any change
  if (overlay.benchmarks && JSON.stringify(prev.benchmarks || {}) !== JSON.stringify(overlay.benchmarks)) {
    graphStore.appendEvent(store, 'system:benchmarks', { evt: 'benchmarks_set', workspace, benchmarks: overlay.benchmarks, actor: 'overlay-sync', ts });
  }

  // repos — emit repo_config_set on system:repos node for any change
  if (overlay.repos && JSON.stringify(prev.repos || {}) !== JSON.stringify(overlay.repos)) {
    graphStore.appendEvent(store, 'system:repos', { evt: 'repo_config_set', workspace, repos: overlay.repos, actor: 'overlay-sync', ts });
  }

  graphStore.setPrevState(workspace, overlay);
}

// Add a dependency edge from -> to. Idempotent.
//   kind 'blocking' (default): `to` is blocked by `from` (scheduling — gates readiness).
//   kind 'context': non-blocking provenance — `from`'s summary flows into `to` as Tier-1
//     context even when `from` is already done. Lets new tasks pull existing nodes' summaries
//     without making the graph a flat list of roots.
//   kind 'supersede': non-blocking replacement link from=OLD -> to=NEW. Does NOT gate readiness
//     and does NOT flow summaries; it only records that `from` was retired in favor of `to`, so a
//     replan reads as old→new instead of leaving orphaned canceled duplicates beside fresh ones.
// fromWorkspace set ⇒ ghost edge: the provider `from` lives in another workspace.
// Stored in the CONSUMER's overlay (the workspace owning `to`).
// weight (0..1, context edges only): optional relevance scalar for spreading-activation traversal.
// Absent ⇒ DEFAULT_CONTEXT_WEIGHT when read back. Ignored for blocking/supersede edges.
// meta (optional, context edges only): provenance fields stamped on a NEW edge — {by, judged, score, origin}.
// Autowire passes {by:'autowire', judged:false, score:<cosine>} together with weight 0 so the edge is
// retrieval-invisible (weight-0 multiplier) until the judge promotes it. `score` preserves the recall
// cosine so a keep-verdict can seed the promoted weight from it. `origin` records HOW the edge was
// created ('autowire-lexical' | 'autowire-semantic' | 'asserted') so keepRateByBand can isolate the
// threshold-gated population (autowire-lexical) from hand-asserted note edges. Not applied to blocking/supersede.
function addEdge(overlay, from, to, fromWorkspace, kind, weight, meta) {
  const fw = fromWorkspace || null;
  // Wiring an edge clears the unwired quarantine on either endpoint — the task is now
  // structurally connected to the graph (see daemon.js unwired stamp + /mark-root).
  if (overlay.unwired) { delete overlay.unwired[to]; delete overlay.unwired[from]; }
  const w = (kind === 'context' && typeof weight === 'number') ? Math.max(0, Math.min(1, weight)) : undefined;
  const existing = overlay.edges.find((e) => e.from === from && e.to === to && (e.fromWorkspace || null) === fw);
  if (existing) {
    if (kind === 'context') {
      existing.kind = 'context'; if (w !== undefined) existing.weight = w;  // upgrade blocking → context on re-add (never silently downgrade)
      // Also apply judge-pipeline meta fields so the upgraded edge enters the judge queue correctly.
      if (meta) {
        if (meta.by !== undefined) existing.by = meta.by;
        if (meta.judged !== undefined) existing.judged = meta.judged;
        if (meta.origin !== undefined) existing.origin = meta.origin;
        if (typeof meta.score === 'number') existing.score = Math.max(0, Math.min(1, meta.score));
      }
    } else if (kind === 'supersede') existing.kind = 'supersede';
    return overlay;
  }
  const edge = { from, to };
  if (fromWorkspace) edge.fromWorkspace = fromWorkspace;
  if (kind === 'context' || kind === 'supersede') edge.kind = kind; // omit for blocking (absent = blocking, back-compat)
  if (w !== undefined) edge.weight = w; // omit when unspecified (absent = DEFAULT_CONTEXT_WEIGHT, back-compat)
  if (meta && kind === 'context') {
    if (meta.by !== undefined) edge.by = meta.by;
    if (meta.judged !== undefined) edge.judged = meta.judged;
    if (typeof meta.score === 'number') edge.score = Math.max(0, Math.min(1, meta.score));
    if (meta.origin !== undefined) edge.origin = meta.origin;
  }
  // Blocking edges carry origin for provenance (e.g. 'native-blockedBy') but never judged/weight/by —
  // they are structurally certain and NEVER queued for judge re-adjudication.
  // isUnverifiedEdge() already excludes them (requires kind==='context' && judged===false).
  if (meta && kind !== 'context' && kind !== 'supersede') {
    if (meta.origin !== undefined) edge.origin = meta.origin;
  }
  overlay.edges.push(edge);
  // NEIGHBORHOOD-CHANGE RE-JUDGMENT (task /23): when a new autowire CANDIDATE edge (judged:false,
  // by:'autowire') is added between two EXISTING nodes, either endpoint's neighborhood has changed --
  // its existing unjudged candidate edges might get different verdicts with the new neighbor present.
  // Re-mark any endpoint that already has OTHER unjudged context edges so the heartbeat re-dispatches
  // a judge for it. Guard: only fires on autowire candidates (not on promoted/judged edges or
  // hand-asserted edges), preventing the cascade: keep-verdict addEdge(judged:true) NO re-mark.
  if (kind === 'context' && meta && meta.by === 'autowire' && meta.judged === false) {
    const newEdge = edge; // already pushed
    function hasOtherUnjudged(nodeKey) {
      return overlay.edges.some(function(e) {
        return e !== newEdge && e.kind === 'context' && e.judged === false &&
               (e.from === nodeKey || e.to === nodeKey);
      });
    }
    if (hasOtherUnjudged(from)) markEagerJudge(overlay, from);
    if (hasOtherUnjudged(to)) markEagerJudge(overlay, to);
  }
  return overlay;
}

// Remove dependency edge(s) from -> to. Idempotent (no-op if none match). Mirrors addEdge's
// match on (from, to, fromWorkspace). If kind is given, only edges of that kind are removed
// ('blocking' = absent/!=context; 'context' = kind==='context'); otherwise all matches go.
// Lets a graph be re-parallelized by dropping stale prerequisite edges. Returns overlay.
function removeEdge(overlay, from, to, fromWorkspace, kind) {
  const fw = fromWorkspace || null;
  overlay.edges = overlay.edges.filter((e) => {
    if (!(e.from === from && e.to === to && (e.fromWorkspace || null) === fw)) return true;
    if (kind === 'context') return e.kind !== 'context';
    if (kind === 'blocking') return e.kind === 'context';
    return false; // no kind filter: drop every match
  });
  return overlay;
}

function setStatus(overlay, key, status, note) {
  overlay.status[key] = status;
  if (note != null) overlay.notes[key] = String(note).slice(0, 280);
  return overlay;
}

// Record/merge the git attempt worktree info for a task. Stamps createdAt on first write.
function setGit(overlay, key, info) {
  overlay.git[key] = { ...(overlay.git[key] || { createdAt: new Date().toISOString() }), ...info };
  return overlay;
}

// Record/merge the feature-tier integration record for a feature key. Stamps createdAt on first
// write. Lightweight grouping node (feature_branch/feature_worktree/base) so the dashboard can show
// feature -> tasks; clear the whole record with a falsy info.
function setFeature(overlay, key, info) {
  if (!overlay.features) overlay.features = {};
  if (info) overlay.features[key] = { ...(overlay.features[key] || { createdAt: new Date().toISOString() }), ...info };
  else delete overlay.features[key];
  return overlay;
}

// Set (or clear, with a falsy repoPath) the target repo path a task's git ops should run against.
function setRepo(overlay, key, repoPath) {
  if (!overlay.repos) overlay.repos = {};
  if (repoPath) overlay.repos[key] = String(repoPath);
  else delete overlay.repos[key];
  return overlay;
}

// Per-repo TEST COMMAND registry, keyed by ABSOLUTE repo path, nested under config (so it
// persists alongside the rest of the workspace config). Set (or clear, with a falsy cmd) how a
// repo's test suite is run. STORE/RETRIEVE ONLY — the daemon never executes these; agents
// (e.g. the nightly QA loop) look the command up and run it themselves.
function setTestCmd(overlay, repoPath, cmd) {
  if (!overlay.config) overlay.config = {};
  if (!overlay.config.test_cmds) overlay.config.test_cmds = {};
  if (cmd) overlay.config.test_cmds[String(repoPath)] = String(cmd);
  else delete overlay.config.test_cmds[repoPath];
  return overlay;
}

// Read a repo's stored test command (null when unset / no repo).
function testCmdFor(overlay, repoPath) {
  return (repoPath && overlay.config && overlay.config.test_cmds && overlay.config.test_cmds[repoPath]) || null;
}

// SELECTABLE LLM BACKEND (pluggable-backend feature). The dashboard-selected backend lives under
// overlay.config.backend = { provider, model } — nested in config so it persists with the rest of
// the workspace config (config is in save()'s LOCAL_FIELDS, so this round-trips with zero new wiring).
// UNSET ⇒ treated as the Claude default by getActiveBackend in lib/llm-backend.js (no value is
// written here for the default — absence IS the default, so a fresh overlay stays back-compatible).
// STORE/RETRIEVE ONLY — provider-id validation lives in the daemon endpoint (routes/config.js),
// the same division of labor as setMetricSpec/setBenchmark.
//   provider {string} — the registry id (e.g. 'claude', 'openrouter').
//   model    {string} — optional model id carried through to the provider's buildInvocation.
function setBackendConfig(overlay, { provider, model } = {}) {
  if (!overlay.config) overlay.config = {};
  if (!provider) { delete overlay.config.backend; return overlay; } // falsy provider clears → default
  const backend = { provider: String(provider) };
  if (model) backend.model = String(model);
  overlay.config.backend = backend;
  return overlay;
}

// Read the configured backend selection ({ provider, model }) or null when unset (= Claude default).
// Pure read; does NOT resolve the provider object (that's getActiveBackend's job in lib/llm-backend.js).
function getBackendConfig(overlay) {
  return (overlay && overlay.config && overlay.config.backend) || null;
}

// Set (or clear, with a falsy spec) the INLINE metric spec a task is optimizing. The spec shape
// is { metric, direction (min|max), measure_command, parse?, target?, guardrails? }; validation
// lives in the daemon endpoint — this just stores/clears what it's handed.
function setMetricSpec(overlay, key, spec) {
  if (!overlay.metrics) overlay.metrics = {};
  if (spec) overlay.metrics[key] = spec;
  else delete overlay.metrics[key];
  return overlay;
}

// Merge measured value(s) onto a task node (the measure node's output). `data` is a partial —
// e.g. { value, guardrails, measured_at, command } for an attempt, or { baseline: {...} } for the
// repo's current-main reference — so an attempt measurement and its baseline can be set separately
// without clobbering each other. Pass a falsy data to clear the whole record.
function setMeasurement(overlay, key, data) {
  if (!overlay.measurements) overlay.measurements = {};
  if (data) overlay.measurements[key] = { ...(overlay.measurements[key] || {}), ...data };
  else delete overlay.measurements[key];
  return overlay;
}

// Freeze a task's native fields into the overlay (see the `snapshots` field doc above). `data` is
// the snapshot record ({ subject, description, status, blockedBy, owner, metadata }); stamps
// snapshotted_at. Re-snapshotting a key overwrites — last terminal transition wins.
function setSnapshot(overlay, key, data) {
  if (!overlay.snapshots) overlay.snapshots = {};
  overlay.snapshots[key] = { ...data, snapshotted_at: new Date().toISOString() };
  return overlay;
}

// Set (or clear, with falsy data) the researched competitor/industry-average benchmark for a task's
// metric. A record is { metric, value, unit?, source, note?, confidence?, researched_at? }; validation
// lives in the daemon endpoint — this just stores/clears what it's handed.
function setBenchmark(overlay, key, data) {
  if (!overlay.benchmarks) overlay.benchmarks = {};
  if (data) overlay.benchmarks[key] = data;
  else delete overlay.benchmarks[key];
  return overlay;
}

// Add a "note node": an overlay-only graph node capturing durable conversation knowledge
// (a decision/finding) as a Tier-1 context provider. It is NOT a native todo — it lives only
// in the overlay and surfaces in the graph via buildGraph + context edges. Returns the id.
// `vec` (optional): a precomputed semantic embedding (384 floats) of the note's title+summary,
// stored beside the note for brute-force cosine retrieval in /search. The daemon computes it (embed
// is async; this store stays sync) — absent ⇒ the note falls back to lexical scoring (back-compat).
// `vecs` (optional): the precomputed FIELD-LEVEL embedding set (array of 384-float vectors, one per
// salient field — title/summary/each knowledge[] entry; see lib/node-tags noteFieldTexts). The pooled
// `vec` stays the gate/dedup vector; `vecs` upgrades corpus scoring (nodeVecs prefers `.vecs`). Absent
// ⇒ the note scores on the single pooled `.vec` exactly as before.
function addNoteNode(overlay, { title, summary, knowledge, created_by, valid_from, vec, vecs, category, tags }) {
  // Collision-safe id: Date.now() alone collides for notes created in the same millisecond (back-to-
  // back record_decision / supersede calls would clobber each other). Append a short random suffix.
  let id;
  do { id = `note-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; } while (overlay.note_nodes[id]);
  const created = new Date().toISOString();
  overlay.note_nodes[id] = {
    id,
    title: String(title || '').slice(0, 200),
    summary: String(summary || '').slice(0, 2000),
    category: normalizeCategory(category),
    tags: normalizeTags(tags),
    knowledge: Array.isArray(knowledge) ? knowledge : [],
    created_by: created_by || null,
    created_at: created,
    // Truly bitemporal: two independent time axes, both queryable, for state-change reasoning (the Zep gap):
    //   VALID time — when the fact was true in the world. validFrom/validTo below; query via /search?asOf=T
    //     (the note CURRENT at T). validFrom defaults to creation but a caller may BACKDATE it.
    //   TRANSACTION time — when the KB LEARNED the fact. That's created_at (above), always = real
    //     insertion instant, never backdated; query via /search?knownAsOf=T (notes RECORDED by T). This
    //     is what stops a backdated valid_from from silently rewriting an earlier-knowledge query.
    //   The two compose: asOf=true-as-of-T1 & knownAsOf=recorded-by-T2 = the canonical bitemporal query.
    //
    //   validFrom — when this fact BECAME true (defaults to creation time; a caller may backdate it).
    //   validTo   — when it STOPPED being true (null ⇒ still current). Set when superseded, never
    //               deleting the row, so as-of retrieval can recover the fact CURRENT at any time.
    //   supersedes / supersededBy — the chain links (note id ↔ note id), history preserved.
    validFrom: valid_from ? String(valid_from) : created,
    validTo: null,
    supersedes: null,
    supersededBy: null,
    // Semantic embedding (384 floats) of title+summary for cosine retrieval; null ⇒ lexical fallback.
    vec: Array.isArray(vec) ? vec : null,
    // Field-level embedding set (array of 384-float vectors) for multi-vec corpus scoring; null ⇒
    // fall back to the single pooled `.vec`. Only stored when a non-empty array is supplied so the
    // back-compat single-.vec shape stays clean.
    vecs: (Array.isArray(vecs) && vecs.length) ? vecs : null,
  };
  return id;
}

// Supersede note `oldId` with `newId` WITHOUT deleting history: stamp validTo on the old note (when
// it stopped being true = the new note's validFrom), link old↔new both directions, and chain the new
// note's `supersedes` back. Idempotent-ish: re-linking the same pair just refreshes the stamps.
// Returns { ok, error? }. `at` (ISO) lets the caller set the changeover instant explicitly; absent ⇒
// the new note's validFrom (or now).
function supersedeNote(overlay, oldId, newId, at, workspace) {
  const nn = overlay.note_nodes || {};
  const oldN = nn[oldId];
  const newN = nn[newId];
  if (!oldN) return { ok: false, error: `unknown note ${oldId}` };
  if (!newN) return { ok: false, error: `unknown note ${newId}` };
  if (oldId === newId) return { ok: false, error: 'cannot supersede a note with itself' };
  const changeover = at ? String(at) : (newN.validFrom || new Date().toISOString());
  oldN.validTo = changeover;
  oldN.supersededBy = newId;
  newN.validFrom = changeover;          // the new fact becomes true exactly when the old one ends
  newN.supersedes = oldId;
  // Persist supersede relationship to graph-store so it survives daemon reload.
  if (workspace) {
    try {
      const store = graphStore.forWorkspace(workspace);
      graphStore.appendEvent(store, 'note:' + oldId, { evt: 'note_superseded', id: oldId, supersededBy: newId, validTo: changeover, ts: changeover, actor: 'supersede' });
      graphStore.appendEvent(store, 'note:' + newId, { evt: 'note_supersedes', id: newId, supersedes: oldId, ts: changeover, actor: 'supersede' });
    } catch { /* graph-store not yet initialised — in-memory only (back-compat) */ }
  }
  return { ok: true, at: changeover };
}

// Walk the full supersede chain a note belongs to, oldest → newest, as an ordered list of ids.
// Pure read over note_nodes; follows supersedes backward to the root then supersededBy forward.
function noteChain(overlay, id) {
  const nn = overlay.note_nodes || {};
  if (!nn[id]) return [];
  let root = id;
  const seen = new Set();
  while (nn[root] && nn[root].supersedes && !seen.has(root)) { seen.add(root); root = nn[root].supersedes; }
  const chain = [];
  const fwd = new Set();
  let cur = root;
  while (nn[cur] && !fwd.has(cur)) { fwd.add(cur); chain.push(cur); cur = nn[cur].supersededBy; }
  return chain;
}

// Push an escalation/guidance item onto the queue. Severity tiers: 'blocking' halts the autonomous
// loop (the caller sets loop.active=false); 'review' queues for the user WITHOUT pausing (judge
// housekeeping — supersede/dup-cluster confirmations). Anything else defaults to 'blocking' (safe:
// explicit escalations keep pausing). Returns the new item's id.
// `action` (optional): a structured, machine-actionable payload the dashboard renders into buttons and
// the resolver acts on without re-deriving anything. Shape is action-kind specific, e.g.
//   { kind:'dup-cluster', keys:[...], signature, notes:[{key,title,created_at}] }.
// Absent ⇒ a plain text-answer guidance item (unchanged, back-compat).
function findPendingGuidance(overlay, pred) {
  return (overlay.guidance || []).find((g) => !g.resolved && pred(g)) || null;
}

// Normalize a question for dedup matching: lowercase, strip punctuation, collapse whitespace.
function normQuestion(q) {
  return String(q || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function addGuidance(overlay, { question, context, trigger, severity, action, origin_task, origin_notes }) {
  if (!Array.isArray(overlay.guidance)) overlay.guidance = [];
  if (action && typeof action === 'object') {
    if (action.kind === 'dup-cluster') {
      const sig = action.signature || clusterSig(action.keys);
      const existing = findPendingGuidance(overlay, (g) => g.action && g.action.kind === 'dup-cluster'
        && (g.action.signature || clusterSig(g.action.keys)) === sig);
      if (existing) return existing.id;
    }
    if (action.kind === 'follow-up' && action.task_key) {
      const existing = findPendingGuidance(overlay, (g) => g.action && g.action.kind === 'follow-up'
        && g.action.task_key === action.task_key);
      if (existing) return existing.id;
    }
  } else {
    // (C) PLAIN-ESCALATION DEDUP: a plain text guidance (no action) bound to an origin task collapses
    // onto an existing pending item with the SAME origin_task AND a normalized-question match — so a
    // worker re-asking the same question (e.g. on a retry) reuses the open row instead of stacking dups.
    const ot = origin_task != null ? String(origin_task) : null;
    if (ot) {
      const nq = normQuestion(question);
      const existing = findPendingGuidance(overlay, (g) => !g.action
        && g.origin_task === ot && normQuestion(g.question) === nq);
      if (existing) return existing.id;
    }
  }
  const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    question: String(question || '').slice(0, 1000),
    context: String(context || '').slice(0, 2000),
    trigger: trigger ? String(trigger).slice(0, 80) : null,
    severity: severity === 'review' ? 'review' : 'blocking',
    ts: new Date().toISOString(),
    resolved: false,
    // (A) ORIGIN BINDING: the task that triggered this escalation and the note keys the gate recalled.
    // The staleness sweep uses these to auto-resolve guidance whose triggering context is gone.
    origin_task: origin_task != null ? String(origin_task) : null,
    origin_notes: Array.isArray(origin_notes) ? origin_notes.map(String) : [],
  };
  if (action && typeof action === 'object') item.action = action;   // structured, action-aware guidance
  overlay.guidance.push(item);
  return id;
}

// Mark a guidance item resolved, recording the user's answer. Returns true if found.
function resolveGuidance(overlay, id, answer) {
  if (!Array.isArray(overlay.guidance)) return false;
  const it = overlay.guidance.find((g) => g.id === id);
  if (!it) return false;
  it.resolved = true;
  it.resolvedAt = new Date().toISOString();
  if (answer != null) it.answer = String(answer).slice(0, 2000);
  return true;
}

// Stable signature of a dup-cluster = its sorted note keys joined by '|'. MUST match
// judge.clusterSignature so a signature marked distinct here is recognized by dupClusters/the queue.
// Kept local to avoid a circular require (judge.js → embed; overlay must stay dependency-light).
function clusterSig(keys) {
  return (Array.isArray(keys) ? keys.slice() : []).sort().join('|');
}

// Permanently mark a dup-cluster signature as user-judged DISTINCT ("don't ask again"). dupClusters
// and the judge queue skip it forever. Idempotent; stamps the time of the decision. Returns the sig.
function markClusterDistinct(overlay, keys) {
  if (!overlay.distinctClusters) overlay.distinctClusters = {};
  const sig = clusterSig(keys);
  overlay.distinctClusters[sig] = new Date().toISOString();
  return sig;
}

// Was this cluster signature definitively marked distinct by the user? Pure read.
function isClusterDistinct(overlay, keys) {
  const d = overlay.distinctClusters || {};
  return Object.prototype.hasOwnProperty.call(d, clusterSig(keys));
}

// Lazy one-time severity migration: legacy items predate the field. Judge-housekeeping questions
// (supersede / dup-cluster confirmations) become 'review'; everything else stays 'blocking' (safe
// default). Stamps the item in place so the next overlay save persists it.
const REVIEW_PREFIXES = ['Possible supersede:', 'Ambiguous duplicate cluster'];
function guidanceSeverity(g) {
  if (g.severity !== 'blocking' && g.severity !== 'review') {
    g.severity = REVIEW_PREFIXES.some((p) => String(g.question || '').startsWith(p)) ? 'review' : 'blocking';
  }
  return g.severity;
}

// Collapse duplicate unresolved dup-cluster rows (same signature filed on each judge pass).
function dedupeGuidanceClusters(overlay) {
  const seen = new Map();
  const collapsed = [];
  for (const g of overlay.guidance || []) {
    if (g.resolved || !g.action || g.action.kind !== 'dup-cluster') continue;
    const sig = g.action.signature || clusterSig(g.action.keys);
    if (!seen.has(sig)) { seen.set(sig, g.id); continue; }
    g.resolved = true;
    g.resolvedAt = new Date().toISOString();
    g.answer = 'collapsed duplicate guidance';
    collapsed.push(g.id);
  }
  return collapsed;
}

const pendingGuidance = (overlay) => (Array.isArray(overlay.guidance) ? overlay.guidance.filter((g) => !g.resolved).map((g) => (guidanceSeverity(g), g)) : []);

// Record the optimize-loop's decision for a problem (⑥): merge a partial onto overlay.optimize[key]
// — e.g. { closed:true, decision } to stop iterating, or { verdicts } to remember the verdict count
// at the last 'iterate' so the loop only re-decides after a NEW round. Stamps `at`. Returns overlay.
function setOptimize(overlay, key, data) {
  if (!overlay.optimize) overlay.optimize = {};
  overlay.optimize[key] = { ...(overlay.optimize[key] || {}), ...data, at: new Date().toISOString() };
  return overlay;
}

// Bump the graph-change epoch (a note/task node was added). Monotonic; initializes a legacy overlay
// that predates the field. Returns the new epoch. The edge-judge re-pulls notes whose judgedAtEpoch
// is below this, so a NEW node makes previously-judged neighbors eligible to re-adjudicate.
function bumpEpoch(overlay) {
  overlay.epoch = (overlay.epoch || 0) + 1;
  return overlay.epoch;
}

// EAGER JUDGE signal (task C): mark a node as having FRESH unjudged candidate edges that should be
// adjudicated IMMEDIATELY, not on the next periodic drain. Called at the autowire seed callsites when
// a new task (B's whole-graph recall) or new note (autowireNoteProvider) seeds candidate edges. The
// daemon stays DUMB: it only RECORDS that this node needs judging now; the orchestration layer reads
// eagerJudgeNodes() and dispatches. Stamps the current epoch so FIFO-ish ordering survives a restart.
// Idempotent — re-marking a still-pending node just refreshes its stamp. Pure mutation; caller saves.
function markEagerJudge(overlay, nodeKey) {
  if (!nodeKey) return overlay;
  if (!overlay.eagerJudge) overlay.eagerJudge = {};
  overlay.eagerJudge[nodeKey] = overlay.epoch || 0;
  // Wall-clock anchor for the judging→ready timeout (task D). Stamped ONCE when the node's candidate
  // edge-set is first seeded; not refreshed on re-mark, so a long-running judge stall is measured from
  // when the edges were actually born (not from the last eager re-trigger) — that's what bounds the
  // deadlock. Cleared when the edge-set drains (clearJudgingSince).
  if (!overlay.judgingSince) overlay.judgingSince = {};
  if (!overlay.judgingSince[nodeKey]) overlay.judgingSince[nodeKey] = Date.now();
  return overlay;
}

// Clear the judging→ready timeout anchor once a node's candidate edge-set has fully drained (all edges
// judged). A stale anchor is harmless (judgingState ignores it when no unjudged edges remain) but we
// prune to keep the overlay tidy. Pure mutation; caller saves. Returns true if an anchor was removed.
function clearJudgingSince(overlay, nodeKey) {
  if (!overlay.judgingSince || !(nodeKey in overlay.judgingSince)) return false;
  delete overlay.judgingSince[nodeKey];
  return true;
}

// PENDING-DUP (write-time dup guard, defer-to-judge): record that note `noteKey` was admitted
// PROVISIONAL on a dup-guard fire (title-vec cosine >= DUP_THRESHOLD vs `matchKey`). While the entry
// is present the note is RETRIEVAL-INVISIBLE (search excludes it) and the {new,match} pair is surfaced
// to the dup-judge. `score` is the matching cosine. Pure mutation; caller saves.
function markPendingDup(overlay, noteKey, matchKey, score) {
  if (!noteKey || !matchKey) return overlay;
  if (!overlay.pendingDup) overlay.pendingDup = {};
  // `at` (ms) anchors the NON-DESTRUCTIVE timeout: invisibility is a PURE derivation of (now - at) vs
  // the judging timeout (judge.pendingDupState), mirroring judgingState — the entry is NEVER mutated on
  // timeout (it stays so the dup-judge still adjudicates it later); only the verdict clears it.
  overlay.pendingDup[noteKey] = { match: matchKey, score: typeof score === 'number' ? score : null, at: Date.now() };
  return overlay;
}

// Clear a note's pending_dup state — the dup-judge has adjudicated it (DISTINCT/CONSOLIDATE/SUPERSEDE)
// so it becomes recall-eligible (or was superseded). Pure mutation; caller saves. Returns true if a
// pending mark was removed.
function clearPendingDup(overlay, noteKey) {
  if (!overlay.pendingDup || !(noteKey in overlay.pendingDup)) return false;
  delete overlay.pendingDup[noteKey];
  return true;
}

// Is this note currently pending-dup (admitted provisional, awaiting the dup-judge)? Pure read.
function isPendingDup(overlay, noteKey) {
  return !!(overlay.pendingDup && overlay.pendingDup[noteKey]);
}

// Drop a node from the eager-judge signal once its candidate edge-set has been dispatched/drained.
// Pure mutation; caller saves. Returns true if a pending mark was cleared.
function clearEagerJudge(overlay, nodeKey) {
  if (!overlay.eagerJudge || !(nodeKey in overlay.eagerJudge)) return false;
  delete overlay.eagerJudge[nodeKey];
  return true;
}
// EAGER JUDGE LEASE (task 27): atomically lease a node for one eager-judge dispatch.
// Prevents concurrent heartbeat loops from double-dispatching the same node. TTL defaults 60s.
// Returns true if lease was acquired (node was not already held by another loop).
function acquireEagerJudgeLease(overlay, nodeKey, loopId, ttlMs) {
  if (!nodeKey) return false;
  if (!overlay.eagerJudgeLease) overlay.eagerJudgeLease = {};
  const now = Date.now();
  const ex = overlay.eagerJudgeLease[nodeKey];
  if (ex && ex.leaseExpiry > now) return false;
  overlay.eagerJudgeLease[nodeKey] = { leaseExpiry: now + (ttlMs || 60000), loopId: loopId || null };
  return true;
}

// Release a lease when judging completes or the eagerJudge mark is cleared.
// Pure mutation; caller saves. Returns true if a lease was removed.
function clearEagerJudgeLease(overlay, nodeKey) {
  if (!overlay.eagerJudgeLease || !(nodeKey in overlay.eagerJudgeLease)) return false;
  delete overlay.eagerJudgeLease[nodeKey];
  return true;
}

// SPAWN DISPATCH LEASE (task /3): atomically lease a READY task for one spawn dispatch, so concurrent
// heartbeat loops don't double-dispatch the same task in one tick. The spawn path shares only a batch
// COUNT (ctx.batch.remaining), so without this two loops slice the same ready[] prefix and return the
// same tasks. Symmetric to acquireEagerJudgeLease. TTL defaults 60s — the safety net for a spawn that
// crashes before its worker claims (start_task). The lease is normally released on the claim/terminal
// status change (setStatus path → clearSpawnLease).
function acquireSpawnLease(overlay, taskKey, loopId, ttlMs) {
  if (!taskKey) return false;
  if (!overlay.spawnLease) overlay.spawnLease = {};
  const now = Date.now();
  const ex = overlay.spawnLease[taskKey];
  if (ex && ex.leaseExpiry > now) return false;
  overlay.spawnLease[taskKey] = { leaseExpiry: now + (ttlMs || 60000), loopId: loopId || null };
  return true;
}
// Read-only: is a task currently spawn-leased (live, unexpired) by some loop?
function hasLiveSpawnLease(overlay, taskKey) {
  const ex = overlay.spawnLease && overlay.spawnLease[taskKey];
  return !!(ex && ex.leaseExpiry > Date.now());
}
// Release a spawn lease — called when the task changes status (claimed/terminal/released back to
// ready). Pure mutation; caller saves. Returns true if a lease was removed.
function clearSpawnLease(overlay, taskKey) {
  if (!overlay.spawnLease || !(taskKey in overlay.spawnLease)) return false;
  delete overlay.spawnLease[taskKey];
  return true;
}

// Mark all context edges incident to nodeKey for re-judgment when node is canceled/superseded.
// Returns count newly marked. Pure mutation; caller saves.
function markForRejudge(overlay, nodeKey) {
  if (!nodeKey) return 0;
  if (!overlay.edgeRejudge) overlay.edgeRejudge = {};
  var count = 0;
  for (var i = 0; i < (overlay.edges || []).length; i++) {
    var e = overlay.edges[i];
    if (e.kind !== 'context') continue;
    if (e.from !== nodeKey && e.to !== nodeKey) continue;
    var sig = e.from + '>>' + e.to;
    if (!overlay.edgeRejudge[sig]) { overlay.edgeRejudge[sig] = true; count++; }
  }
  return count;
}

// Clear the re-judgment signal for an edge after verdict lands. Returns true if cleared.
function clearEdgeRejudge(overlay, from, to) {
  if (!overlay.edgeRejudge) return false;
  var sig = from + '>>' + to;
  if (!overlay.edgeRejudge[sig]) return false;
  delete overlay.edgeRejudge[sig];
  return true;
}

// Set an on-complete interface summary for a task. Stored in overlay.summaries. Truncates to 2000
// chars (same cap as the daemon endpoint). Returns overlay.
function setSummary(overlay, key, summary) {
  overlay.summaries[key] = String(summary).slice(0, 2000);
  return overlay;
}

// Store a TASK node's semantic embedding(s) under overlay.taskVecs (MULTI-VEC schema: the value is
// an ARRAY of 384-dim vectors, scored MAX-cosine downstream). Step 0 stores exactly one vector per
// task; the array shape lands now so later steps (doc expansion) append without a second migration.
// A null/empty vec clears the entry (no silent storage of a non-vector). Returns overlay.
function setTaskVec(overlay, key, vec) {
  if (!overlay.taskVecs) overlay.taskVecs = {};
  if (Array.isArray(vec) && vec.length) overlay.taskVecs[key] = [vec];
  else delete overlay.taskVecs[key];
  return overlay;
}

// Merge extra runtime fields onto a guidance item by id. Used to stamp LOCAL annotations
// (e.g. verdictKey, sessionKey) onto items right after addGuidance returns the id, without
// touching the shared schema fields. No-ops silently when the id is not found. Returns overlay.
function annotateGuidance(overlay, id, fields) {
  if (!Array.isArray(overlay.guidance)) return overlay;
  const item = overlay.guidance.find((g) => g.id === id);
  if (item && fields && typeof fields === 'object') Object.assign(item, fields);
  return overlay;
}

// Re-point context edges that touch any key in `supersededKeys` to `keepKey`, then drop
// self-loops and deduplicate by (from, to, fromWorkspace, kind). Used after a node-dedup
// consolidation so the keeper inherits the cluster's edges and nothing dangles to a now-hidden
// note. `supersededKeys` should be 'note:'-prefixed. Returns overlay.
function repointEdges(overlay, supersededKeys, keepKey) {
  const sup = new Set(supersededKeys);
  for (const e of overlay.edges) {
    if (e.kind !== 'context') continue;
    if (sup.has(e.from)) e.from = keepKey;
    if (sup.has(e.to)) e.to = keepKey;
  }
  const seen = new Set();
  overlay.edges = overlay.edges.filter((e) => {
    if (e.from === e.to) return false;                                   // self-loop
    const sig = `${e.from}>>${e.to}>>${e.fromWorkspace || ''}>>${e.kind || 'blocking'}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  return overlay;
}

// Set an explicit per-task block. A blocked task is NEVER auto-dispatched by the loop — the block
// is sticky (survives graph rebuilds + dep re-derivation) and is cleared ONLY by clearBlocked.
// `reason` (optional string) is stored for observability. Stamps `at` for audit trail.
function setBlocked(overlay, key, reason) {
  if (!overlay.blocked) overlay.blocked = {};
  overlay.blocked[key] = { reason: reason ? String(reason).slice(0, 500) : null, at: new Date().toISOString() };
  return overlay;
}

// Clear an explicit per-task block set by setBlocked. Idempotent. Returns overlay.
function clearBlocked(overlay, key) {
  if (overlay.blocked) delete overlay.blocked[key];
  return overlay;
}

// True iff the task has an active explicit block. Pure read.
function isBlocked(overlay, key) {
  return !!(overlay.blocked && overlay.blocked[key]);
}

// Retrieve diagnostics for a workspace. Returns the diagnostics object or null if none exist.
// Shape: { lastError: string|null, errorCount: number, lastChecked: string }
function getDiagnostics(workspace) {
  try {
    const data = JSON.parse(fs.readFileSync(diagnosticsFileFor(workspace), 'utf8'));
    return data;
  } catch {
    return null;
  }
}

// Store diagnostics for a workspace. Persists atomically (temp + rename pattern).
// value should be: { lastError: string|null, errorCount: number, lastChecked: string }
function setDiagnostics(workspace, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const dest = diagnosticsFileFor(workspace);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, dest);
  return value;
}

// ─── Entity node support (Phase 2: conversational-memory entity layer) ──────
// Valid entity types (mirrors Zep/Graphiti taxonomy).
const ENTITY_TYPES = new Set(['person', 'org', 'place', 'thing', 'concept']);

// Create (or upsert) an entity node in the overlay. Entities are stored under
// overlay.entity_nodes, keyed by their unique id. Upsert logic: if an entity
// with the SAME name (case-insensitive) already exists in this workspace, return
// it unchanged (idempotent write). Otherwise mint a new record.
//
// Parameters
//   overlay   — the mutable overlay object for the workspace.
//   name      — canonical name (e.g. "bread baking", "Alice Smith").
//   type      — one of ENTITY_TYPES.
//   aliases   — optional array of alternative names (strings).
//   vec       — optional precomputed 384-float embedding of the name.
//
// Returns the entity record { id, kind, name, type, aliases, vec, validFrom, validTo, supersededBy }.
function createEntity(overlay, { name, type, aliases, vec }) {
  if (!overlay.entity_nodes) overlay.entity_nodes = {};
  const normName = String(name || '').trim();
  if (!normName) throw new Error('entity name is required');
  const normType = ENTITY_TYPES.has(type) ? type : 'concept';

  // Upsert: find by name (case-insensitive).
  for (const entity of Object.values(overlay.entity_nodes)) {
    if (entity.name.toLowerCase() === normName.toLowerCase()) return entity;
  }

  const id = `entity-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const now2 = new Date().toISOString();
  const record = {
    id,
    kind: 'entity',
    name: normName,
    type: normType,
    aliases: Array.isArray(aliases) ? aliases.map(String) : [],
    vec: Array.isArray(vec) ? vec : null,
    validFrom: now2,
    validTo: null,
    supersededBy: null,
  };
  overlay.entity_nodes[id] = record;
  return record;
}

// Add a context edge between two nodes (either a note key like 'note:<id>', a task key,
// or an entity key like 'entity:<id>') with a `relation` label stored on the edge.
// Stored as a standard context edge in overlay.edges, with an extra `relation` field.
// This is additive — it calls addEdge under the hood and then stamps the relation on the
// just-added (or existing) edge record. Returns the edge record.
function addEntityEdge(overlay, fromKey, toKey, relation) {
  if (!fromKey || !toKey) throw new Error('fromKey and toKey are required');
  addEdge(overlay, fromKey, toKey, null, 'context', 1.0, { origin: 'entity-link' });
  // Stamp the relation field on the live edge record (addEdge returned `overlay`; find it).
  const e = overlay.edges.find((ed) => ed.from === fromKey && ed.to === toKey && (ed.fromWorkspace || null) === null);
  if (e && relation) e.relation = String(relation);
  return e || null;
}

// Contradiction check (async, fire-and-forget). Called after a new note is wired to an entity.
// Fetches current notes for that entity, then for each (new, existing) pair asks an LLM
// "SUPERSEDE | UPDATE | KEEP_BOTH?". On SUPERSEDE or UPDATE, calls supersedeNote.
// Must NEVER throw — all errors are logged and silently swallowed so the write path continues.
//
// Parameters
//   overlay       — mutable overlay (will be mutated + saved on supersede).
//   workspace     — workspace path (for supersedeNote + save).
//   newNoteId     — bare note id (without 'note:' prefix) of the just-written fact.
//   entityId      — bare entity id (without 'entity:' prefix).
//   spawnClaude   — async fn(prompt: string): Promise<string|null>  (injected to avoid a hard
//                   require cycle from overlay → child_process; routes/overlay passes ctx.spawnClaude).
//   saveFn        — fn(ws, ov) → void  (injected so we can persist the supersede without requiring
//                   another layer).
async function checkEntityContradiction(overlay, workspace, newNoteId, entityId, spawnClaude, saveFn) {
  try {
    const entityKey = 'entity:' + entityId;
    const newNoteKey = 'note:' + newNoteId;
    const newNote = overlay.note_nodes && overlay.note_nodes[newNoteId];
    if (!newNote) return; // note not found — nothing to do

    // One-hop: find all context edges from *other* notes to this entity.
    const siblingNoteIds = [];
    for (const e of (overlay.edges || [])) {
      if (e.kind !== 'context') continue;
      if (e.to !== entityKey && e.from !== entityKey) continue;
      const otherKey = e.from === entityKey ? e.to : e.from;
      if (otherKey === newNoteKey) continue;
      if (!otherKey.startsWith('note:')) continue;
      const bareId = otherKey.slice(5);
      const n = overlay.note_nodes && overlay.note_nodes[bareId];
      if (n && !n.validTo) siblingNoteIds.push(bareId); // only current (non-superseded) notes
    }

    if (!siblingNoteIds.length) return; // no existing facts for this entity

    const newFact = `${newNote.title}: ${newNote.summary}`;

    for (const sibId of siblingNoteIds) {
      const sib = overlay.note_nodes[sibId];
      if (!sib) continue;
      const existingFact = `${sib.title}: ${sib.summary}`;

      const prompt = `You are a knowledge-base contradiction checker. Compare these two facts about the same entity:

EXISTING FACT:
${existingFact}

NEW FACT:
${newFact}

Does the new fact supersede, update, or simply add to the existing fact?
Answer with EXACTLY ONE of these words on the first line (nothing else):
SUPERSEDE  — the new fact replaces the existing fact (the existing one is now false/outdated)
UPDATE     — the new fact is a soft update/refinement of the existing fact
KEEP_BOTH  — both facts are independently valid, no contradiction`;

      let answer = null;
      try {
        const raw = await spawnClaude(prompt);
        if (raw) {
          const firstLine = raw.trim().split('\n')[0].trim().toUpperCase();
          if (firstLine === 'SUPERSEDE' || firstLine === 'UPDATE' || firstLine === 'KEEP_BOTH') {
            answer = firstLine;
          }
        }
      } catch (llmErr) {
        // LLM call failed — safe to continue without contradiction check
        if (typeof console !== 'undefined') console.error('[entity-contradiction] LLM call failed:', llmErr && llmErr.message);
        continue;
      }

      if (answer === 'SUPERSEDE' || answer === 'UPDATE') {
        // Soft supersede: mark existing note as superseded by the new one.
        supersedeNote(overlay, sibId, newNoteId, null, workspace);
        if (typeof saveFn === 'function') {
          try { saveFn(workspace, overlay); } catch { /* best effort */ }
        }
      }
      // KEEP_BOTH: no action
    }
  } catch (err) {
    // Safety net: contradiction check MUST NEVER surface to the write path.
    if (typeof console !== 'undefined') console.error('[entity-contradiction] unexpected error:', err && err.message);
  }
}

module.exports = { load, save, fileFor, addEdge, removeEdge, setStatus, setGit, setFeature, setRepo, setTestCmd, testCmdFor, setBackendConfig, getBackendConfig, setMetricSpec, setMeasurement, setBenchmark, setSnapshot, addNoteNode, supersedeNote, noteChain, addGuidance, resolveGuidance, pendingGuidance, dedupeGuidanceClusters, markClusterDistinct, isClusterDistinct, clusterSig, setOptimize, bumpEpoch, markEagerJudge, clearEagerJudge, clearJudgingSince, acquireEagerJudgeLease, clearEagerJudgeLease, acquireSpawnLease, hasLiveSpawnLease, clearSpawnLease, markPendingDup, clearPendingDup, isPendingDup, edgeWeight, DEFAULT_CONTEXT_WEIGHT, EMPTY, setSummary, setTaskVec, annotateGuidance, repointEdges, getDiagnostics, setDiagnostics, setBlocked, clearBlocked, isBlocked, markForRejudge, clearEdgeRejudge, createEntity, addEntityEdge, checkEntityContradiction, ENTITY_TYPES };
