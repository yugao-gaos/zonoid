#!/usr/bin/env node
// Orchestrator daemon: serves a per-WORKSPACE task graph built ON TOP of native Claude
// Code tasks (read live, source of truth) plus our overlay (cross-session edges, richer
// status, notes). Supports GHOST edges: a dependency whose provider lives in another
// workspace, resolved on demand. Also holds router decisions + subagent activity.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const nt = require('./lib/native-tasks');
const overlayStore = require('./lib/overlay');
const mcpCore = require('./lib/mcp-core');
const git = require('./lib/git');
const measure = require('./lib/measure');
const optimize = require('./lib/optimize');
const { embed, cosine, embedStatus, ping: embedPing, DIMS, MODEL: EMBED_MODEL } = require('./lib/embed');
const { haikusGate } = require('./lib/embed-haiku');
const judge = require('./lib/judge');
const delta = require('./lib/delta');
const followups = require('./lib/followups');
const verdicts = require('./lib/verdicts');
const { gateTask, contentTokens, classifyNoteType, noteText } = require('./lib/context-gate');
const costflow = require('./lib/costflow');
const humanInput = require('./lib/human-input');
const frontier = require('./lib/frontier');
const analytics = require('./lib/analytics');
const graphStore = require('./lib/graph-store');

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROUTES = 50;
const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks');
const LOOP_FILE = path.join(BASE, 'loop.json');     // legacy singleton file — migrated into LOOPS_FILE on first boot
const LOOPS_FILE = path.join(BASE, 'loops.json');   // keyed registry: { [loopId]: entry }
const MCP_CALL = mcpCore.makeCall(PORT); // self-call for /mcp tool dispatch (loopback)
const TOKEN = mcpCore.readToken();       // null ⇒ auth off (localhost dev, back-compat)
// Bearer-token check for /mcp + destructive/write endpoints. Token accepted via
// Authorization: Bearer, x-orch-token header, or ?token= (so a connector URL can carry it).
function authed(req, u) {
  if (!TOKEN) return true;
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-orch-token'] || u.searchParams.get('token') || '');
  return t === TOKEN;
}

// --- caches: avoid re-reading native task files / transcripts on every request ---
// TTL bounds staleness; fs.watch on the task dir invalidates the aggregate cache instantly
// when native tasks change (reactive + cheap, fixing the per-call read cost).
const cache = { agg: new Map(), aggAt: new Map(), usage: new Map(), usageAt: new Map() };
const AGG_TTL = 1500, USAGE_TTL = 4000;

// Response cache for the expensive read endpoints (/state, /costflow): dashboards + heartbeats
// poll both, and every call rebuilds the whole graph (buildGraph) / recomputes SCC+flow. A short
// TTL bounds the recompute cost; EVERY overlay mutation invalidates immediately — notifyChange()
// is the choke point all mutation routes already call — so status/claim flows never read stale
// state. The fs.watch on TASKS_DIR below covers native task-file writes that bypass the daemon.
// buildGraph carries side effects (timestamp stamping, unwired-quarantine stamp, autowire of
// newly-seen tasks); caching delays those by at most RESP_TTL, which is acceptable.
// Dependency-free: a Map of { key -> { ts, payload } }, keyed per workspace + query params.
// A hit additionally requires the workspace's overlay FILE mtime to be unchanged, so overlay
// writes from OTHER processes (scripts/tests calling overlayStore.save directly — invisible to
// notifyChange) also invalidate immediately. One stat per request: trivial next to a rebuild.
const RESP_TTL = 3000;
const respCache = new Map();
function overlayStamp(ws) {
  try { return fs.statSync(overlayStore.fileFor(ws)).mtimeMs; } catch { return 0; }
}
function respCacheGet(ws, key) {
  const hit = respCache.get(key);
  return (hit && Date.now() - hit.ts < RESP_TTL && hit.stamp === overlayStamp(ws)) ? hit.payload : undefined;
}
function respCachePut(ws, key, payload) {
  // Stamp AFTER the build: buildGraph itself may have saved the overlay (timestamp stamping,
  // autowire) and the payload already reflects that state — stamping post-build lets it hit.
  respCache.set(key, { ts: Date.now(), payload, stamp: overlayStamp(ws) });
  return payload;
}
function aggregateCached(ws) {
  const now = Date.now();
  if (cache.agg.has(ws) && now - (cache.aggAt.get(ws) || 0) < AGG_TTL) return cache.agg.get(ws);
  // Pass the overlay's terminal-status snapshots so tasks whose native files were garbage-
  // collected by the cleanupPeriodDays retention sweep still appear in the aggregate.
  const ov = (ws === state.workspace) ? state.overlay : overlayStore.load(ws);
  const v = nt.aggregateWorkspace(ws, ov.snapshots);
  cache.agg.set(ws, v); cache.aggAt.set(ws, now);
  return v;
}

// Freeze a task's native fields into the overlay when it reaches a terminal status, so the graph
// node survives the cleanupPeriodDays retention sweep of ~/.claude/tasks/ (native files are no
// longer indefinitely durable). Read-only on native; best-effort no-op if the file is already gone.
// `nativeStatus` (optional): the status the write-through is about to stamp on the native file.
function snapshotNative(ov, key, nativeStatus) {
  const i = String(key || '').indexOf('/');
  if (i <= 0) return;
  const t = nt.readTask(key.slice(0, i), key.slice(i + 1));
  if (t) overlayStore.setSnapshot(ov, key, { subject: t.subject, description: t.description, status: nativeStatus || t.status, blockedBy: t.blockedBy || [], owner: t.owner ?? null, metadata: t.metadata ?? null });
}
function usageCached(p) {
  const now = Date.now();
  if (cache.usage.has(p) && now - (cache.usageAt.get(p) || 0) < USAGE_TTL) return cache.usage.get(p);
  const v = readUsage(p);
  cache.usage.set(p, v); cache.usageAt.set(p, now);
  return v;
}
try { fs.watch(TASKS_DIR, { recursive: true }, () => { cache.agg.clear(); cache.aggAt.clear(); respCache.clear(); }); } catch { /* TTL is the fallback */ }

const ACTION_STATUSES = ['in_progress', 'tested', 'done', 'failed', 'canceled'];
const ALL_STATUSES = ['not_ready', 'ready', ...ACTION_STATUSES];

// The five escalation triggers — the situations where the loop should stop and ask the user
// instead of guessing. All default ON; tunable per-workspace via POST /config { escalation }.
const ESCALATION_DEFAULTS = () => ({ ambiguous_intent: true, irreversible_action: true, low_confidence_high_impact: true, repeated_failure: true, scope_expansion: true });
// A catch-all session node (cost-flow, note-mq89ptfjx0y) burning this many tokens with ZERO
// graph-visible outputs raises a 'review' escalation item — burning without producing.
const CATCHALL_ESCALATE_TOKENS = 1e6;
// Optimize-loop knobs (⑥): epsilon = the per-cycle improvement below which a round counts as
// "diminishing"; diminishing_rounds (K) = how many consecutive sub-epsilon / no-win rounds trigger
// converge / stuck. Tunable per-workspace via POST /config { optimize }. (Budget reuses the loop's
// existing tokenBudget — no separate knob.) Defaults live in lib/optimize.js.
const OPTIMIZE_DEFAULTS = () => ({ ...optimize.DEFAULTS });

let state = { workspace: null, overlay: overlayStore.EMPTY(), routes: [], agents: {}, mainTranscript: null, graphStore: null };
// Persist + restore the workspace, so a daemon respawn (e.g. after a crash/kill) keeps serving
// the same project instead of coming back with no workspace.
const WS_FILE = path.join(BASE, 'workspace');
// One-time migration for the edge-judge rework: tag every BLIND note-provider similarity edge
// (kind:context, from a note node, written by the old autowireNoteProvider pass) as UNVERIFIED
// ({judged:false, by:'autowire'}) so the judge can re-adjudicate keep-vs-prune. Idempotent — an
// edge already carrying a `judged` flag is skipped, so re-running (boot, /workspace switch) is safe.
// Persists when it tagged anything. Returns the count newly tagged.
function migrateBlindEdges(workspace, overlay) {
  if (!workspace || !overlay) return 0;
  const tagged = judge.tagBlindEdges(overlay);
  if (tagged > 0) { try { overlayStore.save(workspace, overlay); } catch { /* best effort */ } }
  return tagged;
}

// Boot phase tracker — set to 'loading' immediately; advanced through real init milestones;
// set to 'ready' once the daemon is fully operational. Exposed via GET /health (always 200).
// Steps: bind -> workspace -> agents -> loops -> ready (4 steps after bind).
const BOOT_STEPS = ['bind', 'workspace', 'agents', 'loops', 'ready'];
const bootState = { phase: 'loading', step: 'bind', progress: 0 };
function advanceBoot(step) {
  bootState.step = step;
  const idx = BOOT_STEPS.indexOf(step);
  bootState.progress = idx >= 0 ? idx / (BOOT_STEPS.length - 1) : bootState.progress;
  if (step === 'ready') bootState.phase = 'ready';
}

// Persist + restore agent records (incl. transcript_path/session) so token attribution survives a restart.
const AGENTS_FILE = path.join(BASE, 'agents.json');
// Restart survival: do NOT blind-demote running→unknown on boot. Workers are independent OS
// processes that often SURVIVE a daemon restart; demoting them let the staleness sweep release
// their live claims, which the heartbeat then re-spawned → duplicate/colliding work. The sweep
// (staleClaimKeys, wall-clock based so downtime counts) is the SOLE release mechanism; a restored
// 'running' record is trusted only per vouchedLive(): re-asserted this boot (lastSeen >= BOOT_MS)
// or still inside the one-stale-window post-boot grace for survivors to re-assert.
const BOOT_MS = Date.now();
const BOOTED_AT = new Date(BOOT_MS).toISOString();
// /version build identity (frozen at boot): the git HEAD this RUNNING process was started from.
// After a deploy, /version.head ≠ `git rev-parse HEAD` on disk ⇒ "restart required" — the check
// hooks/restart-daemon.sh asserts. null when the source dir isn't a git checkout.
let GIT_HEAD = null;
try { GIT_HEAD = require('child_process').execFileSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch { /* not a checkout */ }
// Capability flags, bumped per change — cheap self-description so a restart script can verify the
// new code is actually serving (beyond the git head).
const FEATURES = { perRequestWorkspaceWrites: true, perRequestWorkspaceReads: true, gatedSearch: true };

// MCP tool-usage counters (persisted; see lib/analytics.js). Recorded via POST /analytics/tool-call
// beacons fired by mcp-core's tools/call dispatch on BOTH transports; flushed debounced.
const ANALYTICS_FILE = path.join(BASE, 'tool-analytics.json');
const analyticsState = analytics.load(ANALYTICS_FILE);
const analyticsFlush = analytics.makeFlusher(ANALYTICS_FILE, analyticsState);

// SSE: push a "changed" event to connected dashboards on every mutation (live updates without polling).
const sseClients = new Set();
function notifyChange() { respCache.clear(); for (const r of sseClients) { try { r.write('data: changed\n\n'); } catch { sseClients.delete(r); } } }

// Heartbeat loop: the daemon is the decider. The agent polls next_action on a schedule; the
// daemon replies spawn/idle/stop + how long to wait before checking again (adaptive backoff),
// and enforces hard caps so token burn can't run away. Persisted to disk so a daemon restart
// resumes the budget/iteration count mid-run.
// Keyed REGISTRY of heartbeat loops (was a singleton `loop`). Each entry is independent — its own
// budget/iterations/session/config — and ONE heartbeat (decideAll) advances them all. Keyed by a UUID
// loopId so /loop/start can INSERT (never clobber) and multiple driving conversations can coexist.
const LOOP_CONFIG_KEYS = ['tokenBudget', 'maxIterations', 'minPoll', 'maxPoll', 'estPerTick', 'batch', 'maxConcurrency', 'judgeParallelCap'];
const STALE_PROGRESS_MIN_DEFAULT = 30;   // a loop with no progress past this many minutes is swept to inactive
function newLoop(over) {
  return { id: null, active: false, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null,
    session: null, lastProgress: null, workspace: null,
    config: { tokenBudget: 100000, maxIterations: 200, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8, maxConcurrency: 10, judgeParallelCap: 6 },
    ...over };
}
const loops = new Map();   // loopId -> entry
// Restore the registry on boot. Prefer the keyed loops.json; if absent, migrate a legacy singleton
// loop.json into ONE entry (backward compat) so an in-flight run survives the upgrade.
// Called from loadState() after server bind so the port is held before any disk I/O.
function restoreLoops() {
  let restored = false;
  try {
    const blob = JSON.parse(fs.readFileSync(LOOPS_FILE, 'utf8'));
    if (blob && typeof blob === 'object') {
      for (const [id, e] of Object.entries(blob)) {
        if (!e || typeof e !== 'object') continue;
        const entry = newLoop({ ...e, id, config: { ...newLoop().config, ...(e.config || {}) } });
        loops.set(id, entry);
        restored = true;
      }
    }
  } catch { /* no registry yet */ }
  if (!restored) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LOOP_FILE, 'utf8'));
      if (legacy && typeof legacy === 'object') {
        const id = crypto.randomUUID();
        loops.set(id, newLoop({ ...legacy, id, config: { ...newLoop().config, ...(legacy.config || {}) } }));
      }
    } catch { /* fresh — empty registry */ }
  }
}

