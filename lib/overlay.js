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
const embeddingStore = require('./embedding-store');

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
// reviews: per-task same-node review lifecycle fields. Review is state on the implementation node,
//   not a separate visible judge task: { review_state, review_verdict, review_note/reason,
//   review_agent, reviewed_at, merge_state, attempt_branch/worktree/head, merge_sha, merged_at }.
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
//   baseline-only judging (back-compat). Set by the self-learn benchmark research agent.
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
// knowledge_nodes: typed, non-executable graph nodes for source structure and provenance clusters.
//   Keys are stable graph node ids (knowledge:<type>:<id>). These are searchable/context providers,
//   but never native tasks/todos. Notes stay in note_nodes because they carry temporal decision-fact
//   semantics; knowledge_nodes are the minimal source_doc/source_section/source_chunk/cluster layer.
// code_nodes: the dedicated CODE-INDEX layer (Phase 2 of the native onboarder). A SEPARATE map from
//   both note_nodes and knowledge_nodes, keyed code:<file>#<name>, holding one node per extracted code
//   symbol ({key,name,kind,file,start_line,end_line,signature,summary,exported,vec,vecMeta}). Like
//   knowledge_nodes it is non-executable (no status lifecycle / assignee / todo semantics) and is its
//   OWN map so the dup-judge (iterates note_nodes), the delta/dashboard, and the note-learner never see
//   it. UNLIKE knowledge_nodes (structural-expansion-only, surfaced at base score 0.001 via note->chunk
//   traversal), code_nodes are DIRECTLY RAG-searchable: /search scores them by cosine over their vecs
//   alongside note_nodes, tagged a distinct tier `code` with a tunable weight. That direct retrievability
//   is the whole design point (productizing the benchmarked cmm-onboard pipeline). Own event type
//   code_node_upserted; round-trips via graph-store rehydration like knowledge_nodes.
// code_edges: the dedicated CODE-EDGE layer — deterministic AST-derived code_node↔code_node structural
//   edges (NO LLM judge; code↔code edges are ground truth). A SEPARATE array from the task `edges`
//   array so they never enter the DAG scheduler / dup-judge / spreading-activation traversal that
//   operate on task+note edges. Each edge is { from_file, to (code_node key) | to_file, kind:'calls'|
//   'imports', name?, ambiguous? } produced by lib/code-extract/resolve-edges.js. Keyed by from_file so
//   per-file invalidation (replaceCodeEdgesForFile / removeCodeEdgesForFile) mirrors code_nodes during
//   git-diff sync. Own event types code_edge_added / code_edge_removed; round-trips via graph-store.
// distinctClusters: per dup-cluster-signature map (signature -> ISO timestamp) marking a cluster the
//   user definitively judged DISTINCT ("don't ask again"). dupClusters/the judge queue SKIP any
//   signature present here forever — a deliberate, user-made call (only the user can say two
//   same-recall notes are genuinely different facts). Unlike judgedClusters (epoch-gated, re-judgeable
//   when membership/epoch changes) this is permanent for that exact member set.
const EMPTY = () => ({ edges: [], unwired: {}, status: {}, notes: {}, summaries: {}, knowledge: {}, assignee: {}, timestamps: {}, config: {}, git: {}, reviews: {}, features: {}, repos: {}, metrics: {}, measurements: {}, benchmarks: {}, note_nodes: {}, knowledge_nodes: {}, code_nodes: {}, code_edges: [], snapshots: {}, cancel_requested: {}, stop_requested: {}, guidance: [], optimize: {}, epoch: 0, judgedAtEpoch: {}, judgeCursor: 0, judgedClusters: {}, distinctClusters: {}, forceClaims: {}, blocked: {}, usage_records: {}, task_costs: {}, usage_reconcile: {}, usage_reconcile_snapshot: null, dispatcher_focus: {}, taskVecs: {}, taskVecMeta: {}, eagerJudge: {}, judgingSince: {}, edgeRejudge: {}, eagerJudgeLease: {}, spawnLease: {}, pendingDup: {}, entity_nodes: {}, claimSessions: {}, git_claims: {}, git_users: {}, work_sessions: {} });

// Default relevance weight for context edges (0..1). Pre-existing context edges with no stored
// `weight` read as this, so the field is backward-compatible (substrate for relevance traversal).
const DEFAULT_CONTEXT_WEIGHT = 0.5;
const KNOWLEDGE_NODE_TYPES = ['source_doc', 'source_section', 'source_chunk', 'knowledge_cluster'];
const KNOWLEDGE_NODE_TYPE_SET = new Set(KNOWLEDGE_NODE_TYPES);
const ENTITY_TYPES = new Set(['person', 'org', 'place', 'thing', 'concept']);

function normalizeKnowledgeNodeType(type) {
  const t = String(type || '').trim().toLowerCase();
  return KNOWLEDGE_NODE_TYPE_SET.has(t) ? t : null;
}

function isKnowledgeNodeKind(kind) {
  return KNOWLEDGE_NODE_TYPE_SET.has(String(kind || '').trim().toLowerCase());
}

function isEntityNodeKind(kind) {
  return String(kind || '').trim().toLowerCase() === 'entity';
}

function isNonTaskNodeKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return k === 'note' || k === 'code_node' || k === 'entity' || isKnowledgeNodeKind(k);
}

function isNonTaskNode(node) {
  return isNonTaskNodeKind(node && node.kind);
}

function knowledgeNodeKey(type, id) {
  const t = normalizeKnowledgeNodeType(type);
  if (!t) return null;
  const raw = String(id || '').trim();
  if (raw.startsWith('knowledge:')) return raw;
  const suffix = raw || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `knowledge:${t}:${suffix}`;
}

// CODE-INDEX layer (code_nodes). A code node is a graph/search record for ONE extracted source symbol.
// The canonical key is code:<file>#<name>; a caller may pass an explicit `code:`-prefixed key, else we
// mint it from file+name (file+name uniquely identify a symbol within a repo for our purposes).
function isCodeNodeKind(kind) {
  // Advisory only — code_node has no closed type taxonomy the way knowledge_nodes do (the kind is the
  // extractor's symbol kind: function|class|method|arrow|struct|interface|enum|...). Any non-empty
  // string is accepted; this guard just rejects empties so a malformed record can't slip in.
  return typeof kind === 'string' && kind.trim().length > 0;
}
function codeNodeKey(file, name, explicit) {
  const raw = String(explicit || '').trim();
  if (raw.startsWith('code:')) return raw;
  const f = String(file || '').trim();
  const n = String(name || '').trim();
  if (!n) return null;
  return `code:${f}#${n}`;
}

function entityNodeKey(id) {
  const raw = String(id || '').trim().replace(/^entity:/, '');
  return raw ? `entity:${raw}` : null;
}

function isEntityKey(key) {
  return String(key || '').startsWith('entity:');
}

