// Per-workspace overlay store: the things native tasks can't hold —
// cross-session dependency edges, richer statuses, and notes. Persisted to disk so it
// survives daemon restarts and is shared by every session in the workspace.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { encodeWorkspace } = require('./native-tasks');

const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const DIR = path.join(BASE, 'overlay');
// edges: cross-session/workspace deps · status: richer-status overrides · notes: freeform
// summaries: on-complete "interface" summary per task (Tier-1 context) · knowledge: Tier-2
// context items per task · assignee: which agent is working a task (for live animation)
// timestamps: per-task { firstSeen, lastChanged, lastStatus } — daemon-observed task lifecycle
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
const EMPTY = () => ({ edges: [], status: {}, notes: {}, summaries: {}, knowledge: {}, assignee: {}, timestamps: {}, config: {}, git: {}, repos: {}, metrics: {}, measurements: {}, benchmarks: {}, note_nodes: {}, cancel_requested: {}, stop_requested: {}, guidance: [], optimize: {}, epoch: 0, judgedAtEpoch: {}, judgeCursor: 0 });

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

function load(workspace) {
  let o = null;
  try { o = JSON.parse(fs.readFileSync(fileFor(workspace), 'utf8')); }
  catch { try { o = JSON.parse(fs.readFileSync(legacyFileFor(workspace), 'utf8')); } catch { o = null; } }
  return o ? { ...EMPTY(), ...o } : EMPTY();
}

function save(workspace, overlay) {
  fs.mkdirSync(DIR, { recursive: true });
  const dest = fileFor(workspace);
  const tmp = `${dest}.${process.pid}.tmp`;            // atomic write: temp + rename (review H1)
  fs.writeFileSync(tmp, JSON.stringify(overlay, null, 2));
  fs.renameSync(tmp, dest);
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
function addEdge(overlay, from, to, fromWorkspace, kind, weight) {
  const fw = fromWorkspace || null;
  const w = (kind === 'context' && typeof weight === 'number') ? Math.max(0, Math.min(1, weight)) : undefined;
  const existing = overlay.edges.find((e) => e.from === from && e.to === to && (e.fromWorkspace || null) === fw);
  if (existing) {
    if (kind === 'context') { existing.kind = 'context'; if (w !== undefined) existing.weight = w; }   // upgrade blocking → context on re-add (never silently downgrade)
    else if (kind === 'supersede') existing.kind = 'supersede';
    return overlay;
  }
  const edge = { from, to };
  if (fromWorkspace) edge.fromWorkspace = fromWorkspace;
  if (kind === 'context' || kind === 'supersede') edge.kind = kind; // omit for blocking (absent = blocking, back-compat)
  if (w !== undefined) edge.weight = w; // omit when unspecified (absent = DEFAULT_CONTEXT_WEIGHT, back-compat)
  overlay.edges.push(edge);
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

// Set (or clear, with a falsy repoPath) the target repo path a task's git ops should run against.
function setRepo(overlay, key, repoPath) {
  if (!overlay.repos) overlay.repos = {};
  if (repoPath) overlay.repos[key] = String(repoPath);
  else delete overlay.repos[key];
  return overlay;
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
function addNoteNode(overlay, { title, summary, knowledge, created_by, valid_from, vec }) {
  // Collision-safe id: Date.now() alone collides for notes created in the same millisecond (back-to-
  // back record_decision / supersede calls would clobber each other). Append a short random suffix.
  let id;
  do { id = `note-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; } while (overlay.note_nodes[id]);
  const created = new Date().toISOString();
  overlay.note_nodes[id] = {
    id,
    title: String(title || '').slice(0, 200),
    summary: String(summary || '').slice(0, 2000),
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
  };
  return id;
}

// Supersede note `oldId` with `newId` WITHOUT deleting history: stamp validTo on the old note (when
// it stopped being true = the new note's validFrom), link old↔new both directions, and chain the new
// note's `supersedes` back. Idempotent-ish: re-linking the same pair just refreshes the stamps.
// Returns { ok, error? }. `at` (ISO) lets the caller set the changeover instant explicitly; absent ⇒
// the new note's validFrom (or now).
function supersedeNote(overlay, oldId, newId, at) {
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

// Push an escalation/guidance item onto the queue. A pending item halts the autonomous loop
// (the caller is responsible for setting loop.active=false). Returns the new item's id.
function addGuidance(overlay, { question, context, trigger }) {
  if (!Array.isArray(overlay.guidance)) overlay.guidance = [];
  const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  overlay.guidance.push({
    id,
    question: String(question || '').slice(0, 1000),
    context: String(context || '').slice(0, 2000),
    trigger: trigger ? String(trigger).slice(0, 80) : null,
    ts: new Date().toISOString(),
    resolved: false,
  });
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

const pendingGuidance = (overlay) => (Array.isArray(overlay.guidance) ? overlay.guidance.filter((g) => !g.resolved) : []);

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

module.exports = { load, save, addEdge, removeEdge, setStatus, setGit, setRepo, setMetricSpec, setMeasurement, setBenchmark, addNoteNode, supersedeNote, noteChain, addGuidance, resolveGuidance, pendingGuidance, setOptimize, bumpEpoch, edgeWeight, DEFAULT_CONTEXT_WEIGHT, EMPTY };