// loadState: called AFTER server.listen() so the port is held before any disk I/O. Advances
// bootState through each phase milestone; sets phase:'ready' when fully operational.
// Yields to the event loop between phases so /health (whitelisted through the 503 gate) can
// report live progress while the synchronous per-phase loads run.
const yieldLoop = () => new Promise((r) => setImmediate(r));
async function loadState() {
  // Phase 1: workspace + overlay restore
  advanceBoot('workspace');
  await yieldLoop();
  try {
    const w = fs.readFileSync(WS_FILE, 'utf8').trim();
    if (w) {
      state.workspace = w;
      state.overlay = overlayStore.load(w);
      migrateBlindEdges(w, state.overlay);
      state.graphStore = graphStore.open(path.join(state.workspace, '.graph'));
      graphStore.initGitAttributes(state.workspace);
    }
  } catch { /* none yet */ }

  // Phase 2: agent records restore
  advanceBoot('agents');
  await yieldLoop();
  try { const a = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); if (a && typeof a === 'object') state.agents = a; } catch { /* none yet */ }

  // Phase 3: loop registry restore
  advanceBoot('loops');
  await yieldLoop();
  restoreLoops();

  // Fully operational
  advanceBoot('ready');
  process.stdout.write(`orchestrator boot complete (phase:ready)\n`);
}
function saveLoops() { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(LOOPS_FILE, JSON.stringify(Object.fromEntries(loops))); } catch { /* best effort */ } }
function saveAgents() { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(AGENTS_FILE, JSON.stringify(state.agents)); } catch { /* best effort */ } }

// Resolve the TARGET git repo for a task's git op. Precedence (back-compat default = workspace):
//   explicit (request body repo_path) > task's overlay repo field > daemon workspace.
// Lets the loop branch/merge/measure on a repo distinct from the daemon's own workspace.
function resolveRepo(key, explicit, ov = state.overlay, ws = state.workspace) {
  return explicit || (key && ov.repos && ov.repos[key]) || ws;
}

// Per-request workspace targeting for graph-MUTATING routes (the workspace-gremlin fix): a write
// from session A must land in A's pinned workspace even when the daemon-global state.workspace was
// last flipped by session B's SessionStart hook. Resolves the target from the request body's
// `workspace` (or ?workspace= query); absent => state.workspace (back-compat fallback). When the
// target IS the current workspace we hand back state.overlay itself so the in-memory state stays
// coherent (mirrors makeResolver's loadWs / the read routes' `ov[ws]` pattern); otherwise we load
// that workspace's overlay fresh, mutate it, and save() persists to the RESOLVED workspace.
function targetOverlay(b, u) {
  const ws = (b && b.workspace) || (u && u.searchParams.get('workspace')) || state.workspace;
  const ov = (ws === state.workspace) ? state.overlay : overlayStore.load(ws);
  return { ws, ov, save: () => overlayStore.save(ws, ov) };
}

// Validate an inline metric spec ({ metric, direction, measure_command, parse?, target?,
// guardrails? }). Returns an error string if invalid, or null if OK. Required: a non-empty
// `metric` label, `direction` ∈ {min,max}, and a `measure_command`. Optional `guardrails` must be
// an array whose entries each carry the same three required fields (a regression check is also a
// measurable metric). Kept minimal — the measure node interprets `parse`/`target` later.
function validateMetricSpec(spec) {
  if (typeof spec !== 'object' || Array.isArray(spec)) return 'spec must be an object';
  if (!spec.metric || typeof spec.metric !== 'string') return 'spec.metric (string) required';
  if (spec.direction !== 'min' && spec.direction !== 'max') return 'spec.direction must be "min" or "max"';
  if (!spec.measure_command || typeof spec.measure_command !== 'string') return 'spec.measure_command (string) required';
  if (spec.guardrails != null) {
    if (!Array.isArray(spec.guardrails)) return 'spec.guardrails must be an array';
    for (const gd of spec.guardrails) {
      if (typeof gd !== 'object' || Array.isArray(gd)) return 'each guardrail must be an object';
      if (!gd.metric || typeof gd.metric !== 'string') return 'each guardrail needs a metric (string)';
      if (gd.direction !== 'min' && gd.direction !== 'max') return 'each guardrail needs direction "min" or "max"';
      if (!gd.measure_command || typeof gd.measure_command !== 'string') return 'each guardrail needs a measure_command (string)';
    }
  }
  return null;
}

// Validate a researched benchmark record ({ metric, value, unit?, source, note?, confidence?,
// researched_at? }) — the competitor/industry-average reference for a metric. Returns an error
// string if invalid, or null if OK. Required: a non-empty `metric` label, a numeric `value`, and a
// non-empty `source` (a string/url for provenance). Optional `confidence` ∈ {low,med,high}. Other
// fields (unit/note/researched_at) are free-form. Kept minimal — the judge interprets the rest.
function validateBenchmark(b) {
  if (typeof b !== 'object' || Array.isArray(b)) return 'benchmark must be an object';
  if (!b.metric || typeof b.metric !== 'string') return 'benchmark.metric (string) required';
  if (typeof b.value !== 'number' || Number.isNaN(b.value)) return 'benchmark.value (number) required';
  if (!b.source || typeof b.source !== 'string') return 'benchmark.source (string) required';
  if (b.confidence != null && b.confidence !== 'low' && b.confidence !== 'med' && b.confidence !== 'high') return 'benchmark.confidence must be "low", "med", or "high"';
  return null;
}

// --- agent liveness: never leave a phantom in_progress claim ---------------------------------
// releaseClaim clears a task's status OVERRIDE (not a terminal state) so it re-derives to
// ready/not_ready, recording why. Returns true if it actually released an in_progress claim.
// `ov` = the overlay holding the claim (defaults to the current workspace's — callers targeting
// another workspace pass that workspace's overlay; the native write-through is workspace-agnostic).
// Optional `ctx` = { agentId, mins, tokenUsage } — when provided, a continuity note node is written
// onto the overlay and wired as a context edge to the task, so the next agent that claims it sees
// what happened. If tokenUsage has token counts they are also appended to the cost log.
function releaseClaim(key, reason, ov = state.overlay, ctx = null) {
  if (ov.status[key] !== 'in_progress') return false;
  delete ov.status[key];
  ov.notes[key] = String(reason).slice(0, 280);
  // Also revert the native status (start_task wrote it to in_progress via write-through); otherwise
  // the task would still derive as in_progress from its native file. 'pending' = available to retry.
  const i = key.indexOf('/');
  if (i > 0) { try { nt.writeStatus(key.slice(0, i), key.slice(i + 1), 'pending'); } catch { /* best effort */ } }
  // Continuity note: record what happened so the next agent that picks up this task has context.
  if (ctx) {
    const { agentId, mins, tokenUsage } = ctx;
    const tokStr = tokenUsage && typeof tokenUsage.total === 'number'
      ? ` Partial tokens: input=${tokenUsage.input_tokens || 0} output=${tokenUsage.output_tokens || 0} cache_read=${tokenUsage.cache_read_input_tokens || 0} total=${tokenUsage.total}.`
      : '';
    const noteSummary = `Task was reset to ready after being stale for >${mins}m. Agent '${agentId || '?'}' held the claim but is no longer running (orphaned or crashed).${tokStr} The task has NOT been completed — pick it up fresh or review any partial work before re-attempting.`;
    try {
      const noteId = overlayStore.addNoteNode(ov, {
        title: `Continuity: stale claim reset (agent '${agentId || '?'}')`,
        summary: noteSummary,
        created_by: 'daemon:sweepStaleClaims',
      });
      // Wire note → task as a context edge so the next agent's get_dependency_summaries sees it.
      overlayStore.addEdge(ov, 'note:' + noteId, key, null, 'context', overlayStore.DEFAULT_CONTEXT_WEIGHT);
    } catch { /* best effort — never block the release */ }
    // Partial cost accounting: if there are token counts, append to the cost log.
    if (tokenUsage && typeof tokenUsage.total === 'number' && tokenUsage.total > 0) {
      try {
        const costLogPath = path.join(__dirname, 'logs', 'cron-token-usage.jsonl');
        const entry = JSON.stringify({
          ts: new Date().toISOString(),
          event: 'stale_claim_release',
          task: key,
          agent_id: agentId || null,
          stale_mins: mins,
          input_tokens: tokenUsage.input_tokens || 0,
          output_tokens: tokenUsage.output_tokens || 0,
          cache_read_tokens: tokenUsage.cache_read_input_tokens || 0,
          total_tokens: tokenUsage.total,
        });
        fs.mkdirSync(path.dirname(costLogPath), { recursive: true });
        fs.appendFileSync(costLogPath, entry + '\n');
      } catch { /* best effort */ }
    } else {
      // No token usage tracked — at minimum log the release event for observability.
      try {
        const costLogPath = path.join(__dirname, 'logs', 'cron-token-usage.jsonl');
        const entry = JSON.stringify({
          ts: new Date().toISOString(),
          event: 'stale_claim_release',
          task: key,
          agent_id: agentId || null,
          stale_mins: mins,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        });
        fs.mkdirSync(path.dirname(costLogPath), { recursive: true });
        fs.appendFileSync(costLogPath, entry + '\n');
      } catch { /* best effort */ }
    }
  }
  return true;
}
// vouchedLive (pure): can a registry record that says 'running' be TRUSTED as live? Within one
// daemon lifetime yes — the record was written this boot (startedAt/lastSeen >= bootMs). Across a
// restart the record is restored from disk and the agent may have died while the daemon was down,
// so 'running' alone is not proof: trust it only once the agent RE-ASSERTS this boot (any
// lastSeen-stamping touch — /agent/start, an /overlay/status write carrying its agent_id), with a
// one-stale-window post-boot grace so survivors have time to do so. Past the grace an un-re-asserted
// record stops shielding and the wall-clock lastChanged check below decides — downtime counts.
function vouchedLive(agent, mins, nowMs, bootMs) {
  if (!agent || agent.state !== 'running') return false;
  const seen = Math.max(Date.parse(agent.lastSeen || '') || 0, Date.parse(agent.startedAt || '') || 0);
  return seen >= bootMs || nowMs - bootMs < mins * 60000;
}
// staleClaimKeys (pure): which in_progress claims are abandoned orphans — worker not vouched live
// AND status unchanged for stale_minutes (kill / crash / idle / cross-session / daemon restart).
// Wall-clock based (persisted ISO timestamps), so time the daemon spent DOWN counts toward
// staleness. Parameterized on (overlay, agents, nowMs, bootMs) so it is unit-testable;
// sweepStaleClaims releases them.
function staleClaimKeys(overlay, agents, nowMs, bootMs = BOOT_MS) {
  const mins = overlay.config.stale_minutes ?? 10;   // ?? not || so an explicit 0 is honored
  const cutoff = nowMs - mins * 60000;
  const out = [];
  for (const [key, st] of Object.entries(overlay.status)) {
    if (st !== 'in_progress') continue;
    const agentId = overlay.assignee[key];
    const agent = agentId ? agents[agentId] : null;
    if (vouchedLive(agent, mins, nowMs, bootMs)) continue;     // live worker — leave it alone
    const ts = overlay.timestamps[key];
    if (ts && Date.parse(ts.lastChanged) > cutoff) continue;   // changed recently — give it time
    out.push({ key, status: st, agentId: agentId || null, mins });
  }
  return out;
}
// Sweep abandoned claims: release every staleClaimKeys() orphan back to ready. Authoritative
// liveness — survives restart (overlay is persisted) and needs no stop hook. Returns true if any.
// Parameterized on (ws, ov) so the sweep operates on the REQUESTED workspace's overlay (buildGraph
// passes its target — claims in a workspace the daemon-global state isn't pinned to still release);
// defaults = old behavior.
function sweepStaleClaims(ws = state.workspace, ov = state.overlay) {
  let dirty = false;
  const stWs = ws === state.workspace ? state : { ...state, overlay: ov };
  for (const { key, agentId, mins } of staleClaimKeys(ov, state.agents, Date.now())) {
    // Snapshot token usage BEFORE clearing the claim so we can finalize it in the cost log
    // and include it in the continuity note for the next agent.
    const tp = taskTranscript(key, null, true, stWs);
    const tokenUsage = tp ? usageCached(tp) : null;
    if (releaseClaim(key, `auto-released: worker '${agentId || '?'}' not running (stale >${mins}m)`, ov, { agentId, mins, tokenUsage })) dirty = true;
  }
  if (dirty) { overlayStore.save(ws, ov); notifyChange(); }
  return dirty;
}
// Auto-retry failed tasks: flip ALL failed tasks back to ready with a note about the prior attempt.
// Mirrors sweepStaleClaims in structure. Returns true if any task was retried.
function sweepFailedTasks(ws = state.workspace, ov = state.overlay) {
  let dirty = false;
  const g = buildGraph(ws);
  for (const t of g.tasks) {
    if (t.status !== 'failed') continue;
    if (!ov.retryConfig) ov.retryConfig = {};
    if (!ov.retryConfig[t.id]) ov.retryConfig[t.id] = {};
    const retryCount = (ov.retryConfig[t.id].retryCount || 0) + 1;
    ov.retryConfig[t.id].retryCount = retryCount;
    const prevAgent = ov.assignee && ov.assignee[t.id];
    ov.notes[t.id] = `auto-requeued after failure (attempt ${retryCount})${prevAgent ? ` — prior agent: '${prevAgent}'` : ''}. Review previous summary before re-attempting.`.slice(0, 280);
    // Flip status back to pending so the task re-enters the ready pipeline
    delete ov.status[t.id];
    const i = t.id.indexOf('/');
    if (i > 0) { try { nt.writeStatus(t.id.slice(0, i), t.id.slice(i + 1), 'pending'); } catch { /* best effort */ } }
    console.log(`[retry] task ${t.id} attempt ${retryCount} (prev agent: ${prevAgent || '?'})`);
    dirty = true;
  }
  if (dirty) { overlayStore.save(ws, ov); notifyChange(); }
  return dirty;
}
// staleVerdictKeys (pure): which 'tested'/'ready' tasks are stale verdict-pending hand-offs — owner
// not live AND lastChanged past stale_minutes. These are SURFACED as guidance, NEVER auto-resolved
// (auto-promoting tested→done would hide a real failure). Same (overlay, agents, nowMs, bootMs)
// shape and the same vouchedLive trust basis as staleClaimKeys (a restored-from-disk 'running'
// record must not suppress surfacing forever after a restart).
function staleVerdictKeys(overlay, agents, nowMs, bootMs = BOOT_MS) {
  const mins = overlay.config.stale_minutes ?? 10;
  const cutoff = nowMs - mins * 60000;
  const out = [];
  for (const [key, st] of Object.entries(overlay.status)) {
    if (st !== 'tested' && st !== 'ready') continue;
    const agentId = overlay.assignee[key];
    const agent = agentId ? agents[agentId] : null;
    if (vouchedLive(agent, mins, nowMs, bootMs)) continue;     // owner still working — give it time
    const ts = overlay.timestamps[key];
    if (ts && Date.parse(ts.lastChanged) > cutoff) continue;   // changed recently — give it time
    out.push({ key, status: st, agentId: agentId || null });
  }
  return out;
}
// Reset stale verdict-pending hand-offs back to pending so the loop re-dispatches them.
// The agent that picks them up can read the codebase and task description to determine current
// state — no human escalation needed. Mirrors sweepStaleClaims in structure.
function sweepStaleVerdicts() {
  const stale = staleVerdictKeys(state.overlay, state.agents, Date.now());
  if (!stale.length) return false;
  let dirty = false;
  for (const { key, status, agentId } of stale) {
    delete state.overlay.status[key];
    delete state.overlay.assignee[key];
    state.overlay.notes[key] = `auto-requeued: '${status}' owner '${agentId || '?'}' not running — reset to pending for re-dispatch`;
    const i = key.indexOf('/');
    if (i > 0) { try { nt.writeStatus(key.slice(0, i), key.slice(i + 1), 'pending'); } catch { /* best effort */ } }
    console.log(`[self-heal] task ${key} (was ${status}) reset to pending — owner gone`);
    dirty = true;
  }
  if (dirty) { overlayStore.save(state.workspace, state.overlay); notifyChange(); }
  return dirty;
}