function isEntityEdge(e) {
  return !!(e && (isEntityKey(e.from) || isEntityKey(e.to) || e.origin === 'entity-link' || e.relation != null));
}
// Read an edge's relevance weight: only context edges carry one; absent ⇒ default. Returns null for
// non-context edges (blocking/supersede carry no weight). Clamps to [0,1] defensively.
function edgeWeight(e) {
  if (!e || e.kind !== 'context') return null;
  const w = typeof e.weight === 'number' ? e.weight : DEFAULT_CONTEXT_WEIGHT;
  return Math.max(0, Math.min(1, w));
}

function isBlockingEdgeKind(kind) {
  return kind !== 'context' && kind !== 'supersede';
}

function canonicalEdgeKind(kind) {
  return isBlockingEdgeKind(kind) ? 'blocking' : kind;
}

function taskLookupValue(tasks, key) {
  if (!tasks || !key) return null;
  if (typeof tasks.get === 'function') return tasks.get(key) || null;
  return tasks[key] || null;
}

function taskLabel(overlay, key, tasks) {
  const live = taskLookupValue(tasks, key);
  if (live && (live.label || live.subject || live.activeForm)) return String(live.label || live.subject || live.activeForm);
  const snap = overlay && overlay.snapshots && overlay.snapshots[key];
  if (snap && (snap.subject || snap.label || snap.activeForm)) return String(snap.subject || snap.label || snap.activeForm);
  return '';
}

function taskDeps(overlay, key, tasks) {
  const live = taskLookupValue(tasks, key);
  if (live && Array.isArray(live.deps)) return live.deps.map(String);
  const snap = overlay && overlay.snapshots && overlay.snapshots[key];
  if (snap && Array.isArray(snap.blockedBy)) return snap.blockedBy.map(String);
  return [];
}

function lifecycleDerivedStatus(overlay, key) {
  if (!overlay || !key) return null;
  const git = overlay.git && overlay.git[key];
  const review = overlay.reviews && overlay.reviews[key];
  if ((git && git.merged) || (review && review.merge_state === 'merged')) return 'done';
  if (review && (
    review.review_verdict === 'APPROVE' ||
    review.review_state === 'approved' ||
    review.review_state === 'landed' ||
    review.merge_state === 'pending' ||
    review.merge_state === 'conflict'
  )) return 'tested';
  return null;
}

function hasBlockingEdge(overlay, from, to) {
  return !!(overlay && Array.isArray(overlay.edges) && overlay.edges.some((e) => {
    return e.from === from && e.to === to && isBlockingEdgeKind(e.kind);
  }));
}

function isPairedJudgeLabel(label) {
  return /^Judge(?::|\s)/i.test(String(label || '').trim());
}

// True when a proposed blocking edge would make a paired judge task block the implementation
// it reviews. Correct direction is implementation -> judge; judge -> implementation must never gate.
function isReversePairedJudgeBlockingEdge(overlay, from, to, opts) {
  if (!overlay || !from || !to || from === to) return false;
  const tasks = opts && opts.tasks;
  if (!isPairedJudgeLabel(taskLabel(overlay, from, tasks))) return false;
  if (taskDeps(overlay, from, tasks).includes(String(to))) return true;
  return hasBlockingEdge(overlay, to, from);
}