// Sweep the agent registry: mark 'running' entries as 'dead' when not vouched live.
function sweepStaleAgents() {
  const mins = state.overlay?.config?.stale_minutes ?? 10;
  const now = Date.now();
  for (const [id, a] of Object.entries(state.agents)) {
    if (!a || a.state !== 'running') continue;
    if (vouchedLive(a, mins, now, BOOT_MS)) continue;
    state.agents[id] = { ...a, state: 'dead', endedAt: new Date().toISOString() };
  }
  saveAgents();
}

// Is a driving conversation `session` still live? Authoritative, same basis as sweepStaleClaims:
// live iff it has a RUNNING agent, OR an in_progress claim that changed within stale_minutes. A
// session with neither is dead (closed conversation / killed driver). Empty session ⇒ treat as live
// (a manually-started loop with no bound conversation isn't a zombie by this signal alone).
function sessionIsLive(session) {
  if (!session) return true;
  // A running agent in this session, OR a recently-touched in_progress claim owned by an agent in
  // this session, both prove the conversation is still driving work. Same vouchedLive trust basis
  // as the claim sweep — a restored-from-disk 'running' record must not keep a dead session's
  // zombie loop alive forever after a daemon restart.
  const mins = state.overlay.config.stale_minutes ?? 10;
  const cutoff = Date.now() - mins * 60000;
  for (const a of Object.values(state.agents)) {
    if (!a || a.session !== session) continue;
    if (vouchedLive(a, mins, Date.now(), BOOT_MS)) return true;
  }
  for (const [key, st] of Object.entries(state.overlay.status)) {
    if (st !== 'in_progress') continue;
    const ts = state.overlay.timestamps[key];
    if (!ts || Date.parse(ts.lastChanged) <= cutoff) continue;
    const agentId = state.overlay.assignee[key];
    const agent = agentId ? state.agents[agentId] : null;
    if (agent && agent.session === session) return true;
  }
  return false;
}

// Central liveness sweep for the LOOP registry (same pass/pattern as sweepStaleClaims). Demote an
// active loop to active=false when ANY of: its driving session is dead; its budget or iteration cap
// is already exhausted; or it has made no progress (lastProgress, else startedAt) for longer than
// the staleness threshold. This reclaims zombies — e.g. a loop bound to a closed conversation that
// is never polled again — without a stop hook. Returns true if it demoted anything (caller persists).
function sweepStaleLoops() {
  const mins = state.overlay.config.loop_stale_minutes ?? STALE_PROGRESS_MIN_DEFAULT;
  const cutoff = Date.now() - mins * 60000;
  let dirty = false;
  for (const L of loops.values()) {
    if (!L.active) continue;
    let reason = null;
    if (L.iterations > L.config.maxIterations) reason = 'iteration cap reached';
    else if (L.spent > L.config.tokenBudget) reason = 'token budget exhausted';
    else if (!sessionIsLive(L.session)) {
      // Bootstrap grace: a freshly-started session-bound loop has no RUNNING agent and no touched
      // claim until its FIRST spawn, so sessionIsLive reads false on the loop's very first tick.
      // Skip the session-dead demotion while the loop itself is fresh (within the same
      // stale_minutes window sessionIsLive uses); the other demotion reasons still apply.
      const grace = Date.now() - (state.overlay.config.stale_minutes ?? 10) * 60000;
      const last = Date.parse(L.lastProgress || L.startedAt || 0);
      if (!last || last < grace) reason = `driving session '${L.session}' dead`;
    }
    else {
      const last = Date.parse(L.lastProgress || L.startedAt || 0);
      if (!last || last < cutoff) reason = `no progress >${mins}m`;
    }
    if (reason) { L.active = false; L.sweptReason = reason; dirty = true; }
  }
  if (dirty) { saveLoops(); notifyChange(); }
  return dirty;
}

// Cooperative-stop probe: does a stop/cancel apply to `session`'s in-flight claim(s)? Returns the
// stop descriptor or null. Single source of truth shared by the /should-stop route AND the in-process
// heartbeat (decideAction) — so a flagged stop halts the loop the SAME way the PreToolUse hook would,
// even though the heartbeat tick runs in-process where the hook can't reach it.
//
// Two entry points need DIFFERENT scoping for an agent-targeted stop_requested:
//   - The in-process LOOP heartbeat (default, hook=false) is the session's own driver: a stop on its
//     claimed task's agent should halt the loop. SESSION-scoped — unchanged.
//   - The PreToolUse HOOK (hook=true) fires for EVERY actor sharing the session_id — both a spawned
//     sub-worker AND the orchestrating driver that REQUESTED the stop. Scoping an agent-stop to the
//     session there self-blocks the requester (it shares the session): the driver's own set_status /
//     TaskCreate get denied just for standing down a same-session sub-worker. So under the hook we key
//     the stop_requested check to `actor` — the calling agent_id the hook forwards (present only for a
//     subagent; absent for the main/driver thread) — and halt ONLY the agent the stop targets, never
//     the driver. A human task-CANCEL stays session-scoped under both paths (it halts everyone
//     touching the canceled work, driver included).
function stopSignalFor(session, opts = {}) {
  // `graph`/`ov` (loop path only): the PINNED workspace's graph/overlay, so a pinned loop's
  // cooperative-stop check scans ITS claims, not the daemon-global workspace's. Defaults unchanged.
  const { actor = null, hook = false, graph = null, ov = state.overlay } = opts;
  if (hook) {
    // Agent-scoped stop: the calling worker is itself flagged → halt it (and nobody else). The driver
    // that requested the stop calls with a different/absent agent_id, so it falls through and runs on.
    if (actor && state.overlay.stop_requested[actor]) {
      const g = buildGraph(state.workspace);
      const own = g.tasks.find((t) => t.status === 'in_progress' && (t.agent_id || state.overlay.assignee[t.id]) === actor);
      return { task: own ? own.id : null, agent: actor, reason: 'stop_requested', cancel_requested: null, stop_requested: state.overlay.stop_requested[actor] };
    }
    // Session-scoped CANCEL still halts any actor working a canceled task in this session.
    if (!session) return null;
    const g = buildGraph(state.workspace);
    for (const t of g.tasks) {
      if (t.status !== 'in_progress' || t.session !== session) continue;
      const cr = state.overlay.cancel_requested[t.id] || null;
      if (cr) return { task: t.id, agent: t.agent_id || state.overlay.assignee[t.id] || null, reason: 'cancel_requested', cancel_requested: cr, stop_requested: null };
    }
    return null;
  }
  // In-process loop path: session-scoped — a cancel on a claimed task OR a stop on its agent halts it.
  if (!session) return null;
  const g = graph || buildGraph(state.workspace);
  const claims = g.tasks.filter((t) => t.status === 'in_progress' && t.session === session);
  for (const t of claims) {
    const agent = t.agent_id || ov.assignee[t.id] || null;
    const cr = ov.cancel_requested[t.id] || null;
    const sr = agent ? (ov.stop_requested[agent] || null) : null;
    if (cr || sr) return { task: t.id, agent, reason: cr ? 'cancel_requested' : 'stop_requested', cancel_requested: cr, stop_requested: sr };
  }
  return null;
}

// Collect a problem's judge VERDICTS chronologically (oldest→newest) from its overlay knowledge.
// A verdict is any knowledge item whose value parses to an object carrying a `winner` field (same
// convention the /learnings route uses). Order follows insertion order (attach_knowledge appends),
// which is the round order. Returns [] when the key has none. Pure read of the given overlay
// (defaults to the current workspace's — pinned loops pass their own).
function verdictsFor(key, ov = state.overlay) {
  const items = (ov.knowledge && ov.knowledge[key]) || [];
  const out = [];
  for (const it of items) {
    let v = it && it.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    if (v && typeof v === 'object' && 'winner' in v) out.push(v);
  }
  return out;
}

// Find the in-flight metric problem the loop should re-decide, if any. MECHANICAL signal: a `done`
// task that carries a metric spec AND has at least one judge verdict AND is not optimize-closed AND
// has a NEW verdict since the last 'iterate' decision (so an iterate can't tight-loop on a stale
// round). Returns { task, verdicts } or null. Caller passes the already-built graph (+ its overlay).
function pendingOptimizeProblem(g, ov = state.overlay) {
  for (const t of g.tasks) {
    if (t.kind === 'note' || t.status !== 'done' || !t.metric) continue;
    const rec = (ov.optimize && ov.optimize[t.id]) || {};
    if (rec.closed) continue;                                  // already converged/budget/stuck-escalated
    const verdicts = verdictsFor(t.id, ov);
    if (!verdicts.length) continue;                            // not judged yet
    if (rec.decision === 'iterate' && verdicts.length <= (rec.verdicts || 0)) continue; // no new round since last iterate
    return { task: t, verdicts };
  }
  return null;
}

// Route a problem P's mechanical decideOptimize() verdict into a loop action + persist bookkeeping.
//   converged | budget → mark P optimize-closed (stop iterating this problem) and fall through so
//     the normal drained→plan/stop logic runs (other problems/the DAG continue).
//   stuck → raise a guidance question via the EXISTING escalation gate (request_guidance), which
//     halts the loop for the human. NEVER auto-cancels/replans. Mark closed so it isn't re-raised.
//   iterate → return an 'optimize' action: signal a fresh propose round on the SAME P, feeding the
//     prior verdict forward as context so the planner proposes a DIFFERENT change. Records the
//     verdict count so we only re-decide after the next round lands.
// Returns a loop-action object to return from decideOne(L), or null to fall through. Operates on the
// given loop entry L (per-loop config/active); the caller persists the registry once after the pass.
// `ws`/`ov` = the loop's PINNED workspace + its overlay (defaults = daemon-global, back-compat).
function applyOptimize(prob, base, L, ws = state.workspace, ov = state.overlay) {
  const P = prob.task;
  const last = prob.verdicts[prob.verdicts.length - 1];
  const d = optimize.decideOptimize({
    spec: P.metric,
    verdicts: prob.verdicts,
    budgetRemaining: base.budget_remaining,
    config: { ...OPTIMIZE_DEFAULTS(), ...(ov.config.optimize || {}) },
  });
  if (d.decision === 'iterate') {
    overlayStore.setOptimize(ov, P.id, { decision: 'iterate', verdicts: prob.verdicts.length });
    overlayStore.save(ws, ov); notifyChange();
    return { ...base, action: 'optimize', problem: P.id, label: P.label, metric: P.metric.metric,
      reason: d.reason, prior_verdict: last, next_poll_seconds: L.config.minPoll };
  }
  if (d.decision === 'stuck') {
    // Human-gated halt — reuse the escalation queue exactly like request_guidance. Marks closed so
    // the same problem isn't re-escalated every tick; L.active=false stops this loop.
    overlayStore.addGuidance(ov, {
      question: `Optimization of "${P.label}" is stuck — ${d.reason}. Drop it, retry with a new approach, or take over?`,
      context: `metric=${P.metric.metric}; ${prob.verdicts.length} judged round(s), no usable winner. The loop will NOT auto-cancel or replan — your call.`,
      trigger: 'repeated_failure',
    });
    overlayStore.setOptimize(ov, P.id, { closed: true, decision: 'stuck' });
    L.active = false;
    overlayStore.save(ws, ov); notifyChange();
    return { ...base, action: 'await_user', reason: `optimize stuck on ${P.id}: ${d.reason}` };
  }
  // converged | budget — stop iterating THIS problem; let the normal drained logic decide next.
  overlayStore.setOptimize(ov, P.id, { closed: true, decision: d.decision });
  overlayStore.save(ws, ov); notifyChange();
  return null; // fall through to drained→plan/stop
}

// Decide ONE loop L's action this tick. Honors L's own budget/iterations/config/session. Mutates L
// (iterations++, spent, active=false on terminal). `ctx` carries the shared per-tick graph + a
// mutable spawn pool {batch} multiplexed ACROSS loops, so the daemon never spawns more than the
// configured batch total in a single heartbeat. Returns the loop's decision object (no loopId yet).
function decideOne(L, ctx) {
  // Workspace pin: ctx is built per-workspace by decideAll, so `ws`/`ov`/`ctx.graph` belong to THIS
  // loop's pinned workspace — not the daemon-global pointer, which another session may have flipped
  // mid-run. Legacy callers (tests) passing a bare ctx fall back to the global workspace/overlay.
  const ws = ctx.ws || state.workspace;
  const ov = ctx.ov || state.overlay;
  // Cooperative self-stop (poll EVERY iteration, before anything else): honors a cancel on this
  // loop's claimed task OR a stop on its agent. Self-exits within one tick; registry persisted by caller.
  if (L.active && L.session) {
    const sig = stopSignalFor(L.session, { graph: ctx.graph, ov });
    if (sig) { L.active = false; return { action: 'stop', reason: 'cooperative stop', stop: sig }; }
  }
  // Escalation gate: an open BLOCKING guidance question outranks everything. Halt the loop and wait
  // for the user. 'review' items (judge housekeeping) never pause — they queue on the dashboard.
  if (ctx.pendingGuidance.length) {
    L.active = false;
    return { action: 'await_user', reason: 'awaiting user guidance', review_pending: ctx.reviewPending, questions: ctx.pendingGuidance.map((g) => ({ id: g.id, question: g.question, context: g.context, trigger: g.trigger })) };
  }
  if (!L.active) return { action: 'stop', reason: 'loop not active' };
  L.iterations++;
  if (L.real && state.mainTranscript) {                       // real token accounting from the main transcript
    const u = usageCached(state.mainTranscript);
    L.spent = Math.max(0, (u.total || 0) - L.baseline);
  } else {
    L.spent += L.config.estPerTick;                           // estimate fallback (predictable ceiling)
  }
  const remaining = Math.max(0, L.config.tokenBudget - L.spent);
  const base = { iterations: L.iterations, spent: L.spent, budget_remaining: remaining };
  if (L.iterations > L.config.maxIterations) { L.active = false; return { ...base, action: 'stop', reason: 'iteration cap reached' }; }
  if (L.spent > L.config.tokenBudget) { L.active = false; return { ...base, action: 'stop', reason: 'token budget exhausted' }; }

  const g = ctx.graph;
  const readyAll = g.tasks.filter((t) => t.status === 'ready');
  // Unwired quarantine (livelock guard): an unwired task still derives status "ready", but
  // /overlay/status 409s its claim — spawning a worker for it burns a slot, the worker dies on
  // the 409, the task stays ready, and the next heartbeat respawns it forever. NEVER spawn it.
  // Instead surface it via `wire: [{key,label}]` on the decision: the daemon stays dumb and only
  // reports the flag; the loop-driving dispatcher judges (suggest_links + add_dependency, or
  // mark_root for a true root). Wiring/mark_root clears ov.unwired → spawnable next tick.
  const isUnwired = (t) => !!(ov.unwired && ov.unwired[t.id]);
  const ready = readyAll.filter((t) => !isUnwired(t));
  const wire = readyAll.filter(isUnwired).map((t) => ({ key: t.id, label: t.label }));
  const withWire = (dec) => (wire.length ? { ...dec, wire } : dec);
  const running = g.tasks.filter((t) => t.status === 'in_progress').length;
  const ghostWait = g.tasks.filter((t) => t.status === 'not_ready' && t.deps.some((d) => d.startsWith('ghost:'))).length;

  // CAPACITY-FILL: spare concurrency this loop may use this tick. Tasks always win — they're spawned
  // into headroom FIRST; the edge-judge then fans out PARALLEL efforts into whatever slots are LEFT.
  // headroom = maxConcurrency − running (in-flight workers), floored at 0.
  const headroom = Math.max(0, L.config.maxConcurrency - running);

  // Compute a PARALLEL judge directive that fills `headroom − spawnedThisTick` leftover slots, capped
  // by the queue depth and judgeParallelCap, then CLAMPED to what the loop's remaining token budget can
  // afford (≈ estPerTick per parallel effort). Charges L.spent for all K efforts so the loop still STOPS
  // at tokenBudget even with judge work pending. Returns { parallel, budget } or null when no slots /
  // empty queue / no budget. The per-effort budget is config.judge.budgetPerRun (items per /judge/next).
  function judgeDirective(spawnedThisTick) {
    // Same cap guards as the top of decideOne — never schedule judge work past budget/iteration caps.
    if (L.spent > L.config.tokenBudget || L.iterations > L.config.maxIterations) return null;
    const depth = judge.judgeQueueDepth(ov, g);
    let slots = Math.min(Math.max(0, headroom - spawnedThisTick), depth, L.config.judgeParallelCap);
    if (slots <= 0) return null;
    // Token-budget clamp: each parallel judge effort costs ~estPerTick. The current tick already charged
    // ONE estPerTick (above). Cap K so K × estPerTick fits the remaining budget; never overspend.
    const est = L.config.estPerTick || 0;
    if (est > 0) {
      const affordable = Math.floor(remaining / est);
      slots = Math.min(slots, Math.max(0, affordable));
    }
    if (slots <= 0) return null;
    L.spent += slots * est;                                   // account for all K efforts so the loop stops at budget
    const budget = (ov.config.judge?.budgetPerRun) ?? 6;
    return { parallel: slots, budget };
  }

  if (ready.length && headroom > 0) {
    // Spawn pool is shared ACROSS loops this tick: take up to min(this loop's batch, pool remaining,
    // this loop's spare concurrency). Don't spawn past maxConcurrency.
    const take = Math.max(0, Math.min(L.config.batch, ctx.batch.remaining, headroom, ready.length));
    if (take > 0) {
      ctx.batch.remaining -= take;
      L.lastProgress = now();                                 // progress signal for the liveness sweep (task 3)
      const dec = withWire({ ...base, action: 'spawn', tasks: ready.slice(0, take).map((t) => ({ key: t.id, label: t.label })), next_poll_seconds: L.config.minPoll });
      // A SINGLE heartbeat does BOTH: tasks first, then PARALLEL judge into the leftover slots.
      const jd = judgeDirective(take);
      if (jd) dec.judge = jd;
      return dec;
    }
    // Pool exhausted by earlier loops this tick — idle briefly and retry next heartbeat.
    return withWire({ ...base, action: 'idle', reason: 'spawn batch exhausted this tick', next_poll_seconds: L.config.minPoll });
  }
  // CAPACITY-FILL self-learning (LOW priority — strictly after spawn): no ready task spawned this tick
  // (none ready, or no headroom). If the edge-judge queue has pending work and there are leftover slots
  // AND the budget/iteration cap is NOT exhausted (judgeDirective re-checks + clamps to budget), fan out
  // K parallel judge efforts. Token accounting: L.iterations + one estPerTick were advanced above, and
  // judgeDirective charges the K efforts onto L.spent, so the loop still STOPS at its budget even with
  // judge work pending (next tick the cap guard fires first). Empty queue / no slots → fall through to
  // the in-flight / ghost-wait / drained idle branches exactly as before.
  const jd = judgeDirective(0);
  if (jd) {
    return withWire({ ...base, action: 'judge_edges', parallel: jd.parallel, budget: jd.budget, next_poll_seconds: L.config.minPoll });
  }
  if (running > 0) return withWire({ ...base, action: 'idle', reason: 'work in flight', next_poll_seconds: Math.min(L.config.maxPoll, L.config.minPoll * 2) });
  if (ghostWait > 0) return withWire({ ...base, action: 'idle', reason: 'waiting on cross-workspace dependencies', next_poll_seconds: L.config.maxPoll });
  // ONLY unwired ready tasks remain: the DAG is NOT drained — they become spawnable once wired.
  // Idle (don't stop/plan) and keep reporting `wire` until the dispatcher wires or roots them.
  if (wire.length) return { ...base, action: 'idle', reason: 'ready tasks are unwired — wire them (add_dependency or mark_root) to make them spawnable', next_poll_seconds: L.config.minPoll, wire };
  // DAG drained. Metric-driven CONVERGED-VS-ITERATE control (⑥) — unchanged, now per-loop.
  const prob = pendingOptimizeProblem(g, ov);
  if (prob) { const a = applyOptimize(prob, base, L, ws, ov); if (a) return a; }
  if (ov.config.self_plan && remaining > 0) return { ...base, action: 'plan', reason: 'DAG drained; self-planning a next initiative', next_poll_seconds: L.config.minPoll };
  L.active = false;
  return { ...base, action: 'stop', reason: 'DAG drained (nothing ready, running, or externally pending)' };
}