function pruneReversePairedJudgeBlockingEdges(overlay, opts) {
  if (!overlay || !Array.isArray(overlay.edges) || overlay.edges.length === 0) return 0;
  const before = overlay.edges.length;
  overlay.edges = overlay.edges.filter((e) => {
    if (!isBlockingEdgeKind(e.kind)) return true;
    return !isReversePairedJudgeBlockingEdge(overlay, e.from, e.to, opts);
  });
  return before - overlay.edges.length;
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

    // code_edges — the dedicated code↔code edge layer, projected separately from task edges so they
    // never enter the DAG/judge/traversal. Replayed from code_edge_added/removed events by graph-store.
    if (Array.isArray(g.codeEdges) && g.codeEdges.length) base.code_edges = g.codeEdges;

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
          vecs:       Array.isArray(node.vecs) ? node.vecs : null,
          vecMeta:    node.vecMeta || null,
          vecsMeta:   Array.isArray(node.vecsMeta) ? node.vecsMeta : null,
          validTo:     node.validTo     || null,
          supersededBy: node.supersededBy || null,
          supersedes:  node.supersedes  || null,
        };
      }

      // typed knowledge nodes — replay as a separate map so callers can create source documents,
      // sections, chunks, and clusters without mixing them into temporal note_nodes or task state.
      if (isKnowledgeNodeKind(node.kind)) {
        const meta = (node.knowledge_node && typeof node.knowledge_node === 'object') ? node.knowledge_node : {};
        base.knowledge_nodes[id] = {
          key: id,
          id,
          type: normalizeKnowledgeNodeType(meta.type || node.kind),
          label: meta.label || node.label || null,
          title: meta.title || meta.label || node.label || null,
          summary: meta.summary || node.summary || null,
          metadata: meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata) ? meta.metadata : {},
          source_path: meta.source_path || null,
          section_ref: meta.section_ref || null,
          chunk_ref: meta.chunk_ref || null,
          cluster_ref: meta.cluster_ref || null,
          created_at: meta.created_at || null,
          updated_at: meta.updated_at || null,
          vec: Array.isArray(node.vec) ? node.vec : null,
          vecs: Array.isArray(node.vecs) ? node.vecs : null,
          vecMeta: node.vecMeta || null,
          vecsMeta: Array.isArray(node.vecsMeta) ? node.vecsMeta : null,
        };
      }

      // code_nodes — replay the dedicated code-index layer (separate map from note_nodes /
      // knowledge_nodes). Reconstructed from the graph node shape written by code_node_upserted.
      if (node.kind === 'code_node' && node.code_node && typeof node.code_node === 'object') {
        const meta = node.code_node;
        base.code_nodes[id] = {
          key: id,
          id,
          name: meta.name || node.label || null,
          kind: meta.kind || null,
          file: meta.file || null,
          start_line: meta.start_line != null ? meta.start_line : null,
          end_line: meta.end_line != null ? meta.end_line : null,
          signature: meta.signature || null,
          summary: meta.summary || node.summary || null,
          exported: !!meta.exported,
          created_at: meta.created_at || null,
          updated_at: meta.updated_at || null,
          vec: Array.isArray(node.vec) ? node.vec : null,
          vecMeta: node.vecMeta || null,
        };
      }

      // entity nodes — replay conversational-memory entities as their own overlay map keyed by
      // bare entity id, matching createEntity()/entity routes.
      if (isEntityNodeKind(node.kind)) {
        const meta = (node.entity_node && typeof node.entity_node === 'object') ? node.entity_node : {};
        const bareId = String(meta.id || id).replace(/^entity:/, '');
        if (bareId) {
          base.entity_nodes[bareId] = {
            id: bareId,
            kind: 'entity',
            name: meta.name || node.label || bareId,
            type: ENTITY_TYPES.has(meta.type) ? meta.type : 'concept',
            aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
            vec: Array.isArray(node.vec) ? node.vec : null,
            vecMeta: node.vecMeta || null,
            validFrom: meta.validFrom || meta.created_at || null,
            validTo: meta.validTo || null,
            supersededBy: meta.supersededBy || null,
          };
        }
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
    'git', 'reviews', 'cancel_requested', 'stop_requested', 'config', 'unwired',
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
    'taskVecMeta',
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
    // Entity nodes still round-trip locally for compatibility; graph-store events now provide the
    // replayable/shared source of truth for fresh loads and projection.
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
        || prevE.by !== e.by || prevE.score !== e.score || prevE.origin !== e.origin
        || prevE.relation !== e.relation || prevE.confidence !== e.confidence || prevE.evidence !== e.evidence;
      if (changed) {
        const ev = { evt: 'edge_promoted', from: e.from, to: e.to, kind: e.kind || 'blocking', actor: 'overlay-sync', ts };
        if (e.fromWorkspace) ev.fromWorkspace = e.fromWorkspace;
        if (typeof e.weight === 'number') ev.weight = e.weight;
        if (e.by !== undefined) ev.by = e.by;
        if (e.judged !== undefined) ev.judged = e.judged;
        if (typeof e.score === 'number') ev.score = e.score;
        if (e.origin !== undefined) ev.origin = e.origin;
        if (e.relation !== undefined) ev.relation = e.relation;
        if (typeof e.confidence === 'number') ev.confidence = e.confidence;
        if (e.evidence !== undefined) ev.evidence = e.evidence;
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
    if (e.relation !== undefined) ev.relation = e.relation;
    if (typeof e.confidence === 'number') ev.confidence = e.confidence;
    if (e.evidence !== undefined) ev.evidence = e.evidence;
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
    graphStore.appendEvent(store, 'note:' + noteId, { evt: 'note_created', id: noteId, workspace, title: n.title, summary: n.summary, category: n.category || null, tags: Array.isArray(n.tags) ? n.tags : [], created_by: n.created_by, valid_from: n.validFrom || n.valid_from, vec: Array.isArray(n.vec) ? n.vec : null, vecs: (Array.isArray(n.vecs) && n.vecs.length) ? n.vecs : null, vecMeta: n.vecMeta || null, vecsMeta: Array.isArray(n.vecsMeta) ? n.vecsMeta : null, actor: 'overlay-sync', ts });
  }

  // knowledge_nodes — upsert typed, non-executable source/provenance graph nodes.
  for (const [nodeId, n] of Object.entries(overlay.knowledge_nodes || {})) {
    if (!n || !isKnowledgeNodeKind(n.type)) continue;
    const payload = knowledgeNodeEventPayload(n, workspace);
    if (JSON.stringify(knowledgeNodeEventPayload((prev.knowledge_nodes || {})[nodeId], workspace)) === JSON.stringify(payload)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'knowledge_node_upserted', ...payload, actor: 'overlay-sync', ts });
  }

  // code_nodes — upsert the dedicated code-index layer (one node per extracted symbol). Mirrors the
  // knowledge_nodes emit: only when the serialized payload actually changed, so unchanged code nodes
  // never re-emit. Own event type code_node_upserted.
  for (const [nodeId, n] of Object.entries(overlay.code_nodes || {})) {
    if (!n || !isCodeNodeKind(n.kind)) continue;
    const payload = codeNodeEventPayload(n, workspace);
    if (JSON.stringify(codeNodeEventPayload((prev.code_nodes || {})[nodeId], workspace)) === JSON.stringify(payload)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'code_node_upserted', ...payload, actor: 'overlay-sync', ts });
  }
  // code_nodes REMOVED — a key present in prev.code_nodes but now ABSENT was deleted (per-file
  // invalidation via removeCodeNodesForFile during a git-diff sync). The upsert log is append-only, so
  // without an explicit removal event a daemon reload would replay the old code_node_upserted and
  // resurrect the deleted symbol. Emit code_node_removed so graph-store's replay drops the node from
  // the projection (and load() therefore won't re-add it to overlay.code_nodes). Mirrors the
  // status-cleared handling above — the only other field that needs an explicit "gone" event.
  for (const nodeId of Object.keys(prev.code_nodes || {})) {
    if (Object.prototype.hasOwnProperty.call(overlay.code_nodes || {}, nodeId)) continue;
    graphStore.appendEvent(store, nodeId, { evt: 'code_node_removed', id: nodeId, workspace, actor: 'overlay-sync', ts });
  }

  // code_edges — deterministic AST code↔code edges (own array, NOT overlay.edges). Diff prev vs current
  // by signature and emit code_edge_added / code_edge_removed. Keyed on a synthetic per-file node id
  // (codeedge:<from_file>) so every edge from one file colocates in one JSONL — matching the per-file
  // invalidation granularity (replaceCodeEdgesForFile rewrites exactly that file's edges). Mirrors the
  // task-edge add/remove diff above, so adds AND per-file removals survive a daemon reload.
  {
    const codeEdgeNodeId = (e) => `codeedge:${String((e && e.from_file) || '').trim()}`;
    const prevEdges = Array.isArray(prev.code_edges) ? prev.code_edges : [];
    const curEdges = Array.isArray(overlay.code_edges) ? overlay.code_edges : [];
    const prevBySig = new Map(prevEdges.map((e) => [codeEdgeSig(e), e]));
    const curBySig = new Map(curEdges.map((e) => [codeEdgeSig(e), e]));
    for (const e of curEdges) {
      const sig = codeEdgeSig(e);
      if (prevBySig.has(sig)) continue;
      const ev = { evt: 'code_edge_added', from_file: e.from_file, kind: e.kind, workspace, actor: 'overlay-sync', ts };
      if (e.to) ev.to = e.to; if (e.to_file) ev.to_file = e.to_file;
      if (e.name) ev.name = e.name; if (e.ambiguous) ev.ambiguous = true;
      graphStore.appendEvent(store, codeEdgeNodeId(e), ev);
    }
    for (const e of prevEdges) {
      const sig = codeEdgeSig(e);
      if (curBySig.has(sig)) continue;
      const ev = { evt: 'code_edge_removed', from_file: e.from_file, kind: e.kind, workspace, actor: 'overlay-sync', ts };
      if (e.to) ev.to = e.to; if (e.to_file) ev.to_file = e.to_file;
      graphStore.appendEvent(store, codeEdgeNodeId(e), ev);
    }
  }

  // entity_nodes — upsert conversational-memory entities as replayable graph nodes.
  for (const [entityId, n] of Object.entries(overlay.entity_nodes || {})) {
    if (!n) continue;
    const payload = entityNodeEventPayload(n, workspace);
    if (!payload) continue;
    if (JSON.stringify(entityNodeEventPayload((prev.entity_nodes || {})[entityId], workspace)) === JSON.stringify(payload)) continue;
    graphStore.appendEvent(store, payload.key, { evt: 'entity_node_upserted', ...payload, actor: 'overlay-sync', ts });
  }

  // entity edges are ordinary context edges plus a relation label. Persist a relation-bearing upsert
  // event so replay preserves the entity graph even if the generic edge event lacks entity metadata.
  for (const e of (overlay.edges || [])) {
    if (!isEntityEdge(e)) continue;
    const payload = entityEdgeEventPayload(e, workspace);
    if (!payload) continue;
    const prevE = prevEdgeBySig.get(edgeSig(e));
    if (JSON.stringify(entityEdgeEventPayload(prevE, workspace)) === JSON.stringify(payload)) continue;
    graphStore.appendEvent(store, e.from, { evt: 'entity_edge_upserted', ...payload, actor: 'overlay-sync', ts });
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

// Add a dependency edge from -> to. Idempotent per from/to/fromWorkspace/kind.
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
// meta (optional, context edges only): provenance fields stamped on a NEW edge — {by, judged, score, origin, relation, confidence, evidence}.
// Autowire passes {by:'autowire', judged:false, score:<cosine>} together with weight 0 so the edge is
// retrieval-invisible (weight-0 multiplier) until the judge promotes it. `score` preserves the recall
// cosine so a keep-verdict can seed the promoted weight from it. `origin` records HOW the edge was
// created ('autowire-lexical' | 'autowire-semantic' | 'asserted') so keepRateByBand can isolate the
// threshold-gated population (autowire-lexical) from hand-asserted note edges. Not applied to blocking/supersede.
function addEdge(overlay, from, to, fromWorkspace, kind, weight, meta) {
  const fw = fromWorkspace || null;
  const edgeKind = canonicalEdgeKind(kind);
  if (!fw && edgeKind === 'blocking' && isReversePairedJudgeBlockingEdge(overlay, from, to)) return overlay;
  // Wiring an edge clears the unwired quarantine on either endpoint — the task is now
  // structurally connected to the graph (see daemon.js unwired stamp + /mark-root).
  if (overlay.unwired) { delete overlay.unwired[to]; delete overlay.unwired[from]; }
  const w = (edgeKind === 'context' && typeof weight === 'number') ? Math.max(0, Math.min(1, weight)) : undefined;
  const existing = overlay.edges.find((e) => e.from === from && e.to === to && (e.fromWorkspace || null) === fw && canonicalEdgeKind(e.kind) === edgeKind);
  if (existing) {
    if (edgeKind === 'context') {
      existing.kind = 'context'; if (w !== undefined) existing.weight = w;
      // Also apply judge-pipeline meta fields so the context edge enters the judge queue correctly.
      if (meta) {
        if (meta.by !== undefined) existing.by = meta.by;
        if (meta.judged !== undefined) existing.judged = meta.judged;
        if (meta.origin !== undefined) existing.origin = meta.origin;
        if (typeof meta.score === 'number') existing.score = Math.max(0, Math.min(1, meta.score));
        if (meta.relation !== undefined) existing.relation = meta.relation;
        if (typeof meta.confidence === 'number') existing.confidence = Math.max(0, Math.min(1, meta.confidence));
        if (meta.evidence !== undefined) existing.evidence = meta.evidence;
      }
    } else if (edgeKind === 'supersede') existing.kind = 'supersede';
    return overlay;
  }
  const edge = { from, to };
  if (fromWorkspace) edge.fromWorkspace = fromWorkspace;
  if (edgeKind === 'context' || edgeKind === 'supersede') edge.kind = edgeKind; // omit for blocking (absent = blocking, back-compat)
  if (w !== undefined) edge.weight = w; // omit when unspecified (absent = DEFAULT_CONTEXT_WEIGHT, back-compat)
  if (meta && edgeKind === 'context') {
    if (meta.by !== undefined) edge.by = meta.by;
    if (meta.judged !== undefined) edge.judged = meta.judged;
    if (typeof meta.score === 'number') edge.score = Math.max(0, Math.min(1, meta.score));
    if (meta.origin !== undefined) edge.origin = meta.origin;
    if (meta.relation !== undefined) edge.relation = meta.relation;
    if (typeof meta.confidence === 'number') edge.confidence = Math.max(0, Math.min(1, meta.confidence));
    if (meta.evidence !== undefined) edge.evidence = meta.evidence;
  }
  // Blocking edges carry origin for provenance (e.g. 'native-blockedBy') but never judged/weight/by —
  // they are structurally certain and NEVER queued for judge re-adjudication.
  // isUnverifiedEdge() already excludes them (requires kind==='context' && judged===false).
  if (meta && edgeKind === 'blocking') {
    if (meta.origin !== undefined) edge.origin = meta.origin;
  }
  overlay.edges.push(edge);
  // NEIGHBORHOOD-CHANGE RE-JUDGMENT (task /23): when a new autowire CANDIDATE edge (judged:false,
  // by:'autowire') is added between two EXISTING nodes, either endpoint's neighborhood has changed --
  // its existing unjudged candidate edges might get different verdicts with the new neighbor present.
  // Re-mark any endpoint that already has OTHER unjudged context edges so the heartbeat re-dispatches
  // a judge for it. Guard: only fires on autowire candidates (not on promoted/judged edges or
  // hand-asserted edges), preventing the cascade: keep-verdict addEdge(judged:true) NO re-mark.
  if (edgeKind === 'context' && meta && meta.by === 'autowire' && meta.judged === false) {
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

const REVIEW_FIELDS = [
  'review_state',
  'review_verdict',
  'review_note',
  'review_reason',
  'review_agent',
  'reviewed_at',
  'review_requested_at',
  'review_requested_by',
  'merge_state',
  'attempt_branch',
  'attempt_worktree',
  'attempt_head',
  'merge_sha',
  'merged_at',
  'legacy_judge_task_key',
];

function cleanLifecycleString(value, max = 500) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function normalizeReviewVerdict(value) {
  const raw = cleanLifecycleString(value, 40);
  if (!raw) return null;
  const v = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (v === 'APPROVE' || v === 'APPROVED' || v === 'PASS' || v === 'PASSED') return 'APPROVE';
  if (v === 'KICK_BACK' || v === 'KICKBACK' || v === 'REJECT' || v === 'REJECTED' || v === 'FAIL' || v === 'FAILED') return 'KICK_BACK';
  return v;
}

function isReviewPendingState(value) {
  const raw = cleanLifecycleString(value, 80);
  if (!raw) return false;
  const v = raw.toLowerCase().replace(/[\s-]+/g, '_');
  return v === 'requested' || v === 'pending' || v === 'review_requested' || v === 'review_pending';
}

function reviewPatchFromInput(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const field of REVIEW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, field)) continue;
    out[field] = field === 'review_verdict'
      ? normalizeReviewVerdict(src[field])
      : cleanLifecycleString(src[field], field === 'review_note' || field === 'review_reason' ? 2000 : 500);
  }
  if (Object.prototype.hasOwnProperty.call(src, 'reason') && !Object.prototype.hasOwnProperty.call(out, 'review_reason')) {
    out.review_reason = cleanLifecycleString(src.reason, 2000);
  }
  if (Object.prototype.hasOwnProperty.call(src, 'note') && !Object.prototype.hasOwnProperty.call(out, 'review_note')) {
    out.review_note = cleanLifecycleString(src.note, 2000);
  }
  return out;
}