// ONE heartbeat drives the WHOLE registry. Iterate every ACTIVE loop, compute each one's decision
// honoring its own budget/config/session, and return a batched array [{ loopId, action, ... }]. The
// `batch` config multiplexes across loops via a shared per-tick spawn pool (max of the active loops'
// batch settings — generous but bounded). Inactive loops are skipped. Caller persists the registry.
function decideAll() {
  sweepStaleLoops();   // central liveness sweep (same pass): demote dead/exhausted/stalled loops first
  sweepStaleVerdicts();   // reset abandoned verdict-pending hand-offs (tested/ready, no live owner) back to pending for re-dispatch
  sweepFailedTasks();   // auto-retry: flip failed tasks back to pending if maxRetries allows it
  const active = [...loops.values()].filter((L) => L.active);
  // ONE spawn pool shared across ALL loops this tick (regardless of workspace) — the daemon-wide
  // concurrency bound is about total spawned workers, not per-workspace.
  const batch = { remaining: active.reduce((m, L) => Math.max(m, L.config.batch || 0), 0) };
  // Per-WORKSPACE evaluation contexts (the loop-workspace-pin fix): each loop is decided against ITS
  // pinned workspace's graph/overlay/guidance — never the daemon-global pointer, which another
  // session's SessionStart hook may have flipped mid-run (that demoted live loops with "DAG drained").
  // Unpinned/legacy entries (workspace null) keep the old behavior: follow state.workspace.
  const ctxByWs = new Map();
  function ctxFor(ws) {
    let c = ctxByWs.get(ws);
    if (!c) {
      const ov = (ws === state.workspace) ? state.overlay : overlayStore.load(ws);
      const pend = overlayStore.pendingGuidance(ov);
      c = {
        ws, ov,
        graph: buildGraph(ws),
        pendingGuidance: pend.filter((g) => g.severity !== 'review'),   // BLOCKING only — gates await_user
        reviewPending: pend.filter((g) => g.severity === 'review').length,
        batch,
      };
      ctxByWs.set(ws, c);
    }
    return c;
  }
  const out = [];
  for (const L of active) {
    const ctx = ctxFor(L.workspace || state.workspace);
    const d = decideOne(L, ctx);
    const entry = { loopId: L.id, ...d };
    if (ctx.reviewPending > 0) {
      const pend = overlayStore.pendingGuidance(ctx.ov);
      entry.review_items = pend.filter((g) => g.severity === 'review').map((g) => ({ id: g.id, question: g.question }));
    }
    out.push(entry);
  }
  return out;
}

const now = () => new Date().toISOString();
const agentsArr = () => Object.values(state.agents);
function baseStatus(s) { return s === 'completed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'pending'; }

// Relevance scoring shared by /task/suggest and auto-wiring: rank every other node in the graph
// by token-overlap of label+summary against `target`. Returns matches sorted desc by score, each
// { key, label, status, score, shared, suggest_kind, duplicate }. suggest_kind is 'context' for
// done/note providers (summary flows in) and 'blocking' for open tasks (a real prerequisite).
// One source of truth so auto-wiring uses the IDENTICAL relevance the agent sees from suggest_links.
const SUGGEST_STOP = new Set(['the', 'and', 'for', 'task', 'with', 'that', 'this', 'from', 'into', 'use', 'run', 'add', 'all', 'new', 'via', 'its']);
const suggestToks = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !SUGGEST_STOP.has(w)));
const SUGGEST_DUP_THRESHOLD = 0.6;   // high label/summary overlap with an OPEN task ⇒ likely a re-plan duplicate
// Score a single node's label+summary against a precomputed set of QUERY tokens (`qt`), using the
// IDENTICAL cosine-style token-overlap as scoreMatches — but anchored on a free-text query instead
// of another task. Returns { shared, score }. Shared by /search (query-by-text retrieval).
// Flatten a Tier-2 knowledge item to a single searchable string (for embedding + lexical scoring).
// Items are { type, value, ... } where value is a string or an object; we join the human-meaningful
// fields and stringify object values so a note/snippet/link all yield usable text. Skips the internal
// _vec field. Returns '' for an empty/odd item (embed() then returns null ⇒ lexical fallback).
function knowledgeText(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  const parts = [];
  if (item.type) parts.push(String(item.type));
  const v = item.value;
  if (typeof v === 'string') parts.push(v);
  else if (v != null) { try { parts.push(JSON.stringify(v)); } catch { /* ignore */ } }
  for (const f of ['title', 'label', 'note', 'summary', 'path']) if (typeof item[f] === 'string') parts.push(item[f]);
  return parts.join(' ').slice(0, 2000);
}

function scoreNodeAgainstTokens(node, qt) {
  const xt = suggestToks(`${node.label} ${node.summary || ''}`);
  const shared = [...qt].filter((w) => xt.has(w));
  const score = qt.size && xt.size ? shared.length / Math.sqrt(qt.size * xt.size) : 0;
  return { shared, score };
}

// As-of temporal filter for state-change reasoning over note nodes (the Zep gap). Given a graph
// node and an ISO `asOf` instant, decide whether that node was the CURRENT fact at that time:
//   - non-note nodes (tasks) are always kept (no validity window) — temporal filtering is note-only.
//   - a note is current at T iff validFrom <= T AND (validTo is null OR T < validTo).
//   - a note with NO validFrom (pre-temporal note) is always kept (back-compat — can't time-filter it).
// This is what lets `search_knowledge(asOf=…)` return the fact that was true at a past task-time
// instead of only the latest, recovering history WITHOUT deleting superseded rows.
function noteCurrentAsOf(node, asOf) {
  if (!asOf) return true;
  if ((node.kind || 'task') !== 'note') return true;
  const vf = node.validFrom;
  if (!vf) return true;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return true;       // unparseable asOf ⇒ don't filter (fail-open)
  if (Date.parse(vf) > t) return false;   // fact not yet true at T
  if (node.validTo && Date.parse(node.validTo) <= t) return false; // fact already retired by T
  return true;
}

function scoreMatches(g, target) {
  const tg = suggestToks(`${target.label} ${target.summary || ''}`);
  const linked = new Set([...(target.deps || []), ...(target.context_deps || [])]);
  const OPEN = new Set(['not_ready', 'ready', 'in_progress']);
  return g.tasks
    .filter((x) => x.id !== target.id && !linked.has(x.id))
    .map((x) => {
      const xt = suggestToks(`${x.label} ${x.summary || ''}`);
      const shared = [...tg].filter((w) => xt.has(w));
      const score = tg.size && xt.size ? shared.length / Math.sqrt(tg.size * xt.size) : 0;
      const duplicate = score >= SUGGEST_DUP_THRESHOLD && OPEN.has(x.status) && x.kind !== 'note';
      return { key: x.id, label: x.label, status: x.status, score: Math.round(score * 1000) / 1000, shared: shared.slice(0, 8), suggest_kind: (x.kind === 'note' || x.status === 'done') ? 'context' : 'blocking', duplicate };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

// SEMANTIC variant of scoreMatches: identical return shape, but each candidate is scored by
// cosine(targetVec, candidate.vec) when BOTH carry a 384-dim embedding, falling back PER-CANDIDATE
// to the lexical token-overlap score when either vec is genuinely missing. This is what lets note
// wiring connect prose that shares MEANING but few literal tokens (the lexical scorer scored those
// pairs below 0.25 and left them orphaned). Used by autowireNoteProvider; `target` is the synthetic
// note target, `targetVec` its stored embedding (may be null ⇒ everything falls back to lexical).
function scoreMatchesSemantic(g, target, targetVec) {
  const tg = suggestToks(`${target.label} ${target.summary || ''}`);
  const linked = new Set([...(target.deps || []), ...(target.context_deps || [])]);
  const OPEN = new Set(['not_ready', 'ready', 'in_progress']);
  const tvec = Array.isArray(targetVec) ? targetVec : null;
  return g.tasks
    .filter((x) => x.id !== target.id && !linked.has(x.id))
    .map((x) => {
      const xt = suggestToks(`${x.label} ${x.summary || ''}`);
      const shared = [...tg].filter((w) => xt.has(w));
      const lex = tg.size && xt.size ? shared.length / Math.sqrt(tg.size * xt.size) : 0;
      // Semantic cosine when BOTH sides have a real vector; otherwise lexical fallback for THIS pair.
      const semantic = tvec && Array.isArray(x.vec);
      const score = semantic ? cosine(tvec, x.vec) : lex;
      const duplicate = score >= SUGGEST_DUP_THRESHOLD && OPEN.has(x.status) && x.kind !== 'note';
      return { key: x.id, label: x.label, status: x.status, score: Math.round(score * 1000) / 1000, shared: shared.slice(0, 8), suggest_kind: (x.kind === 'note' || x.status === 'done') ? 'context' : 'blocking', duplicate, via: semantic ? 'semantic' : 'lexical' };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Default auto-wire relevance threshold (conservative — err toward FEWER false edges). A newly
// seen task auto-gets a weighted context edge to each context-eligible match scoring >= this.
const DEFAULT_AUTOWIRE_THRESHOLD = 0.25;
// Semantic auto-wire threshold. Cosine similarity over MiniLM embeddings sits on a DIFFERENT scale
// than lexical token-overlap (related prose lands ~0.4–0.7 cosine, where it scored ~0 lexically), so
// the lexical 0.25 bar is wrong here — it would wire nearly everything into a clique. Tuned on the
// post-backfill cloude corpus (128 notes); see STEP 2. Used only by the semantic note-wiring path.
const SEMANTIC_AUTOWIRE_THRESHOLD = 0.55;
// Auto-wire a genuinely-new task (`target`) into the graph `g` by writing weighted CONTEXT edges
// into `overlay`: an edge (weight = relevance score) to each context-eligible match (done/note
// provider) scoring >= threshold. CONTEXT only — never blocking. Idempotent via addEdge's dedupe
// plus the caller's firstSeen guard (only ever invoked on a task's first sighting). Returns the
// count of edges added. No match clears the bar ⇒ 0 edges, correctly marking a genuinely novel
// task. Pure on (overlay, g, target) so it unit-tests without daemon state.
function autowireNewTask(overlay, g, target, threshold = DEFAULT_AUTOWIRE_THRESHOLD) {
  let added = 0;
  for (const m of scoreMatches(g, target)) {
    if (m.suggest_kind !== 'context') continue; // CONTEXT edges only — never auto-blocking
    if (m.score < threshold) continue;
    // m.key is the provider's graph-node id (note nodes are 'note:<id>'), which is exactly what
    // depRefs matches edge.from against — store it verbatim as the context edge's source.
    const before = overlay.edges.length;
    overlayStore.addEdge(overlay, m.key, target.id, null, 'context', m.score);
    if (overlay.edges.length > before) added++; // count only genuinely-new edges (addEdge dedupes)
  }
  return added;
}

// Auto-wire a NOTE as a context PROVIDER: write weighted context edges (note -> neighbor) so the
// note's summary flows INTO each relevant open task instead of the note sitting as an orphan root.
// This is the mirror of autowireNewTask: there a new task CONSUMES existing providers; here a new
// note FEEDS existing consumers. `g` is the rebuilt graph; the note need not be in `g` yet (we build
// a synthetic target). Edges are ALWAYS note -> neighbor (the note is `from`) — the note is the
// PROVIDER, never the consumer of THIS edge. Scoring is SEMANTIC: cosine(targetVec, candidate.vec)
// when both carry an embedding, lexical fallback per-candidate otherwise. We skip `done` targets
// (feeding context into finished work is useless) but note->note IS now allowed: a note MAY receive
// an incoming context edge from ANOTHER note, knitting the knowledge notes into a navigable web
// (this intentionally reverses the earlier "no incoming edge on a note" rule). Cap to top-5 by score
// so a noisy note can't spam the graph. Pure on (overlay, g, noteKey, ...) ⇒ unit-testable; idempotent.
function autowireNoteProvider(overlay, g, noteKey, title, summary, targetVec = null, threshold = SEMANTIC_AUTOWIRE_THRESHOLD) {
  const target = { id: noteKey, label: title, summary: summary || '', deps: [], context_deps: [] };
  let added = 0;
  const kept = scoreMatchesSemantic(g, target, targetVec)
    .filter((m) => m.score >= threshold)                          // relevance bar (semantic cosine scale)
    .filter((m) => m.status !== 'done')                           // skip done (feeding finished work is useless); note->note IS now allowed
    .slice(0, 5);                                                 // cap fan-out — a noisy note can't spam the graph
  for (const m of kept) {
    const before = overlay.edges.length;
    overlayStore.addEdge(overlay, noteKey, m.key, null, 'context', m.score); // note is PROVIDER (from)
    if (overlay.edges.length > before) added++; // count only genuinely-new edges (addEdge dedupes)
  }
  return added;
}

// RECALL half of the RAG-candidate → agent-adjudicator pipeline. For an orphan/under-connected note,
// return up to `top` semantic candidates (cosine >= RAG_RECALL_THRESHOLD) the AGENT will adjudicate —
// it does NOT write any edge (that's the judge's verdict, never a cosine score). Looser than the old
// autowire bar: recall, not precision (the agent supplies precision). Each candidate carries the
// endpoint's title+summary+key+score+via so the judge can reason without extra reads. Skips candidates
// the note ALREADY has a context edge to (no point re-proposing an existing edge). Pure read of `g`.
const RAG_RECALL_THRESHOLD = 0.40;   // RECALL bar — deliberately below the old 0.55 precision bar
function noteRagCandidates(overlay, g, noteKey, title, summary, targetVec = null, top = 8) {
  const target = { id: noteKey, label: title, summary: summary || '', deps: [], context_deps: [] };
  const existing = new Set(overlay.edges.filter((e) => e.from === noteKey && e.kind === 'context').map((e) => e.to));
  return scoreMatchesSemantic(g, target, targetVec)
    .filter((m) => m.score >= RAG_RECALL_THRESHOLD)
    .filter((m) => !existing.has(m.key))                          // don't re-propose an edge we already have
    .slice(0, top)
    .map((m) => ({ key: m.key, title: m.label, summary: String((g.tasks.find((t) => t.id === m.key) || {}).summary || '').slice(0, 200), score: m.score, status: m.status, via: m.via }));
}

// DEMOTED (edge-judge rework): the periodic sweep no longer WRITES similarity edges. It used to replay
// every orphan note through autowireNoteProvider (blindly attaching cosine edges) — exactly the
// RAG-as-DAG pass we replaced. The judge QUEUE subsumes orphan tracking: buildQueue() reads orphans
// (current, under-connected, not-yet-judged-this-epoch notes) LIVE every /judge/next tick, so there's
// nothing to persist here — an orphan is simply eligible to be pulled and adjudicated by the agent.
// Kept as a cheap no-op (rather than ripped out) so the existing un-driven interval below still has a
// callee and any external caller doesn't 404; it returns 0 and never mutates the overlay.
function sweepOrphanNotes() { return 0; }

// ---- workspace-aware graph engine -----------------------------------------
// A "ref" is { ws, key } where key = "{session}/{id}". Resolution may cross workspaces
// (ghost edges); caches keep it to one read per workspace per request.
function makeResolver() {
  const agg = {}; // ws -> { key: task }
  const ov = {};  // ws -> overlay
  const memo = {}; // "ws|key" -> status

  function loadWs(ws) {
    if (!agg[ws]) {
      agg[ws] = Object.fromEntries(aggregateCached(ws).map((t) => [t.key, t]));
      ov[ws] = (state.workspace === ws) ? state.overlay : overlayStore.load(ws);
    }
    return { tasks: agg[ws], overlay: ov[ws] };
  }

  // Dependency refs for a task: native (same ws) + inbound overlay edges (from may be ghost).
  function depRefs(ws, key) {
    const { tasks, overlay } = loadWs(ws);
    const t = tasks[key];
    const local = t ? t.deps.map((k) => ({ ws, key: k, kind: 'blocking' })) : [];
    const edges = overlay.edges
      .filter((e) => e.to === key && !e.toWorkspace)
      .map((e) => ({ ws: e.fromWorkspace || ws, key: e.from, ghost: !!e.fromWorkspace, kind: e.kind === 'context' ? 'context' : 'blocking', weight: overlayStore.edgeWeight(e) }));
    return [...local, ...edges];
  }

  function effective(ws, key, seen = new Set()) {
    const id = `${ws}|${key}`;
    if (memo[id]) return memo[id];
    if (seen.has(id)) return 'not_ready'; // cycle guard — do NOT memoize the sentinel (poisons unrelated paths)
    const { tasks, overlay } = loadWs(ws);
    const override = overlay.status[key];
    if (override) return (memo[id] = override);
    const t = tasks[key];
    if (!t) return 'not_ready'; // ghost target missing / unknown
    const base = baseStatus(t.native_status);
    if (base !== 'pending') return (memo[id] = base);
    seen.add(id);
    const ready = depRefs(ws, key).filter((d) => d.kind !== 'context').every((d) => effective(d.ws, d.key, seen) === 'done'); // context edges never block
    seen.delete(id);
    return (memo[id] = ready ? 'ready' : 'not_ready');
  }

  function label(ws, key) { const { tasks } = loadWs(ws); return tasks[key] ? tasks[key].label : key; }
  return { loadWs, depRefs, effective, label };
}

// Find the transcript of the HARNESS agent that actually ran a task, by time-window correlation.
// The assignee recorded on a task is a LOGICAL worker name (what start_task passed); but the agent
// record that carries transcript_path is registered by the SubagentStart hook under a random harness
// agent_id, so the two never match by key. Correlate instead: among agents in the SAME session, pick
// the one whose [startedAt, endedAt] interval overlaps the task's in_progress claim window. The claim
// window is bounded by the overlay timestamps (firstSeen..lastChanged) of the in_progress claim.
// Returns the best-overlapping agent's transcript_path, or null. Pure on `st` so it's unit-testable.
function harnessTranscriptForTask(st, key, session) {
  if (!session) return null;
  const ts = st.overlay.timestamps && st.overlay.timestamps[key];
  if (!ts) return null;
  // Claim window: from when the task was first seen to its last status change (covers the in_progress
  // span). Parse defensively — a missing/unparsable bound widens the window rather than rejecting.
  const winStart = Date.parse(ts.firstSeen);
  const winEnd = Number.isNaN(Date.parse(ts.lastChanged)) ? Date.now() : Date.parse(ts.lastChanged);
  if (Number.isNaN(winStart)) return null;
  let best = null, bestOverlap = -1;
  for (const a of Object.values(st.agents || {})) {
    if (!a || a.session !== session || !a.transcript_path) continue;     // same session + has a transcript
    const aStart = Date.parse(a.startedAt);
    if (Number.isNaN(aStart)) continue;
    const aEnd = a.endedAt && !Number.isNaN(Date.parse(a.endedAt)) ? Date.parse(a.endedAt) : Date.now(); // still running -> now
    const overlap = Math.min(winEnd, aEnd) - Math.max(winStart, aStart);  // >=0 means the intervals touch
    if (overlap >= 0 && overlap > bestOverlap) { best = a.transcript_path; bestOverlap = overlap; }
  }
  return best;
}

// Resolve the transcript JSONL holding a task's token usage. Prefer the assignee agent's own
// transcript (accurate). Else fall back to a same-session harness agent whose run window overlaps
// the task's claim (the SubagentStart-registered record that actually holds transcript_path; the
// assignee key never matches it directly). Else fall back to the task's session transcript —
// gated by `anySession`: taskTokens only allows it when the session maps to a single task (so it
// never paints the same conversation-wide total across many tasks); /costflow always allows it
// because splitSessionTokens divides a shared total honestly. null = unknown.
function taskTranscript(key, session, anySession, st = state) {
  const assignee = st.overlay.assignee[key];
  const agent = assignee ? st.agents[assignee] : null;
  let tp = agent && agent.transcript_path;
  if (!tp && agent && agent.session && st.mainTranscript) {              // worker registered its own session transcript
    tp = path.join(path.dirname(st.mainTranscript), `${agent.session}.jsonl`);
  }
  if (!tp) tp = harnessTranscriptForTask(st, key, session);             // time-window correlation fallback
  if (!tp && anySession && session && st.mainTranscript) {               // task's shared session transcript
    tp = path.join(path.dirname(st.mainTranscript), `${session}.jsonl`);
  }
  if (!tp) return null;
  try { return fs.existsSync(tp) ? tp : null; } catch { return null; }
}

// Per-task token total for the graph node. null = unknown.
function taskTokens(key, session, dedicated, st = state) {
  const tp = taskTranscript(key, session, dedicated, st);
  if (!tp) return null;
  const u = usageCached(tp);
  return u && typeof u.total === 'number' ? u.total : null;
}

// Build the graph for one workspace: its task nodes + any ghost stubs they reference.
function buildGraph(ws) {
  if (!ws) return { tasks: [], ghosts: [], summary: summaryFor([], []) };
  // The TARGET workspace's overlay: state.overlay when ws IS the current workspace (in-memory
  // coherence), else loaded fresh — so reads of another workspace serve THAT workspace's
  // notes/summaries/assignees instead of the daemon-global overlay's (the read-side gremlin fix).
  const own = ws === state.workspace;
  const ovWs = own ? state.overlay : overlayStore.load(ws);
  // Release dead/abandoned claims BEFORE reading native, busting the aggregate cache so a reverted
  // native status is reflected in this same build (not one poll later). Sweeps the TARGET
  // workspace's overlay, so stale claims release wherever the read lands.
  if (sweepStaleClaims(ws, ovWs)) { cache.agg.delete(ws); cache.aggAt.delete(ws); }
  const R = makeResolver();
  const native = aggregateCached(ws);
  const ghostMap = {}; // "ws|key" -> ghost stub
  const sessionCount = {}; for (const t of native) sessionCount[t.session] = (sessionCount[t.session] || 0) + 1;
  const stWs = own ? state : { ...state, overlay: ovWs };   // taskTokens reads assignee from the target overlay

  // Stamp lifecycle timestamps in OUR own overlay (current workspace only — the writable store).
  // firstSeen: set once, never overwritten. lastChanged: set on first sight + whenever the
  // effective status changes. lastStatus tracks the value used to detect changes. Not backfilled.
  let tsDirty = false;
  const newlySeen = []; // task keys first seen THIS build — candidates for one-shot auto-wiring

  const tasks = native.map((t) => {
    const refs = R.depRefs(ws, t.key);
    const deps = [];          // blocking deps (gate readiness + drive layout)
    const context_deps = [];  // non-blocking context providers (summary feeds in)
    const context_weights = {}; // id -> relevance weight (0..1) for context edges (spreading-activation substrate)
    for (const d of refs) {
      const bucket = d.kind === 'context' ? context_deps : deps;
      if (d.ws === ws) { bucket.push(d.key); if (d.kind === 'context') context_weights[d.key] = d.weight; }
      else {
        const gid = `${d.ws}|${d.key}`;
        bucket.push(`ghost:${gid}`);
        if (d.kind === 'context') context_weights[`ghost:${gid}`] = d.weight;
        if (!ghostMap[gid]) ghostMap[gid] = { workspace: d.ws, key: d.key, label: R.label(d.ws, d.key), status: R.effective(d.ws, d.key) };
      }
    }
    const status = R.effective(ws, t.key);
    let ts = ovWs.timestamps[t.key] || null;   // read from the target overlay; stamping stays own-only below
    if (own) {
      if (!ts) {
        ts = { firstSeen: now(), lastChanged: now(), lastStatus: status }; state.overlay.timestamps[t.key] = ts; tsDirty = true; newlySeen.push(t.key);
        // Unwired quarantine: a task FIRST SEEN with no edges in either direction is stamped
        // unwired — /overlay/status refuses an in_progress claim until the creator wires it
        // (add_dependency clears the flag) or declares it a root (POST /mark-root). Tasks that
        // existed before this feature already carry firstSeen and are NEVER stamped (back-compat).
        if (!deps.length && !context_deps.length && !state.overlay.edges.some((e) => e.from === t.key || e.to === t.key)) {
          if (!state.overlay.unwired) state.overlay.unwired = {};
          state.overlay.unwired[t.key] = true;
        }
      }
      else if (ts.lastStatus !== status) { ts.lastChanged = now(); ts.lastStatus = status; tsDirty = true; }
    }
    const _rc = ovWs.retryConfig && ovWs.retryConfig[t.key];
    return { id: t.key, label: t.label, session: t.session, deps, context_deps, context_weights, status, note: ovWs.notes[t.key] || '', agent_id: ovWs.assignee[t.key] || null, summary: ovWs.summaries[t.key] || '', git: ovWs.git[t.key] || null, git_user: (ovWs.git_users && ovWs.git_users[t.key]) || null, repo: (ovWs.repos && ovWs.repos[t.key]) || null, metric: (ovWs.metrics && ovWs.metrics[t.key]) || null, measurement: (ovWs.measurements && ovWs.measurements[t.key]) || null, benchmark: (ovWs.benchmarks && ovWs.benchmarks[t.key]) || null, firstSeen: ts ? ts.firstSeen : null, lastChanged: ts ? ts.lastChanged : null, tokens: taskTokens(t.key, t.session, sessionCount[t.session] === 1, stWs), maxRetries: (_rc && _rc.maxRetries) || 0, retryCount: (_rc && _rc.retryCount) || 0 };
  });
  // Append overlay-only NOTE nodes (durable decisions/findings). They are context providers,
  // not real tasks: deps:[] (level-0), status 'note', and excluded from status counts.
  for (const n of Object.values(ovWs.note_nodes || {})) {
    tasks.push({ id: 'note:' + n.id, label: n.title, kind: 'note', status: 'note', session: null, deps: [], context_deps: [], note: '', agent_id: null, summary: n.summary, vec: Array.isArray(n.vec) ? n.vec : null,
      // Temporal/state-change fields (null on pre-temporal notes — back-compat): validFrom/validTo
      // bound when the fact was true; supersedes/supersededBy chain it to the note it replaced / was
      // replaced by. The dashboard reads these for the superseded indicator; /search for as-of.
      validFrom: n.validFrom || n.created_at || null, validTo: n.validTo || null,
      created_at: n.created_at || null,   // transaction time (when the KB learned this) — read by /search?knownAsOf
      supersedes: n.supersedes ? 'note:' + n.supersedes : null,
      supersededBy: n.supersededBy ? 'note:' + n.supersededBy : null });
  }
  // Auto-wire genuinely-new tasks (those first seen THIS build) into the graph with weighted
  // context edges to relevant done/note providers. Runs after notes are appended so they're
  // scoreable. Scoped to `newlySeen` (only the !ts branch) ⇒ pre-existing backlog tasks already
  // carry a firstSeen and are NEVER swept, so a daemon restart can't spam edges across the graph.
  let edgesDirty = false;
  if (own && newlySeen.length) {
    const threshold = state.overlay.config.autowire_threshold ?? DEFAULT_AUTOWIRE_THRESHOLD;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const key of newlySeen) {
      const target = byId.get(key);
      if (target && autowireNewTask(state.overlay, { tasks }, target, threshold)) edgesDirty = true;
    }
    // A node was ADDED ⇒ bump the graph-change epoch so the edge-judge re-pulls notes whose
    // neighborhood may now have a new candidate (judgedAtEpoch < epoch becomes true again). One bump
    // per build that saw new nodes — cheap, monotonic, persisted with the overlay below.
    overlayStore.bumpEpoch(state.overlay); edgesDirty = true;
  }
  if (tsDirty || edgesDirty) { overlayStore.save(state.workspace, state.overlay, { deferred: true }); notifyChange(); }
  const ghosts = Object.values(ghostMap);
  return { tasks, ghosts, summary: summaryFor(tasks, ghosts, ovWs) };
}

function summaryFor(tasks, ghosts, ov = state.overlay) {
  const real = tasks.filter((t) => t.kind !== 'note'); // note nodes aren't tasks — keep counts honest
  const notes = tasks.length - real.length;
  const c = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  for (const t of real) c[t.status] = (c[t.status] || 0) + 1;
  const a = agentsArr();
  return {
    tasks_total: real.length,
    notes,
    statuses: c,
    sessions: new Set(real.map((t) => t.session)).size,
    edges: ov.edges.length,
    ghosts: ghosts.length,
    agents: { total: a.length, running: a.filter((x) => x.state === 'running').length, done: a.filter((x) => x.state === 'done').length },
    lastRoute: state.routes[state.routes.length - 1] || null,
  };
}

// Digest a "rejected" ledger of approaches NOT to re-propose: verdict losers (beaten by a winner) plus
// GENUINE dead-end failures. Superseded/duplicate/consolidated failures are replaced work, not dead
// ends, so they are excluded. `labelFor(key)` resolves a task label ('' if unknown). Pure — unit-tested.
// Truthy query-param test for flags like ?compact=1 / =true / =yes (any non-falsey present value).

// Per-IP gated-search rate limiter: max 20 gated calls per 60s window.
// Higher limit (was 3) to avoid blocking sequential bench trial runs — all trials share
// the same 127.0.0.1 bucket, so a low limit causes spurious abstains between trials.
const gatedSearchCounts = new Map(); // ip -> { count, windowStart }
function checkGatedRateLimit(ip) {
  const now = Date.now();
  const entry = gatedSearchCounts.get(ip);
  if (!entry || now - entry.windowStart >= 60_000) {
    gatedSearchCounts.set(ip, { count: 1, windowStart: now });
    return false; // not rate-limited
  }
  entry.count++;
  return entry.count > 20; // rate-limited if over 20
}
function isTruthy(v) { return v != null && v !== '' && v !== '0' && v !== 'false' && v !== 'no'; }

// Lean transform of the full /learnings payload: a planner re-attends learnings every tick, so the
// full payload (recent + all failures + fat verdicts) dominates cache_read cost. Keep the digested
// rejected[] ledger as-is, trim verdicts to {key,winner,why} (why truncated), drop recent, and
// collapse failures to failuresCount. Pure; input not mutated.
function leanLearnings(full) {
  const verdicts = (full.verdicts || []).map(({ key, verdict }) => {
    const v = verdict || {};
    let why = v.why || v.reason || '';
    if (typeof why === 'string' && why.length > 200) why = why.slice(0, 200);
    return { key, winner: v.winner, why };
  });
  return { verdicts, rejected: full.rejected || [], failuresCount: (full.failures || []).length };
}

function digestRejected(verdicts, failures, labelFor) {
  const rejected = [];
  for (const { verdict } of verdicts) {
    for (const l of (verdict.losers || [])) {
      const lab = labelFor(l.key);
      rejected.push({ approach: lab ? `${l.key} (${lab})` : l.key, reason: l.reason || '', beatenBy: verdict.winner, source: 'verdict' });
    }
  }
  for (const f of failures) {
    if (/supersed|duplicate|consolidat/i.test(f.note)) continue;
    rejected.push({ approach: f.label ? `${f.key} (${f.label})` : f.key, reason: f.note, source: 'failure' });
  }
  return rejected;
}

// Sum per-message token usage from a transcript JSONL (the only place per-agent tokens live;
// undocumented format — isolated here). Used for the detail panel's token figure.
function readUsage(p) {
  try {
    let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, messages = 0;
    const byModel = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = (o.message && o.message.usage) || o.usage;
      if (u) {
        messages++;
        input += u.input_tokens || 0; output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0; cacheCreate += u.cache_creation_input_tokens || 0;
        const m = (o.message && o.message.model) || o.model;
        if (m) {
          if (!byModel[m]) byModel[m] = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
          byModel[m].input_tokens += u.input_tokens || 0;
          byModel[m].output_tokens += u.output_tokens || 0;
          byModel[m].cache_read_input_tokens += u.cache_read_input_tokens || 0;
          byModel[m].cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
        }
      }
    }
    return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, total: input + output, messages, by_model: byModel };
  } catch (e) { return { error: e.code || e.message }; }
}

function readTranscript(p, maxLines = 200) {
  try {
    const raw = fs.readFileSync(p, 'utf8').trim().split('\n').slice(-maxLines);
    const out = [];
    for (const line of raw) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const role = o.type || o.role || '';
      const c = o.message?.content ?? o.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || (b?.type ? `[${b.type}]` : '')).join(' ').trim() : '';
      if (text) out.push(`${role}: ${text}`);
    }
    return out.join('\n');
  } catch (e) { return `(no transcript: ${e.code || e.message})`; }
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Connection': 'close' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
  return true;
}
function readBody(req) { return new Promise((r) => { const chunks = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > 1048576) { req.destroy(); return r({}); } chunks.push(c); }); req.on('end', () => { try { const b = Buffer.concat(chunks).toString('utf8'); r(b ? JSON.parse(b) : {}); } catch { r({}); } }); }); }