function setReviewLifecycle(overlay, key, patch) {
  if (!key) return overlay;
  const normalized = reviewPatchFromInput(patch);
  if (!Object.keys(normalized).length) return overlay;
  if (!overlay.reviews) overlay.reviews = {};
  const existing = overlay.reviews[key] || {};
  const next = { ...existing, ...normalized };
  if (next.review_note && !next.review_reason) next.review_reason = next.review_note;
  if (next.review_reason && !next.review_note) next.review_note = next.review_reason;
  overlay.reviews[key] = next;
  return overlay;
}

function statusReviewDefaults(overlay, key, status, opts = {}) {
  const existing = (overlay.reviews && overlay.reviews[key]) || {};
  const ts = opts.now || new Date().toISOString();
  const patch = {};
  if (status === 'tested') {
    patch.review_state = 'approved';
    patch.review_verdict = 'APPROVE';
    patch.merge_state = 'pending';
    patch.reviewed_at = existing.reviewed_at || ts;
  } else if (status === 'failed') {
    patch.review_state = 'rejected';
    patch.review_verdict = 'KICK_BACK';
    patch.merge_state = 'blocked';
    patch.reviewed_at = ts;
  } else if (status === 'done') {
    if (isReviewPendingState(existing.review_state) && opts.merge_state !== 'merged') {
      patch.review_state = 'pending';
      patch.review_verdict = existing.review_verdict || null;
      patch.merge_state = existing.merge_state || 'review_pending';
    } else {
      patch.review_state = 'landed';
      patch.review_verdict = existing.review_verdict || 'APPROVE';
      patch.merge_state = opts.merge_state || existing.merge_state || 'closed';
      patch.reviewed_at = existing.reviewed_at || ts;
    }
  } else if (status === 'canceled') {
    patch.review_state = 'canceled';
    patch.merge_state = existing.merge_state || 'closed';
    patch.reviewed_at = existing.reviewed_at || ts;
  }
  if (opts.agent_id && !existing.review_agent) patch.review_agent = opts.agent_id;
  const note = opts.note || opts.summary || opts.reason;
  if (note && (!existing.review_note || status === 'failed')) {
    patch.review_note = note;
    patch.review_reason = note;
  }
  return patch;
}