// --- idempotent replay for non-idempotent mutating POSTs (restart-retry safety) ---------------
// mcp-core's makeCall retries connection-level failures; a retry can DUPLICATE a write that
// actually landed (ECONNRESET after delivery, before the response). The client stamps ONE op_id
// (uuid) per LOGICAL mutating request, reused across its retries; routes that mint state per call
// (/overlay/note — new note id each call; /overlay/knowledge — array append; /overlay/status —
// follow-up/guidance minting) replay the recorded response on a duplicate op_id instead of
// re-applying. (/overlay/edge needs none: addEdge dedupes on (from,to,fromWorkspace) — already
// idempotent.) Small persisted LRU in the daemon data dir so dedupe survives a restart mid-retry.
// Only SUCCESS responses are recorded — an error response is deterministic to re-derive.
const OP_CACHE_FILE = path.join(BASE, 'op-cache.json');
const OP_CACHE_MAX = 200;
const opCache = new Map();   // op_id -> { code, body } (Map = insertion-ordered LRU)
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(OP_CACHE_FILE, 'utf8')))) opCache.set(k, v); } catch { /* none yet */ }
function opReplay(res, b) {
  const hit = b && b.op_id ? opCache.get(String(b.op_id)) : null;
  if (!hit) return false;
  send(res, hit.code, hit.body);
  return true;
}
function sendOp(res, b, code, body) {
  if (b && b.op_id) {
    opCache.set(String(b.op_id), { code, body });
    while (opCache.size > OP_CACHE_MAX) opCache.delete(opCache.keys().next().value);
    try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(OP_CACHE_FILE, JSON.stringify(Object.fromEntries(opCache))); } catch { /* best effort */ }
  }
  return send(res, code, body);
}


// Route modules: each handles a group of endpoints. Built once; ctx is live via getters.
const metaRoute = require('./routes/meta');
const graphRoute = require('./routes/graph');
const taskRoute = require('./routes/task');
const overlayRoute = require('./routes/overlay');
const gitRoute = require('./routes/git');
const judgeRoute = require('./routes/judge');
const labelRoute = require('./routes/label');
const analyticsRoute = require('./routes/analytics');
const onboardRoute = require('./routes/onboard');
const sessionRoute = require('./routes/session');
const execRoute = require('./routes/exec');
const uiRoute = require('./routes/ui');

// ctx: live access to daemon state + helpers. State fields use getters so reassignment
// (state = {...} at /reset; state.workspace = ... at /workspace) is always visible.
const ctx = {
  get state() { return state; },
  setState(s) { state = s; },
  setWorkspace(p, transcript) {
    state.workspace = p;
    state.overlay = overlayStore.load(p);
    migrateBlindEdges(p, state.overlay);
    state.graphStore = graphStore.open(require('path').join(p, '.graph'));
    graphStore.initGitAttributes(p);
    if (transcript) state.mainTranscript = transcript;
    try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(WS_FILE, p); } catch { /* best effort */ }
  },
  send, sendOp, readBody, notifyChange, buildGraph, targetOverlay, resolveRepo,
  validateMetricSpec, validateBenchmark,
  overlayStore, nt, git, measure, graphStore, analytics, analyticsState, analyticsFlush,
  cache, loops, saveLoops, saveAgents,
  get bootState() { return bootState; },
  GIT_HEAD, BOOTED_AT, FEATURES, PUBLIC, BASE, MCP_CALL,
  sseClients, agentsArr,
  taskTranscript, usageCached, harnessTranscriptForTask,
  staleClaimKeys, releaseClaim, sweepStaleClaims, sweepStaleLoops,
  snapshotNative, now, isTruthy,
  embed, cosine, embedStatus, DIMS, EMBED_MODEL,
  gateTask, haikusGate,
  scoreMatches, scoreMatchesSemantic, scoreNodeAgainstTokens, suggestToks,
  SUGGEST_DUP_THRESHOLD, DEFAULT_AUTOWIRE_THRESHOLD, SEMANTIC_AUTOWIRE_THRESHOLD,
  autowireNewTask, autowireNoteProvider, noteRagCandidates, RAG_RECALL_THRESHOLD,
  noteCurrentAsOf, gatedSearchCounts, checkGatedRateLimit,
  knowledgeText, digestRejected, leanLearnings,
  respCacheGet, respCachePut, frontier,
  followups, verdicts, stopSignalFor,
  opReplay,
  ALL_STATUSES, ESCALATION_DEFAULTS, OPTIMIZE_DEFAULTS, LOOP_CONFIG_KEYS, CATCHALL_ESCALATE_TOKENS,
  newLoop, decideAll,
  MAX_ROUTES,
};
const routeModules = [
  metaRoute(ctx), graphRoute(ctx), taskRoute(ctx), overlayRoute(ctx),
  gitRoute(ctx), judgeRoute(ctx), labelRoute(ctx), analyticsRoute(ctx), onboardRoute(ctx),
  sessionRoute(ctx), execRoute(ctx), uiRoute(ctx),
];