function setReviewFromStatus(overlay, key, status, opts = {}) {
  const patch = statusReviewDefaults(overlay, key, status, opts);
  return setReviewLifecycle(overlay, key, patch);
}

function deriveReviewState(status) {
  if (status === 'tested') return 'approved';
  if (status === 'failed') return 'rejected';
  if (status === 'done') return 'landed';
  if (status === 'canceled') return 'canceled';
  return null;
}

function deriveReviewVerdict(status) {
  if (status === 'tested' || status === 'done') return 'APPROVE';
  if (status === 'failed') return 'KICK_BACK';
  return null;
}

function deriveMergeState(status, gitInfo, reviewState) {
  if (gitInfo && gitInfo.merged) return 'merged';
  if (isReviewPendingState(reviewState)) return 'review_pending';
  if (status === 'tested' || reviewState === 'approved') return 'pending';
  if (status === 'failed' || reviewState === 'rejected') return 'blocked';
  if (status === 'done') return 'closed';
  if (status === 'canceled') return 'closed';
  return null;
}

function reviewLifecycleFor(overlay, key, status) {
  const rec = (overlay && overlay.reviews && overlay.reviews[key]) || {};
  const gitInfo = (overlay && overlay.git && overlay.git[key]) || {};
  const pendingSameNodeReview = status === 'done' && isReviewPendingState(rec.review_state) && !(gitInfo && gitInfo.merged);
  const statusReviewState = pendingSameNodeReview ? null : deriveReviewState(status);
  const reviewState = pendingSameNodeReview ? 'pending' : (statusReviewState || rec.review_state || null);
  let mergeState = rec.merge_state || deriveMergeState(status, gitInfo, reviewState);
  if (gitInfo && gitInfo.merged) mergeState = 'merged';
  else if (status === 'done' && mergeState === 'pending' && !pendingSameNodeReview) mergeState = 'closed';
  const reviewVerdict = pendingSameNodeReview ? (rec.review_verdict || null) : (deriveReviewVerdict(status) || rec.review_verdict || null);
  return {
    review_state: reviewState || null,
    review_verdict: reviewVerdict,
    review_note: rec.review_note || null,
    review_reason: rec.review_reason || rec.review_note || null,
    review_agent: rec.review_agent || null,
    reviewed_at: rec.reviewed_at || null,
    review_requested_at: rec.review_requested_at || null,
    review_requested_by: rec.review_requested_by || null,
    merge_state: mergeState,
    attempt_branch: rec.attempt_branch || gitInfo.branch || null,
    attempt_worktree: rec.attempt_worktree || gitInfo.worktree || null,
    attempt_head: rec.attempt_head || gitInfo.head || null,
    merge_sha: rec.merge_sha || gitInfo.merge_sha || null,
    merged_at: rec.merged_at || gitInfo.merged_at || null,
    legacy_judge_task_key: rec.legacy_judge_task_key || null,
  };
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
  if (cmd && !isStaleRoutineSmokeCommand(cmd)) overlay.config.test_cmds[String(repoPath)] = String(cmd);
  else delete overlay.config.test_cmds[repoPath];
  return overlay;
}

// Read a repo's stored test command (null when unset / no repo).
function testCmdFor(overlay, repoPath) {
  const cmd = (repoPath && overlay.config && overlay.config.test_cmds && overlay.config.test_cmds[repoPath]) || null;
  return isStaleRoutineSmokeCommand(cmd) ? null : cmd;
}

function isStaleRoutineSmokeCommand(cmd) {
  return String(cmd || '').trim() === 'python3 bench/zonoid_bench/smoke.py';
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

// SELECTABLE EMBEDDING PROVIDER. Stored separately from the LLM backend because swapping embedding
// model/provider changes vector identity and requires re-embedding before semantic scores are valid.
function setEmbeddingConfig(overlay, config = {}) {
  if (!overlay.config) overlay.config = {};
  if (!config.provider) { delete overlay.config.embedding; return overlay; }
  const out = { provider: String(config.provider), model: String(config.model || '') };
  if (config.dimensions) out.dimensions = Number(config.dimensions);
  if (config.baseUrl) out.baseUrl = String(config.baseUrl);
  if (config.apiStyle) out.apiStyle = String(config.apiStyle);
  overlay.config.embedding = out;
  return overlay;
}

function getEmbeddingConfig(overlay) {
  return (overlay && overlay.config && overlay.config.embedding) || null;
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

function knowledgeNodeEventPayload(n, workspace) {
  if (!n || !isKnowledgeNodeKind(n.type)) return null;
  const type = normalizeKnowledgeNodeType(n.type);
  const out = {
    id: n.key || n.id,
    key: n.key || n.id,
    workspace,
    type,
    kind: type,
    label: n.label || n.title || null,
    title: n.title || n.label || null,
    summary: n.summary || null,
    metadata: n.metadata && typeof n.metadata === 'object' && !Array.isArray(n.metadata) ? n.metadata : {},
    source_path: n.source_path || null,
    section_ref: n.section_ref || null,
    chunk_ref: n.chunk_ref || null,
    cluster_ref: n.cluster_ref || null,
    created_at: n.created_at || null,
    updated_at: n.updated_at || null,
  };
  if (Array.isArray(n.vec)) out.vec = n.vec;
  if (Array.isArray(n.vecs) && n.vecs.length) out.vecs = n.vecs;
  if (n.vecMeta) out.vecMeta = n.vecMeta;
  if (Array.isArray(n.vecsMeta)) out.vecsMeta = n.vecsMeta;
  return out;
}

function entityNodeEventPayload(n, workspace) {
  if (!n) return null;
  const key = entityNodeKey(n.key || n.id);
  if (!key) return null;
  const id = key.slice('entity:'.length);
  const type = ENTITY_TYPES.has(n.type) ? n.type : 'concept';
  const out = {
    id,
    key,
    workspace,
    kind: 'entity',
    name: String(n.name || id).trim() || id,
    type,
    aliases: Array.isArray(n.aliases) ? n.aliases.map(String) : [],
    validFrom: n.validFrom || n.valid_from || null,
    validTo: n.validTo || n.valid_to || null,
    supersededBy: n.supersededBy || n.superseded_by || null,
  };
  if (Array.isArray(n.vec)) out.vec = n.vec;
  if (n.vecMeta) out.vecMeta = n.vecMeta;
  return out;
}

function entityEdgeEventPayload(e, workspace) {
  if (!e || !e.from || !e.to || !isEntityEdge(e)) return null;
  const out = {
    workspace,
    from: String(e.from),
    to: String(e.to),
    kind: e.kind || 'context',
    relation: e.relation != null ? String(e.relation) : null,
  };
  if (e.fromWorkspace) out.fromWorkspace = e.fromWorkspace;
  if (typeof e.weight === 'number') out.weight = e.weight;
  if (e.by !== undefined) out.by = e.by;
  if (e.judged !== undefined) out.judged = e.judged;
  if (typeof e.score === 'number') out.score = e.score;
  if (e.origin !== undefined) out.origin = e.origin;
  return out;
}

// Add/update a typed, non-executable knowledge node for source provenance structure. These nodes are
// graph/search records only; they are never native tasks and carry no runnable status lifecycle.
function upsertKnowledgeNode(overlay, data = {}) {
  if (!overlay.knowledge_nodes) overlay.knowledge_nodes = {};
  const type = normalizeKnowledgeNodeType(data.type || data.kind);
  if (!type) return { ok: false, error: `type must be one of: ${KNOWLEDGE_NODE_TYPES.join(', ')}` };
  const key = knowledgeNodeKey(type, data.key || data.id);
  const existing = overlay.knowledge_nodes[key] || {};
  const createdAt = existing.created_at || new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const label = String(data.label || data.title || existing.label || existing.title || key).slice(0, 240);
  const metadata = data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
    ? { ...(existing.metadata || {}), ...data.metadata }
    : (existing.metadata || {});
  const node = {
    key,
    id: key,
    type,
    label,
    title: label,
    summary: String(data.summary != null ? data.summary : (existing.summary || '')).slice(0, 5000),
    metadata,
    source_path: String(data.source_path || data.sourcePath || existing.source_path || '').trim() || null,
    section_ref: String(data.section_ref || data.sectionRef || existing.section_ref || '').trim() || null,
    chunk_ref: String(data.chunk_ref || data.chunkRef || existing.chunk_ref || '').trim() || null,
    cluster_ref: String(data.cluster_ref || data.clusterRef || existing.cluster_ref || '').trim() || null,
    created_at: createdAt,
    updated_at: updatedAt,
    vec: Array.isArray(data.vec) ? data.vec : (Array.isArray(existing.vec) ? existing.vec : null),
    vecs: Array.isArray(data.vecs) && data.vecs.length ? data.vecs : (Array.isArray(existing.vecs) ? existing.vecs : null),
    vecMeta: data.vecMeta || existing.vecMeta || null,
    vecsMeta: Array.isArray(data.vecsMeta) ? data.vecsMeta : (Array.isArray(existing.vecsMeta) ? existing.vecsMeta : null),
  };
  overlay.knowledge_nodes[key] = node;
  return { ok: true, key, node };
}

// Serialize a code_node into the graph-store event payload (mirrors knowledgeNodeEventPayload). Used
// by emitDiff to persist the dedicated code-index layer so it survives a daemon reload.
function codeNodeEventPayload(n, workspace) {
  if (!n || !isCodeNodeKind(n.kind)) return null;
  const out = {
    id: n.key || n.id,
    key: n.key || n.id,
    workspace,
    kind: 'code_node',          // graph node kind (the projection/replay discriminator)
    symbol_kind: n.kind,        // the extractor's symbol kind (function|class|method|...)
    name: n.name || null,
    label: n.name || n.key || n.id,
    file: n.file || null,
    start_line: n.start_line != null ? n.start_line : null,
    end_line: n.end_line != null ? n.end_line : null,
    signature: n.signature || null,
    summary: n.summary || null,
    exported: !!n.exported,
    created_at: n.created_at || null,
    updated_at: n.updated_at || null,
  };
  if (Array.isArray(n.vec)) out.vec = n.vec;
  if (n.vecMeta) out.vecMeta = n.vecMeta;
  return out;
}

// Add/update a code_node: one graph/search record per extracted source symbol, in the dedicated
// code-index layer (overlay.code_nodes, separate from note_nodes/knowledge_nodes). Non-executable —
// no status lifecycle. Key is code:<file>#<name> (or an explicit code:-prefixed `key`). Re-upserting
// the same key overwrites in place, preserving created_at. Returns { ok, key, node } | { ok:false }.
function upsertCodeNode(overlay, data = {}) {
  if (!overlay.code_nodes) overlay.code_nodes = {};
  if (!isCodeNodeKind(data.kind)) return { ok: false, error: 'kind required (non-empty string)' };
  const key = codeNodeKey(data.file, data.name, data.key || data.id);
  if (!key) return { ok: false, error: 'name (or explicit key) required to form code node key' };
  const existing = overlay.code_nodes[key] || {};
  const createdAt = existing.created_at || new Date().toISOString();
  const node = {
    key,
    id: key,
    name: String(data.name != null ? data.name : (existing.name || '')).slice(0, 240) || null,
    kind: String(data.kind).trim(),
    file: String(data.file != null ? data.file : (existing.file || '')).trim() || null,
    start_line: data.start_line != null ? Number(data.start_line) : (existing.start_line != null ? existing.start_line : null),
    end_line: data.end_line != null ? Number(data.end_line) : (existing.end_line != null ? existing.end_line : null),
    signature: String(data.signature != null ? data.signature : (existing.signature || '')).slice(0, 1000) || null,
    summary: String(data.summary != null ? data.summary : (existing.summary || '')).slice(0, 2000) || null,
    exported: data.exported != null ? !!data.exported : !!existing.exported,
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    vec: Array.isArray(data.vec) ? data.vec : (Array.isArray(existing.vec) ? existing.vec : null),
    vecMeta: data.vecMeta || existing.vecMeta || null,
  };
  overlay.code_nodes[key] = node;
  return { ok: true, key, node };
}

// Remove EVERY code_node belonging to `file` from the dedicated code-index layer. This is the
// per-file invalidation primitive the incremental git-diff sync builds on (DESIGN: note-mqpzfgjlux8
// "code_nodes keyed by file so invalidation is per-file and cheap"): a MODIFIED file is re-onboarded
// by removeCodeNodesForFile(file) + a fresh bulk-upsert (replace), and a DELETED file is just removed.
// Matches on the stored node.file (the repo-relative path the extractor emits), NOT on the key string,
// so an explicit-keyed node still invalidates by its file field. The actual graph-store DELETE event
// is emitted by emitDiff on the next save() (it diffs prev.code_nodes vs the now-smaller map and emits
// code_node_removed for the gone keys) — same prev-state-diff mechanism every other overlay field uses,
// so the deletion survives a daemon reload instead of being resurrected by the append-only upsert log.
// Returns { removed: [keys], file }.
function removeCodeNodesForFile(overlay, file) {
  const f = String(file || '').trim();
  const removed = [];
  if (!f || !overlay.code_nodes) return { removed, file: f };
  for (const [key, n] of Object.entries(overlay.code_nodes)) {
    if (n && String(n.file || '').trim() === f) {
      delete overlay.code_nodes[key];
      removed.push(key);
    }
  }
  return { removed, file: f };
}

// ── CODE-EDGE layer (overlay.code_edges) ──────────────────────────────────────────────────────────
// Deterministic AST-derived code_node↔code_node edges. Stored in their OWN array (NOT overlay.edges,
// which feeds the task DAG / judge / traversal). Each edge: { from_file, to (code_node key) | to_file,
// kind:'calls'|'imports', name?, ambiguous? }. Normalized + de-duped on every write so a re-onboard of
// a file is idempotent. Persistence: emitDiff diffs prev.code_edges vs current by signature and emits
// code_edge_added / code_edge_removed (replayed by graph-store), so adds AND per-file removals survive
// a daemon reload — same prev-state-diff mechanism code_nodes use.

// Canonical signature of a code edge (the identity used for de-dup + add/remove diffing). `to` is the
// resolved code_node key; file-level import fallbacks carry `to_file` instead, distinguished by a
// `file:` marker so a symbol edge and a file edge never collide.
function codeEdgeSig(e) {
  const to = e && e.to ? e.to : (e && e.to_file ? `file:${e.to_file}` : '');
  return `${(e && e.from_file) || ''}\u0000${to}\u0000${(e && e.kind) || ''}`;
}

// Normalize a raw resolved edge into the stored shape (drops unknown fields, coerces types). Returns
// null when it lacks the minimum identity (from_file + a target + kind).
function normalizeCodeEdge(e) {
  if (!e || !e.kind) return null;
  const fromFile = String(e.from_file || '').trim();
  if (!fromFile) return null;
  const to = e.to ? String(e.to).trim() : '';
  const toFile = e.to_file ? String(e.to_file).trim() : '';
  if (!to && !toFile) return null;
  const out = { from_file: fromFile, kind: String(e.kind), };
  if (to) out.to = to; else out.to_file = toFile;
  if (e.name) out.name = String(e.name);
  if (e.ambiguous) out.ambiguous = true;
  return out;
}

// Replace ALL code edges originating from `file` with `edges` (the per-file invalidation primitive the
// git-diff sync builds on — exactly mirrors removeCodeNodesForFile + bulk-upsert for code_nodes). Drops
// every existing edge whose from_file === file, then appends the normalized + de-duped new edges.
// Returns { file, removed:<count>, added:[normalized edges] }.
function replaceCodeEdgesForFile(overlay, file, edges) {
  if (!Array.isArray(overlay.code_edges)) overlay.code_edges = [];
  const f = String(file || '').trim();
  if (!f) return { file: f, removed: 0, added: [] };
  const before = overlay.code_edges.length;
  overlay.code_edges = overlay.code_edges.filter((e) => String(e.from_file || '').trim() !== f);
  const removed = before - overlay.code_edges.length;
  const seen = new Set(overlay.code_edges.map(codeEdgeSig));
  const added = [];
  for (const raw of (Array.isArray(edges) ? edges : [])) {
    const n = normalizeCodeEdge(raw);
    if (!n || String(n.from_file).trim() !== f) continue; // only edges FROM this file (per-file unit)
    const sig = codeEdgeSig(n);
    if (seen.has(sig)) continue;
    seen.add(sig);
    overlay.code_edges.push(n);
    added.push(n);
  }
  return { file: f, removed, added };
}

// Remove EVERY code edge originating from `file` (a DELETED source file). Returns { file, removed }.
function removeCodeEdgesForFile(overlay, file) {
  if (!Array.isArray(overlay.code_edges)) { overlay.code_edges = []; return { file: String(file || '').trim(), removed: 0 }; }
  const f = String(file || '').trim();
  if (!f) return { file: f, removed: 0 };
  const before = overlay.code_edges.length;
  overlay.code_edges = overlay.code_edges.filter((e) => String(e.from_file || '').trim() !== f);
  return { file: f, removed: before - overlay.code_edges.length };
}

// Bulk-add resolved code edges (full-onboard path). Idempotent: de-dups against existing edges by
// signature, so re-running an onboard never duplicates. Does NOT clear anything (use the per-file
// replace for invalidation). Returns { added:[normalized edges] }.
function addCodeEdges(overlay, edges) {
  if (!Array.isArray(overlay.code_edges)) overlay.code_edges = [];
  const seen = new Set(overlay.code_edges.map(codeEdgeSig));
  const added = [];
  for (const raw of (Array.isArray(edges) ? edges : [])) {
    const n = normalizeCodeEdge(raw);
    if (!n) continue;
    const sig = codeEdgeSig(n);
    if (seen.has(sig)) continue;
    seen.add(sig);
    overlay.code_edges.push(n);
    added.push(n);
  }
  return { added };
}

// lastIndexedCommit registry: the HEAD commit a workspace/repo's code-index was last fully synced to,
// keyed by an arbitrary string (the sync caller uses the repo's absolute path). Nested under
// overlay.config (config is in save()'s LOCAL_FIELDS, so this round-trips with zero new wiring — same
// pattern as setTestCmd / setBackendConfig). The incremental git-diff sync reads it to compute
// `git diff <lastIndexedCommit>..HEAD` and advances it to HEAD after a successful pass; absent ⇒ the
// caller does a FULL onboard (no prior index to diff against). STORE/RETRIEVE ONLY.
function setLastIndexedCommit(overlay, key, commit) {
  if (!overlay.config) overlay.config = {};
  if (!overlay.config.lastIndexedCommit) overlay.config.lastIndexedCommit = {};
  const k = String(key || '').trim();
  if (!k) return overlay;
  if (commit) overlay.config.lastIndexedCommit[k] = String(commit).trim();
  else delete overlay.config.lastIndexedCommit[k];
  return overlay;
}

// Read a workspace/repo's last-indexed HEAD commit (null when never synced). Pure read.
function getLastIndexedCommit(overlay, key) {
  const k = String(key || '').trim();
  return (k && overlay && overlay.config && overlay.config.lastIndexedCommit
    && overlay.config.lastIndexedCommit[k]) || null;
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
function addNoteNode(overlay, { title, summary, knowledge, created_by, valid_from, vec, vecs, vecMeta, vecsMeta, category, tags }) {
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
    vecMeta: vecMeta || null,
    // Field-level embedding set (array of 384-float vectors) for multi-vec corpus scoring; null ⇒
    // fall back to the single pooled `.vec`. Only stored when a non-empty array is supplied so the
    // back-compat single-.vec shape stays clean.
    vecs: (Array.isArray(vecs) && vecs.length) ? vecs : null,
    vecsMeta: (Array.isArray(vecsMeta) && vecsMeta.length) ? vecsMeta : null,
  };
  return id;
}

const BELIEF_STATUSES = Object.freeze(['suggested', 'verified', 'stale', 'contradicted', 'superseded']);
const BELIEF_STATUS_SET = new Set(BELIEF_STATUSES);

function normalizeBeliefStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return BELIEF_STATUS_SET.has(status) ? status : null;
}

function explicitBeliefStatus(note) {
  if (!note || typeof note !== 'object') return null;
  for (const field of ['belief_status', 'beliefStatus', 'lifecycle_status', 'lifecycleStatus', 'status']) {
    const status = normalizeBeliefStatus(note[field]);
    if (status) return status;
  }
  return null;
}

function beliefStatusForNote(note, options = {}) {
  if (!note || typeof note !== 'object') return null;
  const explicit = explicitBeliefStatus(note);
  if (note.supersededBy || note.superseded_by) return 'superseded';
  if (note.validTo || note.valid_to) return 'stale';
  if (options.pendingDup || note.pending_dup || note.provisional || explicit === 'suggested') return 'suggested';
  if (explicit === 'contradicted') return 'contradicted';
  return 'verified';
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
  // VESTIGIAL wall-clock anchor. The judging→ready gate was time-based (task D) but is now STRICT (P6):
  // readiness is derived solely from whether unjudged candidate edges remain (judge.judgingState), which
  // no longer reads this anchor. We still stamp it (once, never refreshed) so existing tooling/snapshots
  // that inspect judgingSince keep seeing a value; it is otherwise unused and cleared on drain.
  if (!overlay.judgingSince) overlay.judgingSince = {};
  if (!overlay.judgingSince[nodeKey]) overlay.judgingSince[nodeKey] = Date.now();
  return overlay;
}

// Clear the (now vestigial) judgingSince anchor once a node's candidate edge-set has fully drained. A
// stale anchor is harmless under the strict gate (judgingState never reads it) but we prune to keep the
// overlay tidy. Pure mutation; caller saves. Returns true if an anchor was removed.
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
  // `at` (ms) anchors the NON-DESTRUCTIVE pending-dup visibility timeout: invisibility is a PURE
  // derivation of (now - at) vs the pending-dup timeout (judge.pendingDupState / pendingDupTimeoutMs).
  // This is a SEPARATE concern from the (now strict, clockless) node-readiness gate — a stalled
  // dup-judge must not hide a note forever. The entry is NEVER mutated on timeout (it stays so the
  // dup-judge still adjudicates it later); only the verdict clears it.
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
function setTaskVec(overlay, key, vec, meta) {
  return embeddingStore.setTaskVec(overlay, key, vec, meta);
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
function createEntity(overlay, { name, type, aliases, vec, vecMeta }) {
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
    vecMeta: vecMeta || null,
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

module.exports = { load, save, fileFor, addEdge, removeEdge, setStatus, setGit, lifecycleDerivedStatus, setReviewLifecycle, setReviewFromStatus, reviewLifecycleFor, reviewPatchFromInput, setFeature, setRepo, setTestCmd, testCmdFor, setBackendConfig, getBackendConfig, setEmbeddingConfig, getEmbeddingConfig, setMetricSpec, setMeasurement, setBenchmark, setSnapshot, addNoteNode, upsertKnowledgeNode, normalizeKnowledgeNodeType, isKnowledgeNodeKind, isEntityNodeKind, isNonTaskNodeKind, isNonTaskNode, KNOWLEDGE_NODE_TYPES, BELIEF_STATUSES, normalizeBeliefStatus, beliefStatusForNote, upsertCodeNode, removeCodeNodesForFile, addCodeEdges, replaceCodeEdgesForFile, removeCodeEdgesForFile, normalizeCodeEdge, codeEdgeSig, setLastIndexedCommit, getLastIndexedCommit, isCodeNodeKind, codeNodeKey, supersedeNote, noteChain, addGuidance, resolveGuidance, pendingGuidance, dedupeGuidanceClusters, markClusterDistinct, isClusterDistinct, clusterSig, setOptimize, bumpEpoch, markEagerJudge, clearEagerJudge, clearJudgingSince, acquireEagerJudgeLease, clearEagerJudgeLease, acquireSpawnLease, hasLiveSpawnLease, clearSpawnLease, markPendingDup, clearPendingDup, isPendingDup, edgeWeight, DEFAULT_CONTEXT_WEIGHT, EMPTY, setSummary, setTaskVec, annotateGuidance, repointEdges, getDiagnostics, setDiagnostics, setBlocked, clearBlocked, isBlocked, markForRejudge, clearEdgeRejudge, isReversePairedJudgeBlockingEdge, pruneReversePairedJudgeBlockingEdges, createEntity, addEntityEdge, checkEntityContradiction, ENTITY_TYPES };