// Paths served even while the daemon is still in the loading phase.
// Writes rely on 503 + client retry + op_id idempotency — no queueing needed.
const LOADING_WHITELIST = new Set(['/health', '/version', '/ping', '/', '/graph']);

const handler = async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname, m = req.method;
  try {
    // 503 loading gate: hold non-whitelisted traffic until boot completes.
    if (bootState.phase !== 'ready' && !LOADING_WHITELIST.has(p)) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      return res.end(JSON.stringify({ ok: false, phase: bootState.phase, step: bootState.step, progress: bootState.progress }));
    }

    // Auth gate: /mcp + destructive/write endpoints require the token (when one is configured).
    // Default-deny for writes, workspace-targeting, and agent/file-read endpoints (review H1).
    // Public reads of the CURRENT workspace + the dashboard stay open; any ?workspace= read is gated too.
    const protectedPath = p === '/mcp' || p === '/reset' || p.startsWith('/overlay/') || p === '/loop/start' || p === '/loop/stop'
      || p === '/workspace' || p === '/peek' || p === '/config' || p === '/route' || p.startsWith('/agent/') || p.startsWith('/git/')
      || p.startsWith('/guidance') || p === '/supersede' || p === '/judge/verdict' || p === '/analytics/tool-call';
    if ((protectedPath || u.searchParams.has('workspace')) && m !== 'OPTIONS' && !authed(req, u)) return send(res, 401, { error: 'unauthorized: bearer token required' });

    // Route modules handle all extracted endpoint groups.
    for (const route of routeModules) { if (await route(p, m, req, res, u, null)) return; }

    return send(res, 404, { error: 'not found', path: p });
  } catch (e) {
    return send(res, 500, { error: String((e && e.stack) || e) });
  }
};
// Compaction guard: git WORKTREE checkouts (under worktrees/, used for attempt branches) also run
// daemons and also carry a tracked .graph — independent compaction there guarantees merge
// conflicts when the attempt branch lands. Mechanical predicate: in a worktree `.git` is a FILE
// (a gitdir pointer); in the primary checkout it's a DIRECTORY. `root` defaults to the daemon's
// own source dir (__dirname) — the repo this process was started from. A missing .git (not a
// checkout at all) counts as primary: there is no merge story, and that instance is the only
// one that could ever compact its stores.
function isPrimaryCheckout(root = __dirname) {
  try { return !fs.statSync(path.join(root, '.git')).isFile(); } catch { return true; }
}

// Export pure helpers for unit tests (no port binding). When run as the main module the daemon
// still starts its listeners below; when require()d (tests) it just exposes the functions.
module.exports = { taskTokens, taskTranscript, harnessTranscriptForTask, digestRejected, leanLearnings, isTruthy, scoreMatches, scoreMatchesSemantic, scoreNodeAgainstTokens, noteCurrentAsOf, suggestToks, autowireNewTask, autowireNoteProvider, noteRagCandidates, RAG_RECALL_THRESHOLD, DEFAULT_AUTOWIRE_THRESHOLD, SEMANTIC_AUTOWIRE_THRESHOLD, staleClaimKeys, staleVerdictKeys, migrateBlindEdges,
  isPrimaryCheckout, respCacheGet, respCachePut, notifyChange, RESP_TTL,
  // test hooks (no server side effects): drive a single loop's per-tick decision in isolation.
  decideOne, __setOverlayForTest: (o) => { state.overlay = o; } };

if (require.main === module) {
  // Log unhandled promise rejections instead of crashing (Node's default is to exit the process).
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`unhandledRejection: ${(err && err.stack) || err}\n`);
  });

  const server = http.createServer(handler);

  const PORT_BASE = PORT;
  const MAX_PORT_ATTEMPTS = 10;

  function writeDaemonPort(port) {
    if (!state.workspace) return; // workspace not yet set; skip (clients fall back to default)
    const graphDir = path.join(state.workspace, '.graph');
    try { fs.mkdirSync(graphDir, { recursive: true }); } catch { /* exists */ }
    fs.writeFileSync(path.join(graphDir, 'daemon.port'), String(port));
  }

  function removeDaemonPort() {
    if (!state.workspace) return;
    try { fs.unlinkSync(path.join(state.workspace, '.graph', 'daemon.port')); } catch { /* already gone */ }
  }

  let httpsServer = null; // assigned in the listen callback when certs exist; closed on signal

  process.on('exit', removeDaemonPort); // 'exit' must stay synchronous — port cleanup only
  // SIGINT/SIGTERM: release BOTH listening ports at SIGNAL time, not exit time. server.close()
  // alone waits for open connections — and SSE clients hold theirs indefinitely, so exit rode the
  // 5s force-timer while the (previously never-closed) HTTPS listener kept 8788 bound; a relaunch
  // in that window crashed EADDRINUSE (observed twice 2026-06-12). closeAllConnections() drops
  // SSE/keep-alive sockets so a successor can bind within ~1s of the signal.
  ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
    removeDaemonPort();
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (httpsServer) {
      try { httpsServer.close(); if (typeof httpsServer.closeAllConnections === 'function') httpsServer.closeAllConnections(); } catch { /* already down */ }
    }
    setTimeout(() => process.exit(0), 5000).unref();
  }));

  function tryListen(port, attemptsLeft) {
    if (attemptsLeft === 0) {
      process.stderr.write(`orchestrator: all ports ${PORT_BASE}-${PORT_BASE + MAX_PORT_ATTEMPTS - 1} in use — set ORCH_PORT to an available port\n`);
      process.exit(1);
    }
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (port === PORT_BASE) {
          // Check if the existing process is already a zonoid daemon.
          http.get(`http://127.0.0.1:${port}/ping`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              try {
                const json = JSON.parse(body);
                if (json && json.ok) {
                  process.stdout.write(`Daemon already running at port ${port}\n`);
                  process.exit(0);
                }
              } catch { /* fall through */ }
              process.stderr.write(`Port ${port} is in use by another process. Set ORCH_PORT=<n> to use a different port.\n`);
              process.exit(1);
            });
          }).on('error', () => {
            // Port busy but no daemon answering /ping: most likely a dying predecessor draining
            // in-flight requests. Retry the SAME port briefly instead of giving up (restart race).
            if ((tryListen._samePortRetries = (tryListen._samePortRetries || 0) + 1) <= 30) {
              process.stdout.write(`port ${port} busy (predecessor draining?) — retrying in 500ms (${tryListen._samePortRetries}/30)\n`);
              setTimeout(() => tryListen(port, attemptsLeft), 500);
              return;
            }
            process.stderr.write(`Port ${port} is in use by another process. Set ORCH_PORT=<n> to use a different port.\n`);
            process.exit(1);
          });
        } else {
          tryListen(port + 1, attemptsLeft - 1);
        }
      } else {
        throw err;
      }
    });
    server.listen(port, '127.0.0.1', () => {
      process.stdout.write(`orchestrator daemon on http://127.0.0.1:${port}\n`);

      // BIND-EARLY: the port is now held; load state asynchronously so /health (whitelisted
      // through the 503 gate) reports boot progress while everything else gets an honest 503.
      // writeDaemonPort needs state.workspace, so it runs after loadState resolves.
      loadState().then(() => writeDaemonPort(port))
        .catch((e) => { process.stderr.write(`loadState failed: ${(e && e.stack) || e}\n`); process.exit(1); });

      // Optional HTTPS listener for the custom-connector path (needs a locally-trusted cert — run
      // scripts/setup-https.sh, which uses mkcert). Off unless cert + key exist. Then connect a
      // custom connector to https://localhost:<ORCH_HTTPS_PORT>/mcp .
      const HTTPS_PORT = process.env.ORCH_HTTPS_PORT ? Number(process.env.ORCH_HTTPS_PORT) : 8788;
      const CERT = process.env.ORCH_TLS_CERT || path.join(BASE, 'certs', 'cert.pem');
      const KEY = process.env.ORCH_TLS_KEY || path.join(BASE, 'certs', 'key.pem');
      try {
        if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
          httpsServer = require('https').createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler);
          // Retry EADDRINUSE on the HTTPS port: a restarting predecessor can hold it for a few
          // seconds while its in-flight requests drain. An unhandled 'error' here crashed the whole
          // relaunch (observed twice 2026-06-12); retry instead, give up (HTTPS only) after ~15s.
          let httpsAttempts = 30;
          httpsServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && --httpsAttempts > 0) {
              setTimeout(() => httpsServer.listen(HTTPS_PORT, '127.0.0.1'), 500);
            } else {
              process.stderr.write(`HTTPS listener skipped: ${err.message}\n`);
              httpsServer = null;
            }
          });
          httpsServer.listen(HTTPS_PORT, '127.0.0.1', () => process.stdout.write(`orchestrator HTTPS on https://127.0.0.1:${HTTPS_PORT}\n`));
        }
      } catch (e) { process.stderr.write(`HTTPS listener skipped: ${e.message}\n`); }
    });
  }

  tryListen(PORT_BASE, MAX_PORT_ATTEMPTS);

  // Periodic liveness sweep: reclaim zombie loops even when NO driver is polling next_action (a loop
  // bound to a closed conversation is otherwise never re-evaluated). decideAll already sweeps on each
  // heartbeat; this catches the un-driven case. Cheap; unref'd so it never holds the process open.
  setInterval(() => { try { sweepStaleLoops(); } catch { /* best effort */ } }, 60000).unref();

  // Periodic claim sweep: release orphaned in_progress claims when no route (buildGraph) is being
  // called — catches the case after a Claude app restart where the user hasn't issued any command
  // yet but old agent claims are blocking work. Matches the loop-sweep cadence (60s).
  setInterval(() => { try { sweepStaleClaims(); } catch { /* best effort */ } }, 60000).unref();
  setInterval(() => { try { sweepStaleAgents(); } catch { /* best effort */ } }, 60000).unref();

  // Periodic orphan-note self-heal: re-wire note nodes that are still orphaned as the graph grows
  // (a zero-match note at creation can gain a real neighbor later). Re-check is side-effect-free —
  // no match ⇒ no edge, no write. Cheap; unref'd so it never holds the process open.
  setInterval(() => { try { sweepOrphanNotes(); } catch { /* best effort */ } }, 300000).unref();

  // Heartbeat to MiniLM sidecar every 60s so the sidecar knows the daemon is alive.
  // The sidecar exits if it misses 2 consecutive pings (2 min), keeping its lifecycle
  // tied to the daemon without requiring a clean shutdown signal.
  setInterval(() => { embedPing().catch(() => {}); }, 60000).unref();

  // Graph-store compaction: fold terminal-status nodes' JSONL event files into checkpoint.json
  // so .graph/ stops growing without bound. Covers every workspace store this process has
  // loaded (graphStore.forWorkspace registry) plus the primary store, deduped by dir. One pass
  // ~5 min after boot, then daily. Cheap; unref'd so it never holds the process open.
  function compactGraphStores() {
    const stores = new Map();
    if (state.graphStore) stores.set(state.graphStore.dir, state.graphStore);
    for (const s of graphStore.allStores()) stores.set(s.dir, s);
    for (const s of stores.values()) {
      try {
        const r = graphStore.compact(s);
        if (r.compacted) process.stdout.write(`graph compaction: folded ${r.compacted} node file(s) into ${s.checkpointFile}\n`);
      } catch { /* best effort — never break the daemon on a bad store */ }
    }
  }
  // Only the PRIMARY checkout compacts: worktree daemons (attempt branches) share tracked .graph
  // history with main, and compacting it independently guarantees merge conflicts later.
  if (isPrimaryCheckout()) {
    setTimeout(() => { try { compactGraphStores(); } catch { /* best effort */ } }, 300000).unref();
    setInterval(() => { try { compactGraphStores(); } catch { /* best effort */ } }, 86400000).unref();
  } else {
    process.stdout.write('graph compaction: skipped — not the primary checkout (.git is a worktree gitdir pointer)\n');
  }
}
