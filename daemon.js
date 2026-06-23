#!/usr/bin/env node
// Orchestrator daemon: serves a per-WORKSPACE task graph built ON TOP of native Claude
// Code tasks (read live, source of truth) plus our overlay (cross-session edges, richer
// status, notes). Supports GHOST edges: a dependency whose provider lives in another
// workspace, resolved on demand. Also holds router decisions + subagent activity.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { hasHeadlessDrainAncestor } = require('./lib/headless-ancestor');
if (require.main === module && fs.existsSync(path.join(__dirname, '.orch-off'))) process.exit(0);
if (require.main === module && hasHeadlessDrainAncestor()) process.exit(0);
const crypto = require('crypto');
const { URL } = require('url');
const harnessRegistry = require('./lib/harness');
const { isStandingHarnessTask } = require('./lib/harness-task');
const claudeHarness = harnessRegistry.get('claude');
const filedrop = require('./lib/filedrop-tasks');
const filedropGc = require('./lib/filedrop-gc');
const overlayStore = require('./lib/overlay');
const embeddingStore = require('./lib/embedding-store');
const mcpCore = require('./lib/mcp-core');
const git = require('./lib/git');
const measure = require('./lib/measure');
const optimize = require('./lib/optimize');
const {
  embed,
  embedBatch,
  embedWithMeta,
  cosine,
  nodeVecs,
  maxCosine,
  embedStatus,
  ping: embedPing,
  embeddingMeta,
  vectorMatchesMeta,
  DIMS,
  MODEL: EMBED_MODEL,
} = require('./lib/embed');
const { rerank } = require('./lib/rerank');
const { haikusGate } = require('./lib/embed-haiku');
const judge = require('./lib/judge');
const delta = require('./lib/delta');
const followups = require('./lib/followups');
const verdicts = require('./lib/verdicts');
const { gateTask, contentTokens, classifyNoteType, noteText } = require('./lib/context-gate');
const usageAccounting = require('./lib/usage-accounting');
const { runUsageReconcile } = require('./lib/usage-reconcile');
const frontier = require('./lib/frontier');
const analytics = require('./lib/analytics');
const graphStore = require('./lib/graph-store');
const sessionBindings = require('./lib/session-bindings');
const { taskEmbedText } = require('./lib/node-tags');
const headlessDrain = require('./lib/headless-drain');
const registry = require('./lib/workspace-registry');
const runtimePaths = require('./lib/runtime-paths');
const { ensureManagedGraphLoop } = require('./lib/loop-autostart');

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROUTES = 50;
const BASE = runtimePaths.resolveDataDir();
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
// state. The harness task watch below covers native task-file writes that bypass the daemon.
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

// --- per-workspace overlay cache (P3: the ONLY overlay store — no global default) ------------
// Every workspace gets a cached, write-coalesced overlay via overlayFor(ws), keyed by absolute
// path. Separate Map entries per workspace ⇒ concurrent writes to different workspaces mutate
// independent objects and never clobber each other. After P3 there is no special "current"
// workspace: the Map IS the authoritative in-memory store for ALL workspaces (the global
// state.overlay alias is gone).
//
// CACHE COHERENCY: cache entries are mtime-stamped on the overlay file (reusing overlayStamp). A
// lookup that finds the file mtime CHANGED reloads + recaches — so an out-of-band write (another
// process / a test calling overlayStore.save directly) is picked up on the next lookup. This is the
// SAME staleness guard already used by respCache. After the daemon's own write through a cached
// overlay, callers should call refreshOverlayStamp(ws) so the just-saved content isn't needlessly
// reloaded next lookup (write-coalescing); targetOverlay's save() does this. A missed refresh only
// costs a redundant reload of identical content — never incorrect.
const overlayCache = new Map();   // ws -> { ov, stamp }
// Test-only fallback holder. Production code NEVER reads these — every route/sweep resolves an
// explicit workspace and 400s when it can't. But legacy unit tests drive decideOne with a bare ctx
// (no ctx.ws) after calling __setOverlayForTest(o) / __setWorkspaceForTest(w); those hooks record
// here AND seed the Map (so overlayFor(testWs) === the test overlay), and decideOne's bare-ctx path
// falls back to them. This is NOT a daemon-global default — it is inert outside the test hooks.
let __testWs = null;
let __testOv = null;
function overlayFor(ws) {
  // Test-only alias: when a unit test pinned (__testWs, __testOv) via the __*ForTest hooks, return
  // that exact in-memory overlay for the pinned ws (mirrors how state.overlay used to alias the
  // current workspace) so the test's authoritative object is honored across cache clears. __testWs
  // is null in production, so this branch is inert outside tests.
  if (__testWs !== null && ws === __testWs && __testOv) return __testOv;
  const cached = overlayCache.get(ws);
  if (cached && cached.stamp === overlayStamp(ws)) return cached.ov;
  const ov = overlayStore.load(ws);
  overlayCache.set(ws, { ov, stamp: overlayStamp(ws) });
  return ov;
}
// Re-stamp a cached overlay AFTER the daemon saved through it, so the next overlayFor lookup keeps
// the in-memory (coalesced) object instead of treating the daemon's own mtime bump as an
// out-of-band change and reloading. Idempotent; no-op when the ws isn't cached.
function refreshOverlayStamp(ws, ov) {
  const cached = overlayCache.get(ws);
  if (cached) {
    if (ov) cached.ov = ov;
    cached.stamp = overlayStamp(ws);
  }
}
function aggregateCached(ws) {
  const now = Date.now();
  if (cache.agg.has(ws) && now - (cache.aggAt.get(ws) || 0) < AGG_TTL) return cache.agg.get(ws);
  // Pass the overlay's terminal-status snapshots so tasks whose native files were garbage-
  // collected by the cleanupPeriodDays retention sweep still appear in the aggregate.
  const ov = overlayFor(ws);
  let v = claudeHarness.tasks.aggregateWorkspace(ws, ov.snapshots);
  // Union in file-drop stub tasks (designated-folder minting, '<harness>/<id>' keys — see
  // lib/filedrop-tasks.js). Same union point native tasks enter through, so stub tasks flow
  // through overlay status, claims, dependencies, frontier and dashboard identically. A live
  // stub REPLACES any same-key entry the snapshot fallback may have served (stub files are
  // durable and authoritative for their namespace). No stubs ⇒ `v` passes through untouched.
  const fd = filedrop.aggregateWorkspace(ws);
  if (fd.length) {
    const fdKeys = new Set(fd.map((t) => t.key));
    v = v.filter((t) => !fdKeys.has(t.key)).concat(fd);
  }
  cache.agg.set(ws, v); cache.aggAt.set(ws, now);
  return v;
}

// (P3) The Phase-1 workspace-fallback observability seam (warnWorkspaceFallback) has been REMOVED:
// it instrumented the silent fall-through to the daemon-global pointer, and that pointer no longer
// exists — every seam that used to fall through now either receives an explicit workspace or 400s.

// Status write-through router: file-drop stub keys update the stub file's own `status` field
// (atomic rewrite — filedrop.writeStatus returns false when no stub exists for the key, which
// is the ownership test); everything else goes to the active harness adapter (Claude native
// write-through, which itself no-ops gracefully on unknown/missing keys). Best-effort like both
// delegates. Every daemon write-through goes via this so '<harness>/<id>' namespaces never leak
// into ~/.claude/tasks and Claude '<session>/<id>' keys never touch the stub folders.
function readNativeTask(ws, key) {
  const stub = filedrop.readTask(ws, String(key));
  if (stub) return stub;
  return harnessRegistry.route(key).tasks.readTask(String(key));
}

function writeTaskStatus(ws, key, status) {
  if (filedrop.writeStatus(ws, String(key), status)) return true;
  return harnessRegistry.route(key).tasks.writeStatus(String(key), status);
}

// Adopt a native or file-drop task stub at first sight: copy id/title/blockedBy into the overlay
// so the graph node is authoritative from that moment. Idempotent when already adopted.
//
// INVARIANT — native-blockedBy edges are structural intent, not semantic candidates:
//   addEdge(kind:'blocking', origin:'native-blockedBy') → bypasses judge queue entirely.
//   isUnverifiedEdge() in judge.js requires kind==='context' && judged===false — blocking edges
//   are NEVER queued for re-adjudication regardless of any other field. addEdge dedupes so
//   re-adoption of the same key is a no-op at the edge layer.
function adoptNativeTask(ov, key, ws) {
  if (ov.snapshots && ov.snapshots[key]) return false;
  const k = String(key);
  const fd = filedrop.readTask(ws, k);
  if (fd) {
    const parts = filedrop.splitKey(k);
    const deps = filedrop.normalizeDeps(parts ? parts.harness : '', fd.blockedBy);
    overlayStore.setSnapshot(ov, k, {
      subject: fd.subject || String(fd.id),
      description: fd.description || '',
      status: fd.status || 'pending',
      blockedBy: deps,
      owner: fd.owner ?? null,
      metadata: fd.metadata ?? null,
    });
    // Wire blockedBy as overlay blocking edges: structural intent, never re-adjudicated by judge.
    for (const dep of deps) overlayStore.addEdge(ov, dep, k, null, 'blocking', null, { origin: 'native-blockedBy' });
    return true;
  }
  const t = harnessRegistry.route(key).tasks.readTask(k);
  if (!t) return false;
  // Normalize blockedBy: bare ids get the session prefix so overlay edges reference full keys.
  // key is "${session}/${id}" — extract the session for normalization.
  const session = k.includes('/') ? k.slice(0, k.indexOf('/')) : '';
  const deps = filedrop.normalizeDeps(session, t.blockedBy);
  overlayStore.setSnapshot(ov, key, {
    subject: t.subject || t.activeForm || String(t.id),
    description: t.description || '',
    status: t.status || 'pending',
    blockedBy: deps,
    owner: t.owner ?? null,
    metadata: t.metadata ?? null,
  });
  // Wire blockedBy as overlay blocking edges: structural intent, never re-adjudicated by judge.
  for (const dep of deps) overlayStore.addEdge(ov, dep, k, null, 'blocking', null, { origin: 'native-blockedBy' });
  return true;
}

// Terminal-status snapshot — back-compat ONLY for tasks seen before adopt-on-first-sight (no
// adoption snapshot yet). Adopted tasks update status on the existing snapshot only.
// `nativeStatus` (optional): the status the write-through is about to stamp on the native file.
function snapshotNative(ov, key, nativeStatus, ws) {
  const k = String(key);
  const t = readNativeTask(ws, k);
  if (!t) return;
  const existing = ov.snapshots && ov.snapshots[k];
  if (existing) {
    overlayStore.setSnapshot(ov, k, { ...existing, status: nativeStatus || t.status });
    return;
  }
  const parts = filedrop.splitKey(k);
  overlayStore.setSnapshot(ov, k, {
    subject: t.subject,
    description: t.description,
    status: nativeStatus || t.status,
    blockedBy: parts ? filedrop.normalizeDeps(parts.harness, t.blockedBy) : (t.blockedBy || []),
    owner: t.owner ?? null,
    metadata: t.metadata ?? null,
  });
}
function usageCached(p) {
  const now = Date.now();
  if (cache.usage.has(p) && now - (cache.usageAt.get(p) || 0) < USAGE_TTL) return cache.usage.get(p);
  const v = usageAccounting.parseTranscriptUsage(p);
  cache.usage.set(p, v); cache.usageAt.set(p, now);
  return v;
}
claudeHarness.tasks.watch(() => { cache.agg.clear(); cache.aggAt.clear(); respCache.clear(); }); // Claude native task dir
// filedrop.watch below covers designated-folder stubs
filedrop.watch(() => { cache.agg.clear(); cache.aggAt.clear(); respCache.clear(); });      // designated-folder stub drops surface without /sync

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

// P3: the daemon-global workspace/overlay default is GONE. There is no `state.workspace` /
// `state.overlay` anymore — every op carries an explicit workspace (POST body `workspace` or
// GET ?workspace=), resolved per-request, and a missing one is a hard 400. `state` now holds only
// the genuinely process-global registries: per-session bindings, agent records, routes.
let state = { routes: [], agents: {}, sessions: {} };
// The workspace REGISTRY (not a global default pointer): every bind / POST /workspace appends the
// path here so the maintenance sweeps + loop tick (registeredWorkspaces()) and the dashboard
// switcher know which workspaces exist. This is NOT the removed global-default pointer.
const WORKSPACES_FILE = path.join(BASE, 'workspaces.json');
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

// The REAL set of workspaces the daemon knows about — the registry persisted by setWorkspace
// (every bind / POST /workspace appends to workspaces.json). This is the authoritative enumeration
// the maintenance sweeps + loop tick iterate over, REPLACING reliance on the single daemon-global
// state.workspace pointer (Phase 2b of deprecating the global default). We UNION in any active-loop
// workspaces defensively (a loop pinned to a ws that somehow never hit setWorkspace still gets
// swept) — but the registry, not state.workspace, is the source of truth. Pure read; best-effort
// (a missing/garbage registry yields the active-loop set alone, never throws).
function registeredWorkspaces() {
  const set = new Set();
  try {
    // v2 registry: flatten every member repo across all named workspaces into a flat list of repo
    // PATHS. This MUST stay a Set<repoPath> — ≈10 sweep/claim callers iterate repo paths (never
    // workspace NAMES); leaking names would break every maintenance sweep + the gate claim scan.
    // loadRegistry lazily migrates a legacy v1 flat array in place; allRepos de-dupes.
    for (const p of registry.allRepos(registry.loadRegistry(WORKSPACES_FILE))) { if (p) set.add(p); }
  } catch { /* no registry yet / unreadable — fall through to active-loop set */ }
  // Defensive union: a loop pinned to a workspace that isn't (yet) in the registry still needs sweeping.
  for (const L of loops.values()) { if (L.active && L.workspace) set.add(L.workspace); }
  return set;
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
// Claim-sweep staleness default (minutes). Raised from 10 → 60 to ALIGN with the 1h git worktree
// lease (lib/git.js LEASE_STALE_MS = 3600000): a worker holding a registered attempt worktree owns
// its lease for an hour, so reaping its claim at 10min spuriously released LIVE long-running workers
// — and a late completion from the reaped worker then failed to ready its blocked_by judge
// (note-mqq1rh9jnxp). 60min lets a legitimately slow worker finish; genuinely-orphaned/dead claims
// still recover (the worktree-commit vouch below + the wall-clock cutoff both still fire). Override
// per-process with ORCH_STALE_MINUTES or per-workspace with config.stale_minutes (?? honors an
// explicit 0). The manual force sweep (/sweep stale_minutes=1) is unaffected — it passes its own window.
const STALE_MINUTES_DEFAULT = (() => {
  const v = Number(process.env.ORCH_STALE_MINUTES);
  return Number.isFinite(v) && v >= 0 ? v : 60;
})();
// /version build identity (frozen at boot): the git HEAD this RUNNING process was started from.
// After a deploy, /version.head ≠ `git rev-parse HEAD` on disk ⇒ "restart required" — the check
// hooks/restart-daemon.sh asserts. null when the source dir isn't a git checkout.
let GIT_HEAD = null;
try { GIT_HEAD = require('child_process').execFileSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim(); } catch { /* not a checkout */ }
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
let requestHeadlessDrainWake = null;
// notifyChange(ws?): push a 'changed' event to connected dashboards on every mutation.
// When `ws` is given, emits `data: changed:<ws>\n\n` so workspace-specific clients can skip
// refetches that don't affect their selected workspace. Bare call (no ws) emits the legacy
// `data: changed\n\n` payload and always triggers a refetch on all clients (back-compat).
function notifyChange(ws) {
  respCache.clear();
  const payload = ws ? `data: changed:${ws}\n\n` : 'data: changed\n\n';
  for (const r of sseClients) { try { r.write(payload); } catch { sseClients.delete(r); } }
  if (requestHeadlessDrainWake) {
    try { requestHeadlessDrainWake('graph-change'); } catch { /* best effort */ }
  }
}

// Heartbeat loop: the daemon is the decider. The agent polls next_action on a schedule; the
// daemon replies spawn/idle/stop + how long to wait before checking again (adaptive backoff),
// and enforces hard caps so token burn can't run away. Persisted to disk so a daemon restart
// resumes the budget/iteration count mid-run.
// Keyed REGISTRY of heartbeat loops (was a singleton `loop`). Each entry is independent — its own
// budget/iterations/session/config — and ONE heartbeat (decideAll) advances them all. Keyed by a UUID
// loopId so /loop/start can INSERT (never clobber) and multiple driving conversations can coexist.
const LOOP_CONFIG_KEYS = ['tokenBudget', 'maxIterations', 'minPoll', 'maxPoll', 'estPerTick', 'batch', 'maxConcurrency', 'judgeParallelCap'];
const STALE_PROGRESS_MIN_DEFAULT = 30;   // a loop with no progress past this many minutes is swept to inactive
const GC_LOOP_RETAIN_MS = 60 * 60 * 1000;   // prune inactive loop entries idle longer than this (registry-leak guard, task /3)
function newLoop(over) {
  return { id: null, active: false, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null,
    session: null, lastProgress: null, workspace: null, managed: null,
    config: { tokenBudget: 5000000, maxIterations: 6250, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8, maxConcurrency: 10, judgeParallelCap: 6 },
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
  // Phase 1: workspace registry warm-up. P3 removed the daemon-global default pointer, so there is
  // NO single workspace to restore on boot. Instead we lazily warm every REGISTERED workspace's
  // overlay into the per-workspace cache (and run the one-time blind-edge migration on each), so the
  // maintenance sweeps / loop tick have a hot overlay without a global. Best-effort per workspace —
  // a missing/garbage registry simply warms nothing.
  advanceBoot('workspace');
  await yieldLoop();
  for (const ws of registeredWorkspaces()) {
    try {
      const ov = overlayFor(ws);
      migrateBlindEdges(ws, ov);
      graphStore.open(path.join(ws, '.graph'));
      graphStore.initGitAttributes(ws);
    } catch { /* skip an unreadable/relocated workspace */ }
  }

  // Phase 2: agent records restore
  advanceBoot('agents');
  await yieldLoop();
  try { const a = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); if (a && typeof a === 'object') state.agents = a; } catch { /* none yet */ }

  // Phase 3: loop registry restore
  advanceBoot('loops');
  await yieldLoop();
  restoreLoops();
  try { ensureManagedGraphLoops(); } catch (e) { process.stderr.write(`managed graph loop ensure failed: ${e.message}\n`); }

  // Fully operational
  advanceBoot('ready');
  // Daemon-restart acknowledgement, per registered workspace (no global current workspace anymore).
  try {
    const followups = require('./lib/followups');
    for (const ws of registeredWorkspaces()) {
      try {
        const ov = overlayFor(ws);
        const ack = followups.acknowledgeDaemonRestartOnBoot(ov, { bootedAt: BOOTED_AT });
        if (ack) {
          overlayStore.save(ws, ov); refreshOverlayStamp(ws);
          notifyChange();
          process.stdout.write(`orchestrator: acknowledged restart bucket ${ack.key} (${ws})\n`);
        }
      } catch (e) { process.stderr.write(`restart-bucket boot ack failed (${ws}): ${e.message}\n`); }
    }
  } catch (e) { process.stderr.write(`restart-bucket boot ack failed: ${e.message}\n`); }
  process.stdout.write(`orchestrator boot complete (phase:ready)\n`);
}
function saveLoops() { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(LOOPS_FILE, JSON.stringify(Object.fromEntries(loops))); } catch { /* best effort */ } }
function saveAgents() { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(AGENTS_FILE, JSON.stringify(state.agents)); } catch { /* best effort */ } }

// touchAgent: register or heartbeat-stamp an agent in the global registry. Idempotent with
// /agent/start (SubagentStart hook) — safe to call from both paths. Unknown agents get
// state:'running', startedAt/lastSeen now (start_task auto-register for hookless harnesses).
// When patch.status is set (/overlay/status), apply the same running/done transitions as before.
function touchAgent(agentId, patch = {}) {
  if (!agentId || typeof agentId !== 'string') return;
  const prev = state.agents[agentId] || {};
  const ts = now();
  const st = patch.status;
  let stateVal = prev.state || 'running';
  let endedAt = prev.endedAt ?? null;
  if (patch.state) { stateVal = patch.state; endedAt = patch.state === 'running' ? null : (patch.endedAt ?? endedAt ?? ts); }
  else if (st === 'in_progress') { stateVal = 'running'; endedAt = null; }
  else if (st && ['done', 'tested', 'failed', 'canceled'].includes(st)) { stateVal = 'done'; endedAt = ts; }
  else if (!prev.agent_id) { stateVal = 'running'; endedAt = null; }
  let subagentSession = patch.subagent_session !== undefined ? patch.subagent_session : (prev.subagent_session ?? null);
  const sessionVal = patch.session !== undefined ? patch.session : (prev.session ?? null);
  if (subagentSession && sessionVal && subagentSession === sessionVal) subagentSession = null;
  state.agents[agentId] = {
    agent_id: agentId,
    agent_type: patch.agent_type || prev.agent_type || 'agent',
    state: stateVal,
    transcript_path: patch.transcript_path !== undefined ? patch.transcript_path : (prev.transcript_path ?? null),
    task: patch.task !== undefined ? patch.task : (patch.task_key !== undefined ? patch.task_key : (prev.task ?? null)),
    session: patch.session !== undefined ? patch.session : (prev.session ?? null),
    subagent_session: subagentSession,
    workspace: patch.workspace !== undefined ? patch.workspace : (prev.workspace ?? null),
    startedAt: prev.startedAt || ts,
    lastSeen: ts,
    endedAt,
    reported_usage: patch.reported_usage !== undefined ? patch.reported_usage : (prev.reported_usage ?? null),
    usage_baseline: patch.usage_baseline !== undefined ? patch.usage_baseline : (prev.usage_baseline ?? null),
    agent_tool_spawn: patch.agent_tool_spawn !== undefined ? patch.agent_tool_spawn : (prev.agent_tool_spawn ?? null),
    judged_node: patch.judged_node !== undefined ? patch.judged_node : (prev.judged_node ?? null),
  };
  saveAgents();
}

// Resolve the TARGET git repo for a task's git op. Precedence:
//   explicit (request body repo_path) > task's overlay repo field > the resolved workspace `ws`.
// Lets the loop branch/merge/measure on a repo distinct from the workspace. `ws` is the
// per-request resolved workspace (no global default — callers pass the resolved value).
function resolveRepo(key, explicit, ov, ws) {
  return explicit || (key && ov && ov.repos && ov.repos[key]) || ws;
}

// Per-request workspace targeting for graph routes. P3: there is NO daemon-global default — the
// target MUST come from the request body's `workspace` or the ?workspace= query. When neither is
// supplied, `ws` is null and the route MUST 400 (`if (!T.ws) return 400 {error:"workspace required"}`)
// rather than defaulting. The overlay is the per-workspace cache entry (overlayFor); save() persists
// to the RESOLVED workspace and re-stamps the cache so the daemon's own write doesn't look
// out-of-band on the next overlayFor (preserves write-coalescing). With a null ws, ov is the EMPTY
// overlay and save() is a no-op — the route should have 400'd before touching it.
function targetOverlay(b, u) {
  const explicit = (b && b.workspace) || (u && u.searchParams.get('workspace')) || null;
  if (!explicit) return { ws: null, ov: overlayStore.EMPTY(), save: () => {} };
  const ws = explicit;
  const ov = overlayFor(ws);
  return { ws, ov, save: () => { overlayStore.save(ws, ov); refreshOverlayStamp(ws, ov); } };
}

function saveDispatchOverlay(ws, ov) {
  if (!ws || !ov) return;
  overlayStore.save(ws, ov);
  refreshOverlayStamp(ws, ov);
  notifyChange(ws);
}

// Reject-unknown-key guard: returns true if the key resolves to an EXISTING node in the
// graph (task OR note node). Used by WRITE ops to reject phantom/bare keys that have no
// corresponding native task or note node — symmetric with the existing READ-op checks in
// /task/detail, /task/suggest, /task/context etc. which already do g.tasks.find() guards.
// NOTE: add_dependency legitimately creates note↔task edges; the note: prefix is handled
// by the caller, which skips the ghost check for keys already in the graph.
function nodeExistsInGraph(g, key) {
  if (!key || !g || !Array.isArray(g.tasks)) return false;
  return g.tasks.some((t) => t.id === key);
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
// `ov` = the overlay holding the claim (REQUIRED — P3 removed the daemon-global default; callers
// pass the target workspace's overlay; the native write-through is workspace-agnostic).
// Continuity for the next claimer rides on `ov.notes[key]` (the reason), surfaced via
// get_task_detail → task.note. Optional `ctx` = { agentId, mins, tokenUsage } drives cost-log
// accounting: when provided, the release event (with any token counts) is appended to the cost log.
// `ws` = the workspace `ov` belongs to — needed to route the status write-through for file-drop
// stub keys (the stub folders are per-workspace).
function releaseClaim(key, reason, ov, ctx = null, ws) {
  if (ov.status[key] !== 'in_progress') return false;
  delete ov.status[key];
  ov.notes[key] = String(reason).slice(0, 280);
  if (ov.snapshots && ov.snapshots[key]) {
    overlayStore.setSnapshot(ov, key, { ...ov.snapshots[key], status: 'pending' });
  }
  // Also revert the native status (start_task wrote it to in_progress via write-through); otherwise
  // the task would still derive as in_progress from its native/stub file. 'pending' = available to retry.
  try { writeTaskStatus(ws, key, 'pending'); } catch { /* best effort */ }
  // Continuity rides on ov.notes[key] (set above) — it surfaces to the next claimer via
  // get_task_detail → task.note, so no separate note node is needed. ctx still drives cost logging.
  if (ctx) {
    const { agentId, mins, tokenUsage } = ctx;
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
// reapAgent: transition an agent's registry record out of 'running' into terminal 'stale' (with an
// endedAt stamp) so /health's summary.agents.running stops counting it. Called in lockstep with a
// releaseClaim that swept the agent's stale claim — the caller has ALREADY selected this key as
// stale (staleClaimKeys / a forced sweep), so it is NOT this helper's job to re-check vouchedLive:
// it only reaps records currently 'running', and is a no-op otherwise (idempotent, and a guard
// against ever flipping a genuinely-live agent the caller didn't select). Returns true if it
// actually reaped (so callers can batch the saveAgents()). Mirrors sweepStaleAgents' transition
// shape ({...a, state, endedAt}) but to 'stale' rather than 'dead' — both non-running, see the note
// in sweepStaleClaims; agents map defaults to the current registry.
function reapAgent(agentId, agents = state.agents) {
  const a = agentId && agents[agentId];
  if (!a || a.state !== 'running') return false;
  agents[agentId] = { ...a, state: 'stale', endedAt: new Date().toISOString() };
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
// worktreeVouchesLive (pure-ish): is this claim backed by a registered attempt worktree whose branch
// has RECENT commits? A hookless background worker (Agent-tool spawn) never fires SubagentStart, so
// vouchedLive can't see it once its agent record ages out — yet if it holds a registered worktree
// (branch_task ran) AND its attempt branch tip was committed within the staleness window, it is
// DEMONSTRABLY still producing work and must NOT be reaped (note-mqq1rh9jnxp: long impl workers were
// spuriously released at 10min, breaking judge-readiness). This is the commit-evidence companion to
// the raised time window. Genuinely-orphaned claims fall through: no worktree, or a branch whose last
// commit is OLDER than the window (the worker died after its last commit) ⇒ not vouched ⇒ reaped by
// the wall-clock cutoff. Best-effort: any git/fs error ⇒ not vouched (fail toward reaping, so a stuck
// claim still recovers). `gitProbe(worktree, args)` is injected for unit-testing; defaults to gitSafe.
function worktreeVouchesLive(overlay, key, mins, nowMs, gitProbe) {
  const rec = overlay.git && overlay.git[key];
  const wt = rec && rec.worktree;
  if (!wt) return false;                                  // no registered worktree → not vouched
  try { if (!fs.existsSync(wt)) return false; } catch { return false; }
  const probe = gitProbe || ((w, args) => git.gitSafe ? git.gitSafe(w, args) : null);
  // Last commit time on the worktree's HEAD (the attempt branch). %ct = committer epoch seconds.
  const ctRaw = probe(wt, ['log', '-1', '--format=%ct']);
  const ct = ctRaw ? Number(String(ctRaw).trim()) : NaN;
  if (!Number.isFinite(ct)) return false;                 // no commits / not a repo → not vouched
  // "recent" = committed within the staleness window. mins===0 ⇒ nothing is recent (honor explicit 0).
  if (mins <= 0) return false;
  return (nowMs - ct * 1000) <= mins * 60000;
}
// staleClaimKeys (pure): which in_progress claims are abandoned orphans — worker not vouched live
// (by agent registry OR by a recently-committed attempt worktree) AND status unchanged for
// stale_minutes (kill / crash / idle / cross-session / daemon restart). Wall-clock based (persisted
// ISO timestamps), so time the daemon spent DOWN counts toward staleness. Parameterized on
// (overlay, agents, nowMs, bootMs) so it is unit-testable; sweepStaleClaims releases them. `gitProbe`
// is an optional git runner injected for tests (defaults to the real git.gitSafe via worktreeVouchesLive).
function staleClaimKeys(overlay, agents, nowMs, bootMs = BOOT_MS, gitProbe) {
  const mins = overlay.config.stale_minutes ?? STALE_MINUTES_DEFAULT;   // ?? not || so an explicit 0 is honored
  const cutoff = nowMs - mins * 60000;
  const out = [];
  for (const [key, st] of Object.entries(overlay.status)) {
    if (st !== 'in_progress') continue;
    const agentId = overlay.assignee[key];
    const agent = agentId ? agents[agentId] : null;
    if (vouchedLive(agent, mins, nowMs, bootMs)) continue;     // live worker (agent registry) — leave it alone
    if (worktreeVouchesLive(overlay, key, mins, nowMs, gitProbe)) continue; // live worker (fresh attempt commits) — leave it alone
    const ts = overlay.timestamps[key];
    if (ts && Date.parse(ts.lastChanged) > cutoff) continue;   // changed recently — give it time
    out.push({ key, status: st, agentId: agentId || null, mins });
  }
  return out;
}

// Adopted snapshots are the fallback source when the original native task file has disappeared.
// A claim release used to clear only overlay.status; if the adopted snapshot still said
// in_progress, the task kept deriving as "ongoing" forever with no agent to reap. Select those
// orphan snapshot claims separately so the sweep can reset their snapshot/native echo to pending.
function staleSnapshotClaimKeys(overlay, agents, nowMs, bootMs = BOOT_MS) {
  const mins = overlay.config.stale_minutes ?? STALE_MINUTES_DEFAULT;   // claim staleness — align with staleClaimKeys
  const cutoff = nowMs - mins * 60000;
  const out = [];
  for (const [key, snap] of Object.entries(overlay.snapshots || {})) {
    if (!snap || snap.status !== 'in_progress') continue;
    if ((overlay.status || {})[key] != null) continue; // normal staleClaimKeys owns explicit overrides
    const agentId = overlay.assignee[key];
    const agent = agentId ? agents[agentId] : null;
    if (vouchedLive(agent, mins, nowMs, bootMs)) continue;
    const ts = overlay.timestamps[key];
    if (ts && Date.parse(ts.lastChanged) > cutoff) continue;
    out.push({ key, status: 'in_progress', agentId: agentId || null, mins });
  }
  return out;
}

function releaseSnapshotClaim(key, reason, ov, ctx = null, ws) {
  const snap = ov.snapshots && ov.snapshots[key];
  if (!snap || snap.status !== 'in_progress') return false;
  overlayStore.setSnapshot(ov, key, { ...snap, status: 'pending' });
  ov.notes[key] = String(reason).slice(0, 280);
  try { writeTaskStatus(ws, key, 'pending'); } catch { /* best effort */ }
  if (ctx) {
    const { agentId, mins, tokenUsage } = ctx;
    try {
      const costLogPath = path.join(__dirname, 'logs', 'cron-token-usage.jsonl');
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        event: 'stale_snapshot_claim_release',
        task: key,
        agent_id: agentId || null,
        stale_mins: mins,
        input_tokens: tokenUsage && tokenUsage.input_tokens || 0,
        output_tokens: tokenUsage && tokenUsage.output_tokens || 0,
        cache_read_tokens: tokenUsage && tokenUsage.cache_read_input_tokens || 0,
        total_tokens: tokenUsage && tokenUsage.total || 0,
      });
      fs.mkdirSync(path.dirname(costLogPath), { recursive: true });
      fs.appendFileSync(costLogPath, entry + '\n');
    } catch { /* best effort */ }
  }
  return true;
}

function staleNativeClaimKeys(overlay, agents, tasks, nowMs, bootMs = BOOT_MS) {
  const mins = overlay.config.stale_minutes ?? STALE_MINUTES_DEFAULT;   // claim staleness — align with staleClaimKeys
  const cutoff = nowMs - mins * 60000;
  const out = [];
  for (const t of tasks || []) {
    if (!t || t.native_status !== 'in_progress') continue;
    const key = t.key;
    if ((overlay.status || {})[key] != null) continue; // explicit overlay claims are handled first
    const agentId = overlay.assignee[key];
    const agent = agentId ? agents[agentId] : null;
    if (vouchedLive(agent, mins, nowMs, bootMs)) continue;
    const ts = overlay.timestamps[key];
    if (ts && Date.parse(ts.lastChanged) > cutoff) continue;
    out.push({ key, status: 'in_progress', agentId: agentId || null, mins });
  }
  return out;
}

function releaseNativeClaim(key, reason, ov, ctx = null, ws) {
  const wrote = writeTaskStatus(ws, key, 'pending');
  const snap = ov.snapshots && ov.snapshots[key];
  if (snap && snap.status === 'in_progress') {
    overlayStore.setSnapshot(ov, key, { ...snap, status: 'pending' });
  }
  if (!wrote && !(snap && snap.status === 'in_progress')) return false;
  ov.notes[key] = String(reason).slice(0, 280);
  if (ctx) {
    const { agentId, mins, tokenUsage } = ctx;
    try {
      const costLogPath = path.join(__dirname, 'logs', 'cron-token-usage.jsonl');
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        event: 'stale_native_claim_release',
        task: key,
        agent_id: agentId || null,
        stale_mins: mins,
        input_tokens: tokenUsage && tokenUsage.input_tokens || 0,
        output_tokens: tokenUsage && tokenUsage.output_tokens || 0,
        cache_read_tokens: tokenUsage && tokenUsage.cache_read_input_tokens || 0,
        total_tokens: tokenUsage && tokenUsage.total || 0,
      });
      fs.mkdirSync(path.dirname(costLogPath), { recursive: true });
      fs.appendFileSync(costLogPath, entry + '\n');
    } catch { /* best effort */ }
  }
  return true;
}

function localInProgressCount(tasks, ov, agents = state.agents, nowMs = Date.now(), bootMs = BOOT_MS) {
  const mins = ov.config.stale_minutes ?? 10;
  let count = 0;
  for (const t of tasks || []) {
    if (!t || t.kind === 'note' || t.status !== 'in_progress') continue;
    const agentId = (ov.assignee && ov.assignee[t.id]) || t.agent_id;
    if (!agentId || !vouchedLive(agents[agentId], mins, nowMs, bootMs)) continue;
    count++;
  }
  return count;
}
// Sweep abandoned claims: release every staleClaimKeys() orphan back to ready. Authoritative
// liveness — survives restart (overlay is persisted) and needs no stop hook. Returns true if any.
// Parameterized on (ws, ov) — REQUIRED (no global default): the sweep operates on the given
// workspace's overlay (buildGraph / the loop tick / the periodic sweep all pass an explicit target).
function sweepStaleClaims(ws, ov) {
  let dirty = false;
  let agentsDirty = false;
  const stWs = { ...state, overlay: ov };
  for (const { key, agentId, mins } of staleClaimKeys(ov, state.agents, Date.now())) {
    // Snapshot token usage BEFORE clearing the claim so we can finalize it in the cost log
    // and include it in the continuity note for the next agent.
    const tp = taskTranscript(key, null, true, stWs);
    const tokenUsage = tp ? usageCached(tp) : null;
    if (releaseClaim(key, `auto-released: worker '${agentId || '?'}' not running (stale >${mins}m)`, ov, { agentId, mins, tokenUsage }, ws)) {
      dirty = true;
      // Reap the owning agent's registry record in lockstep with the claim it held. The claim was
      // released BECAUSE the worker is not vouchedLive (staleClaimKeys), so the 'running' record is
      // a zombie — transition it to a terminal 'stale' state so /health's running count stops
      // counting it. Coupling the reap to the release (not just the independent sweepStaleAgents
      // pass) guarantees the count drops the instant a claim is swept. Same trust basis: we only
      // reach here for keys staleClaimKeys returned, i.e. the agent already failed vouchedLive.
      if (reapAgent(agentId)) agentsDirty = true;
    }
  }
  for (const { key, agentId, mins } of staleSnapshotClaimKeys(ov, state.agents, Date.now())) {
    const tp = taskTranscript(key, null, true, stWs);
    const tokenUsage = tp ? usageCached(tp) : null;
    if (releaseSnapshotClaim(key, `auto-released: orphan in_progress snapshot '${agentId || '?'}' not running (stale >${mins}m)`, ov, { agentId, mins, tokenUsage }, ws)) {
      dirty = true;
      if (reapAgent(agentId)) agentsDirty = true;
    }
  }
  if (agentsDirty) saveAgents();
  if (dirty) { overlayStore.save(ws, ov); notifyChange(); }
  return dirty;
}

function sweepStaleNativeClaims(ws, ov, tasks) {
  let dirty = false;
  let agentsDirty = false;
  const stWs = { ...state, overlay: ov };
  for (const { key, agentId, mins } of staleNativeClaimKeys(ov, state.agents, tasks, Date.now())) {
    const native = (tasks || []).find((t) => t.key === key);
    const tp = taskTranscript(key, native && native.session, true, stWs);
    const tokenUsage = tp ? usageCached(tp) : null;
    if (releaseNativeClaim(key, `auto-released: native in_progress '${agentId || '?'}' not running (stale >${mins}m)`, ov, { agentId, mins, tokenUsage }, ws)) {
      dirty = true;
      if (reapAgent(agentId)) agentsDirty = true;
    }
  }
  if (agentsDirty) saveAgents();
  if (dirty) { overlayStore.save(ws, ov); notifyChange(); }
  return dirty;
}
// Auto-retry failed tasks: flip ALL failed tasks back to ready with a note about the prior attempt.
// Mirrors sweepStaleClaims in structure. Returns true if any task was retried.
function sweepFailedTasks(ws, ov) {
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
    try { writeTaskStatus(ws, t.id, 'pending'); } catch { /* best effort */ }
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
function sweepStaleVerdicts(ws, ov) {
  const stale = staleVerdictKeys(ov, state.agents, Date.now());
  if (!stale.length) return false;
  let dirty = false;
  for (const { key, status, agentId } of stale) {
    delete ov.status[key];
    delete ov.assignee[key];
    ov.notes[key] = `auto-requeued: '${status}' owner '${agentId || '?'}' not running — reset to pending for re-dispatch`;
    try { writeTaskStatus(ws, key, 'pending'); } catch { /* best effort */ }
    console.log(`[self-heal] task ${key} (was ${status}) reset to pending — owner gone`);
    dirty = true;
  }
  if (dirty) { overlayStore.save(ws, ov); notifyChange(); }
  return dirty;
}

// Is this note key superseded? A note is superseded when it has a successor (supersededBy) or a
// validTo stamp (it stopped being current). Pure read over note_nodes. Bare ('note-…') or prefixed.
function noteSuperseded(ov, key) {
  const id = String(key).replace(/^note:/, '');
  const n = (ov.note_nodes || {})[id];
  if (!n) return false;
  return !!(n.supersededBy || n.validTo);
}

// Decide why (if at all) a pending BLOCKING guidance item is stale, given its origin bindings:
//   - origin_task's overlay status is 'done' OR its git record is merged → the triggering work landed.
//   - ANY origin_note was superseded → the fact that triggered the question changed under it.
// Returns a reason string to auto-resolve with, or null to leave it pending. NEVER stale when BOTH
// origin_task and origin_notes are absent (no provenance to reason about). Pure read.
function staleGuidanceReason(ov, g) {
  const hasTask = g.origin_task != null && g.origin_task !== '';
  const notes = Array.isArray(g.origin_notes) ? g.origin_notes : [];
  if (!hasTask && notes.length === 0) return null;
  if (hasTask) {
    const st = ov.status[g.origin_task];
    const git = (ov.git || {})[g.origin_task];
    if (st === 'done' || (git && git.merged)) return 'auto-stale: origin task completed';
  }
  if (notes.some((k) => noteSuperseded(ov, k))) return 'auto-stale: triggering note superseded';
  return null;
}

// Auto-resolve pending BLOCKING guidance whose triggering context is gone (origin task completed or a
// triggering note superseded) — so the loop is not left paused on a question the world already
// answered. Mirrors sweepStaleVerdicts in structure. Idempotent (resolved items are skipped). Only
// blocking items are swept; 'review' housekeeping rows have their own settle path.
function sweepStaleGuidance(ws, ov) {
  if (!Array.isArray(ov.guidance)) return false;
  let dirty = false;
  for (const g of ov.guidance) {
    if (g.resolved || g.action || g.severity === 'review') continue;
    const reason = staleGuidanceReason(ov, g);
    if (!reason) continue;
    overlayStore.resolveGuidance(ov, g.id, reason);
    console.log(`[self-heal] guidance ${g.id} ${reason} — auto-resolved`);
    dirty = true;
  }
  if (dirty) { overlayStore.save(ws, ov); notifyChange(); }
  return dirty;
}

// Sweep the agent registry: mark 'running' entries as 'dead' when not vouched live.
function sweepStaleAgents() {
  // Agent liveness is workspace-AGNOSTIC (an agent may serve tasks across workspaces), and P3
  // removed the daemon-global overlay that this used to read stale_minutes from. Use the default
  // (10m) — per-workspace stale_minutes tuning applies to claim/loop sweeps, not the global agent sweep.
  const STALE_MINUTES_DEFAULT = 10;
  const mins = STALE_MINUTES_DEFAULT;
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
// `ov` (the loop's PINNED workspace overlay) + `mins` are passed by the caller (sweepStaleLoops);
// P3 removed the daemon-global overlay this used to read claims/config from. The agent scan is
// workspace-agnostic (state.agents is global); the claim scan reads the pinned overlay's status.
function sessionIsLive(session, ov, mins = 10) {
  if (!session) return true;
  // A running agent in this session, OR a recently-touched in_progress claim owned by an agent in
  // this session, both prove the conversation is still driving work. Same vouchedLive trust basis
  // as the claim sweep — a restored-from-disk 'running' record must not keep a dead session's
  // zombie loop alive forever after a daemon restart.
  const cutoff = Date.now() - mins * 60000;
  for (const a of Object.values(state.agents)) {
    if (!a || a.session !== session) continue;
    if (vouchedLive(a, mins, Date.now(), BOOT_MS)) return true;
  }
  if (ov) {
    for (const [key, st] of Object.entries(ov.status)) {
      if (st !== 'in_progress') continue;
      const ts = ov.timestamps[key];
      if (!ts || Date.parse(ts.lastChanged) <= cutoff) continue;
      const agentId = ov.assignee[key];
      const agent = agentId ? state.agents[agentId] : null;
      if (agent && agent.session === session) return true;
    }
  }
  return false;
}

// Central liveness sweep for the LOOP registry (same pass/pattern as sweepStaleClaims). Demote an
// active loop to active=false when ANY of: its driving session is dead; its budget or iteration cap
// is already exhausted; or it has made no progress (lastProgress, else startedAt) for longer than
// the staleness threshold. This reclaims zombies — e.g. a loop bound to a closed conversation that
// is never polled again — without a stop hook. Returns true if it demoted anything (caller persists).
function sweepStaleLoops() {
  let dirty = false;
  for (const L of loops.values()) {
    if (!L.active) continue;
    // Evaluate each loop against ITS OWN pinned workspace config (P3: no daemon-global default).
    // A loop may be pinned to a workspace with different stale_minutes / loop_stale_minutes settings;
    // an UNPINNED loop (L.workspace null) has no overlay to read, so config defaults apply.
    const loopWs = L.workspace || null;
    const loopOv = loopWs ? overlayFor(loopWs) : null;
    const loopOvConfig = loopOv ? loopOv.config : {};
    const mins = loopOvConfig.loop_stale_minutes ?? STALE_PROGRESS_MIN_DEFAULT;
    const sessionStaleMins = loopOvConfig.stale_minutes ?? 10;
    const cutoff = Date.now() - mins * 60000;
    let reason = null;
    if (L.iterations > L.config.maxIterations) reason = 'iteration cap reached';
    else if (L.spent > L.config.tokenBudget) reason = 'token budget exhausted';
    else if (!sessionIsLive(L.session, loopOv, sessionStaleMins)) {
      // Bootstrap grace: a freshly-started session-bound loop has no RUNNING agent and no touched
      // claim until its FIRST spawn, so sessionIsLive reads false on the loop's very first tick.
      // Skip the session-dead demotion while the loop itself is fresh (within the same
      // stale_minutes window sessionIsLive uses); the other demotion reasons still apply.
      const grace = Date.now() - sessionStaleMins * 60000;
      const last = Date.parse(L.lastProgress || L.startedAt || 0);
      if (!last || last < grace) reason = `driving session '${L.session}' dead`;
    }
    else {
      const last = Date.parse(L.lastProgress || L.startedAt || 0);
      if (!last || last < cutoff) reason = `no progress >${mins}m`;
    }
    if (reason) { L.active = false; L.sweptReason = reason; dirty = true; }
  }
  // GC (registry-leak guard, task /3): prune inactive loop entries idle past the retain window so the
  // registry doesn't grow unbounded (153 accrued by 2026-06-15, 111 of them born-dead iters=0). Active
  // loops are never pruned; recently-swept ones linger briefly for dashboard history.
  const gcCutoff = Date.now() - GC_LOOP_RETAIN_MS;
  for (const [id, L] of loops) {
    if (L.active) continue;
    const last = Date.parse(L.lastProgress || L.startedAt || 0) || 0;
    if (last < gcCutoff) { loops.delete(id); dirty = true; }
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
  // `graph`/`ov`/`ws` (REQUIRED — P3 removed the daemon-global default): the PINNED workspace's
  // graph/overlay, so the cooperative-stop check scans ITS claims. Both callers (the loop tick and
  // the /should-stop hook route) pass an explicit overlay + graph; ov defaults to EMPTY only as a
  // defensive no-match guard for a malformed call.
  const { actor = null, hook = false, graph = null, ov = overlayStore.EMPTY(), ws = null } = opts;
  if (hook) {
    // Agent-scoped stop: the calling worker is itself flagged → halt it (and nobody else). The driver
    // that requested the stop calls with a different/absent agent_id, so it falls through and runs on.
    if (actor && ov.stop_requested[actor]) {
      const g = graph || buildGraph(ws);
      const own = g.tasks.find((t) => t.status === 'in_progress' && (t.agent_id || ov.assignee[t.id]) === actor);
      return { task: own ? own.id : null, agent: actor, reason: 'stop_requested', cancel_requested: null, stop_requested: ov.stop_requested[actor] };
    }
    // Session-scoped CANCEL still halts any actor working a canceled task in this session.
    if (!session) return null;
    const g = graph || buildGraph(ws);
    for (const t of g.tasks) {
      if (t.status !== 'in_progress' || t.session !== session) continue;
      const cr = ov.cancel_requested[t.id] || null;
      if (cr) return { task: t.id, agent: t.agent_id || ov.assignee[t.id] || null, reason: 'cancel_requested', cancel_requested: cr, stop_requested: null };
    }
    return null;
  }
  // In-process loop path: session-scoped — a cancel on a claimed task OR a stop on its agent halts it.
  if (!session) return null;
  const g = graph || buildGraph(ws);
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
function verdictsFor(key, ov) {
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
function pendingOptimizeProblem(g, ov) {
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
function applyOptimize(prob, base, L, ws, ov) {
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
  // loop's pinned workspace (P3: no daemon-global pointer to fall back to). Legacy unit tests drive
  // decideOne with a bare ctx after __setOverlayForTest/__setWorkspaceForTest — those resolve to the
  // test-only holder (__testWs/__testOv), which is inert in production.
  const ws = ctx.ws || __testWs;
  const ov = ctx.ov || __testOv;
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
  const loopMainTx = L.session ? sessionBindings.mainTranscriptForSession(state, L.session) : null;
  if (L.real && loopMainTx) {                                  // real token accounting from this loop's session transcript
    const u = usageCached(loopMainTx);
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
  const isExplicitlyBlocked = (t) => !!(ov.blocked && ov.blocked[t.id]);
  // Blocked tasks are excluded from the spawn pool entirely. The block is sticky (overlay flag,
  // not derived from deps) and cleared only by unblock_task — never by dep re-derivation.
  let ready = readyAll.filter((t) => !isUnwired(t) && !isExplicitlyBlocked(t) && !isStandingHarnessTask(ov, t.id));
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

  // EAGER judge directive (task C) — the PRIMARY judge trigger, computed BEFORE the periodic drain.
  // When a node was just added/wired its candidate edge-set was marked in ov.eagerJudge; dispatch a
  // node-scoped judge for each pending node THIS tick (one dispatch per node's WHOLE edge-set, never
  // per-edge). CONCURRENCY CAP: a burst of node creation (planner minting 10 tasks) can't fork-bomb
  // judges — take at most min(leftover slots, judgeParallelCap) nodes; the EXCESS stays queued in
  // ov.eagerJudge and drains on the next tick as slots free. Token-clamped like judgeDirective so the
  // loop still STOPS at budget. Returns { nodes:[key,...], budget } or null. eagerJudgeNodes() prunes
  // already-drained marks as a pure side effect (persisted by the caller's save path).
  function eagerJudgeDirective(spawnedThisTick) {
    if (L.spent > L.config.tokenBudget || L.iterations > L.config.maxIterations) return null;
    const pending = judge.eagerJudgeNodes(ov);   // self-prunes drained marks
    if (!pending.length) return null;
    let slots = Math.min(Math.max(0, headroom - spawnedThisTick), pending.length, L.config.judgeParallelCap);
    if (slots <= 0) return null;
    const est = L.config.estPerTick || 0;
    if (est > 0) {
      const affordable = Math.floor(remaining / est);
      slots = Math.min(slots, Math.max(0, affordable));
    }
    if (slots <= 0) return null;
    L.spent += slots * est;                                   // account for the K node-judges so the loop stops at budget
    const budget = (ov.config.judge?.budgetPerRun) ?? 6;
    const dispatchNodes = pending.slice(0, slots);
    // Lease each node atomically so concurrent loops skip it (double-dispatch guard, task 27).
    let leased = false;
    for (const nodeKey of dispatchNodes) {
      if (overlayStore.acquireEagerJudgeLease(ov, nodeKey, L.id, 60000)) leased = true;
    }
    if (leased) saveDispatchOverlay(ws, ov);
    return { nodes: dispatchNodes, budget };       // FIFO; excess stays marked for next tick
  }

  // EXPENSIVE-TASK GATE (Lever 2): tasks carrying a metric spec (cost:"high" proxy) are held
  // for explicit user approval when cost_gate is enabled (ov.config.cost_gate:true, default off).
  // For each such task that would otherwise spawn: file ONE blocking guidance item (idempotent —
  // checks for an existing unresolved item first) and auto-block the task so it doesn't re-fire
  // every tick. Approving via /guidance/resolve (decision:"approve") unblocks it; "reject" keeps
  // it blocked. This reuses the existing guidance gate path (no new infrastructure).
  if (ov.config && ov.config.cost_gate) {
    for (const t of ready) {
      const hasMetric = ov.metrics && ov.metrics[t.id];
      if (!hasMetric) continue;
      const alreadyPending = Array.isArray(ov.guidance) && ov.guidance.some(
        (g) => !g.resolved && g.trigger === 'cost_gate' && g.action && g.action.taskKey === t.id
      );
      if (alreadyPending) continue;
      // File a blocking guidance item so the user can approve/reject.
      const gid = overlayStore.addGuidance(ov, {
        question: `Expensive task "${t.label}" (${t.id}) has a metric spec and is ready to auto-dispatch. Approve to run it, or reject to keep it blocked.`,
        context: `task_key: ${t.id}\nmetric: ${JSON.stringify(ov.metrics[t.id])}`,
        trigger: 'cost_gate',
        severity: 'blocking',
        action: { kind: 'cost_gate', taskKey: t.id },
      });
      // Auto-block so it doesn't re-fire guidance every tick before the user responds.
      overlayStore.setBlocked(ov, t.id, 'cost_gate: awaiting user approval');
      overlayStore.save(ws, ov); notifyChange();
    }
    // Re-derive ready after auto-blocking; keep guidance-pending tasks out of the spawn pool.
    const nowBlocked = (t) => !!(ov.blocked && ov.blocked[t.id]);
    ready = ready.filter((t) => !nowBlocked(t));
  }

  // Drop tasks another concurrent loop already leased this tick (double-dispatch guard, task /3).
  // The shared batch COUNT alone lets two loops slice the same ready[] prefix; the per-task spawn
  // lease (symmetric to the eager-judge lease below) makes them pick DISJOINT sets. decideAll runs
  // loops sequentially against one shared `ov` per workspace, so a lease acquired by an earlier loop
  // is visible here.
  const spawnable = ready.filter((t) => !overlayStore.hasLiveSpawnLease(ov, t.id));
  if (spawnable.length && headroom > 0) {
    // Spawn pool is shared ACROSS loops this tick: take up to min(this loop's batch, pool remaining,
    // this loop's spare concurrency). Don't spawn past maxConcurrency.
    const take = Math.max(0, Math.min(L.config.batch, ctx.batch.remaining, headroom, spawnable.length));
    if (take > 0) {
      ctx.batch.remaining -= take;
      L.lastProgress = now();                                 // progress signal for the liveness sweep (task 3)
      const picked = spawnable.slice(0, take);
      // Lease each dispatched task so a concurrent loop (this tick) and any re-poll (until the worker
      // claims) skip it. Released on claim/terminal via setStatus→clearSpawnLease; 60s TTL frees a
      // spawn that crashed before claiming.
      let leased = false;
      for (const t of picked) {
        if (overlayStore.acquireSpawnLease(ov, t.id, L.id, 60000)) leased = true;
      }
      if (leased) saveDispatchOverlay(ws, ov);
      const dec = withWire({ ...base, action: 'spawn', tasks: picked.map((t) => ({ key: t.id, label: t.label })), next_poll_seconds: L.config.minPoll });
      // A SINGLE heartbeat does BOTH: tasks first, then judge into the leftover slots. EAGER (task C)
      // is the PRIMARY judge trigger — node-scoped dispatch for freshly-wired nodes. Account for the
      // eager nodes' slot use so the periodic drain only fills what eager left. The periodic depth
      // drain is now a FALLBACK: it runs only with the slots eager did not consume.
      const eg = eagerJudgeDirective(take);
      if (eg) dec.eager = eg;
      const jd = judgeDirective(take + (eg ? eg.nodes.length : 0));
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
  // EAGER (task C) is the PRIMARY judge trigger: a freshly-wired node is dispatched node-scoped THIS
  // tick, ahead of the periodic depth drain. One dispatch per node's whole edge-set; the concurrency
  // cap holds a creation burst to judgeParallelCap, the excess draining on later ticks.
  const eg = eagerJudgeDirective(0);
  if (eg) {
    // Periodic drain becomes a FALLBACK that only fills slots eager left this tick (it may be empty).
    const jd2 = judgeDirective(eg.nodes.length);
    const dec = withWire({ ...base, action: 'judge_eager', nodes: eg.nodes, budget: eg.budget, next_poll_seconds: L.config.minPoll });
    if (jd2) dec.judge = { parallel: jd2.parallel, budget: jd2.budget };
    return dec;
  }
  // FALLBACK: no eager nodes pending — periodic depth-driven drain (task D adds timeout-fallback
  // semantics; here it is simply no longer the PRIMARY trigger).
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

function loopDecisionContext(ws, batch = null) {
  const ov = ws ? overlayFor(ws) : overlayStore.EMPTY();
  const pend = overlayStore.pendingGuidance(ov);
  return {
    ws, ov,
    graph: buildGraph(ws),
    pendingGuidance: pend.filter((g) => g.severity !== 'review'),
    reviewPending: pend.filter((g) => g.severity === 'review').length,
    batch,
  };
}

function ensureManagedGraphLoops(ctxByWs = null) {
  let dirty = false;
  for (const ws of registeredWorkspaces()) {
    let c = ctxByWs && ctxByWs.get(ws);
    if (!c) {
      c = loopDecisionContext(ws, null);
      if (ctxByWs) ctxByWs.set(ws, c);
    }
    const r = ensureManagedGraphLoop({ ctx: { loops, newLoop, now }, workspace: ws, graph: c.graph, overlay: c.ov });
    if (r.created) dirty = true;
  }
  if (dirty) { saveLoops(); notifyChange(); }
  return dirty;
}

// ONE heartbeat drives the WHOLE registry. Iterate every ACTIVE loop, compute each one's decision
// honoring its own budget/config/session, and return a batched array [{ loopId, action, ... }]. The
// `batch` config multiplexes across loops via a shared per-tick spawn pool (max of the active loops'
// batch settings — generous but bounded). Inactive loops are skipped. Caller persists the registry.
function decideAll() {
  sweepStaleLoops();   // central liveness sweep (same pass): demote dead/exhausted/stalled loops first
  // Sweep across the REAL set of registered workspaces (workspaces.json), not the single daemon-
  // global state.workspace pointer (P2b). registeredWorkspaces() already unions in active-loop
  // workspaces defensively, so a loop pinned to a not-yet-registered ws is still swept.
  const sweepWsSet = registeredWorkspaces();
  for (const ws of sweepWsSet) {
    const ov = overlayFor(ws);
    sweepStaleVerdicts(ws, ov);   // reset abandoned verdict-pending hand-offs per-workspace
    sweepStaleGuidance(ws, ov);   // auto-resolve stale blocking guidance per-workspace
    sweepFailedTasks(ws, ov);     // auto-retry: flip failed tasks back to pending (already (ws,ov)) per-workspace
    // Note: sweepStaleClaims is NOT called here — buildGraph already handles per-ws claim liveness
    // in the ctxFor() loop below; calling it here again would be a redundant double-sweep.
  }
  const managedCtxByWs = new Map();
  ensureManagedGraphLoops(managedCtxByWs);

  // Foreground/request loops get first chance to spend the shared spawn pool; managed graph loops
  // are the background safety net and must not preempt an explicit driver loop for the same work.
  const active = [...loops.values()]
    .filter((L) => L.active)
    .sort((a, b) => (a.managed ? 1 : 0) - (b.managed ? 1 : 0));
  // ONE spawn pool shared across ALL loops this tick (regardless of workspace) — the daemon-wide
  // concurrency bound is about total spawned workers, not per-workspace.
  const batch = { remaining: active.reduce((m, L) => Math.max(m, L.config.batch || 0), 0) };
  // Per-WORKSPACE evaluation contexts (the loop-workspace-pin fix): each loop is decided against ITS
  // pinned workspace's graph/overlay/guidance — never the daemon-global pointer, which another
  // session's SessionStart hook may have flipped mid-run (that demoted live loops with "DAG drained").
  // P3: there is no daemon-global pointer to fall back to for an unpinned loop. Production loops are
  // always pinned (exec.js sets L.workspace on /loop). The test-only holder (__testWs) supplies the
  // workspace when a unit test drives decideAll with an unpinned loop; if neither exists, overlayFor
  // / buildGraph handle the null ws as an empty graph (the loop simply finds nothing to do).
  const ctxByWs = new Map(managedCtxByWs);
  function ctxFor(ws) {
    let c = ctxByWs.get(ws);
    if (!c) {
      c = loopDecisionContext(ws, batch);
      ctxByWs.set(ws, c);
    }
    c.batch = batch;
    return c;
  }
  const out = [];
  for (const L of active) {
    const ctx = ctxFor(L.workspace || __testWs);
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
// A blocking dependency is SATISFIED (unblocks its dependents) when it reaches a terminal-SUCCESS
// status — 'done' OR 'tested'. 'tested' is the impl-worker terminal status (status MUST be 'tested'
// when an attempt is committed but its paired judge has not yet merged it — see the orchestrator
// auto-judge contract): a tested impl is finished work, so it MUST ready its blocked_by dependents
// (the paired judge), exactly like 'done'. Keying readiness off ONLY 'done' left the judge stuck at
// not_ready forever (note-mqq1rh9jnxp). 'failed'/'canceled' are terminal but NOT success → never
// satisfy a dependency (the dependent stays gated until the dep is retried/re-done).
const DEP_SATISFIED_STATUSES = new Set(['done', 'tested']);
function depSatisfied(status) { return DEP_SATISFIED_STATUSES.has(status); }

// Relevance scoring shared by /task/suggest and auto-wiring: rank every other node in the graph
// by token-overlap of label+summary against `target`. Returns matches sorted desc by score, each
// { key, label, status, score, shared, suggest_kind, duplicate }. suggest_kind is 'context' for
// done/non-task providers (summary flows in) and 'blocking' for open tasks (a real prerequisite).
// One source of truth so auto-wiring uses the IDENTICAL relevance the agent sees from suggest_links.
const SUGGEST_STOP = new Set(['the', 'and', 'for', 'task', 'with', 'that', 'this', 'from', 'into', 'use', 'run', 'add', 'all', 'new', 'via', 'its']);
const suggestToks = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !SUGGEST_STOP.has(w)));
const SUGGEST_DUP_THRESHOLD = 0.6;   // high label/summary overlap with an OPEN task ⇒ likely a re-plan duplicate
// Semantic-scale duplicate bar for scoreMatchesSemantic's cosine path. MiniLM cosine runs hotter than
// token overlap: ~0.55 is merely "related", so a DUPLICATE must sit well above that — ~0.85 ≈
// near-paraphrase / same task re-planned. High-precision initial estimate (a false dup-warning only
// nudges supersede; a miss just lets a dup through), calibrate as data accrues.
const SEMANTIC_DUP_THRESHOLD = 0.85;
// Score a single node's label+summary against a precomputed set of QUERY tokens (`qt`), using the
// IDENTICAL cosine-style token-overlap as scoreMatchesSemantic's lexical fallback — but anchored on a free-text query instead
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

// (lexical scoreMatches removed in the suggest_links semantic consolidation — suggestForTask now
//  ranks with scoreMatchesSemantic. The token-overlap evidence it produced lives on as the `shared`
//  field that scoreMatchesSemantic still computes per candidate.)

// Link-suggestion package for one task: top-5 scored matches + duplicate warning + wiring hint.
// The ONE source of suggestion semantics, shared by GET /task/suggest and POST /sync (the
// adoption nudge carries the same suggestions in-band) — keep route responses in lockstep.
async function suggestForTask(g, target) {
  // SEMANTIC candidate ranking (cosine over MiniLM embeddings) with per-candidate lexical fallback
  // when a vec is missing — scoreMatchesSemantic, the SAME retrieval core /search uses. suggest_links
  // no longer forks onto a lexical-only scorer that orphaned related-but-differently-worded tasks.
  // The agent reviews each suggestion and asserts the edge (origin:'asserted'), so a semantic
  // candidate list + agent judgment replaces the old lexical pass.
  // Use the task's PRIMARY (title+summary) vec as the "query", scored against each candidate's full
  // vec set inside scoreMatchesSemantic (maxCosine) — the SAME one-query-vec-vs-candidate-set model
  // /search uses, so a multi-vec candidate is still fully considered. null ⇒ pure-lexical fallback.
  const targetVec = nodeVecs(target)[0] || null;
  let ranked = scoreMatchesSemantic(g, target, targetVec);
  // CROSS-ENCODER RERANK — DEFAULT-ON (mirrors /search, validated by the CE-3 A/B): fires unless
  // explicitly disabled via ORCH_RERANK in {0,false,off}. NULL-SAFE: rerank()==null (sidecar
  // loading/unavailable) ⇒ keep the cosine order, no throw — default-on never breaks suggestions.
  const _rrEnv = String(process.env.ORCH_RERANK ?? '').trim().toLowerCase();
  const rerankOn = !(_rrEnv === '0' || _rrEnv === 'false' || _rrEnv === 'off');
  if (rerankOn && ranked.length > 1) {
    const pool = ranked.slice(0, 20);   // rerank a candidate window, then re-pick the top 5
    const byKey = new Map(g.tasks.map((t) => [t.id, t]));
    const ce = await rerank(`${target.label}\n${target.summary || ''}`.trim(),
                            pool.map((m) => `${m.label}\n${(byKey.get(m.key) || {}).summary || ''}`.trim()));
    if (Array.isArray(ce) && ce.length === pool.length) {
      ranked = pool
        .map((m, i) => ({ ...m, ceScore: Math.round(ce[i] * 1000) / 1000 }))
        .sort((a, b) => b.ceScore - a.ceScore);
    }
  }
  const suggestions = ranked.slice(0, 5);
  const duplicates = suggestions.filter((c) => c.duplicate).map((c) => c.key);
  let hint = 'Link DONE matches as kind:context (their summary becomes Tier-1 context); link a true prerequisite as kind:blocking. Skip unrelated ones.';
  if (duplicates.length) hint = `WARNING: this looks like a near-duplicate of OPEN task(s) ${duplicates.join(', ')}. If it is the same work re-planned, do NOT keep both — call supersede_task(old_task_key=<existing>, new_task_key=${target.id}) so the graph reconciles old→new instead of leaving orphaned duplicates. ` + hint;
  return { suggestions, duplicates, hint };
}

// The semantic suggest/autowire scorer (identical return shape to the old lexical scorer): each candidate is scored by
// cosine(targetVec, candidate.vec) when BOTH carry a 384-dim embedding, falling back PER-CANDIDATE
// to the lexical token-overlap score when either vec is genuinely missing. This is what lets note
// wiring connect prose that shares MEANING but few literal tokens (the lexical scorer scored those
// pairs below 0.25 and left them orphaned). Used by suggestForTask + autowireNoteProvider +
// autowireNewTaskWholeGraph; `target` is the consuming task/note node, `targetVec` its embedding
// (may be null ⇒ everything falls back to lexical).
function scoreMatchesSemantic(g, target, targetVec, options = {}) {
  const tg = suggestToks(`${target.label} ${target.summary || ''}`);
  const linked = new Set([...(target.deps || []), ...(target.context_deps || [])]);
  const OPEN = new Set(['not_ready', 'ready', 'in_progress']);
  const expectedMeta = options.expectedMeta || null;
  const tvec = Array.isArray(targetVec)
    && (!expectedMeta || (typeof vectorMatchesMeta === 'function' && vectorMatchesMeta(targetVec, options.targetVecMeta || null, expectedMeta)))
    ? targetVec
    : null;
  return g.tasks
    .filter((x) => x.id !== target.id && !linked.has(x.id))
    .filter((x) => !(x.kind === 'note' && x.validTo != null))
    .map((x) => {
      const xt = suggestToks(`${x.label} ${x.summary || ''}`);
      const shared = [...tg].filter((w) => xt.has(w));
      const lex = tg.size && xt.size ? shared.length / Math.sqrt(tg.size * xt.size) : 0;
      // Semantic cosine when BOTH sides have a real vector; otherwise lexical fallback for THIS pair.
      // Candidate side uses the MULTI-VEC schema: nodeVecs(x) is x.vecs ?? [x.vec] (notes stay on
      // .vec, tasks carry .vecs), scored MAX cosine over the set — identical to single-vec cosine
      // when the node carries exactly one vector, so note pairs score unchanged.
      let semantic = false;
      let score = lex;
      if (tvec && expectedMeta && nodeVecs(x, { expectedMeta }).length > 0) {
        semantic = true;
        score = maxCosine(tvec, x, { expectedMeta });
      } else if (tvec && !expectedMeta) {
        const vecs = nodeVecs(x);
        if (vecs.length > 0) {
          semantic = true;
          score = maxCosine(tvec, x);
        } else if (Array.isArray(x.vec)) {
          semantic = true;
          score = cosine(tvec, x.vec);
        }
      }
      // Scale-aware duplicate bar: cosine and token-overlap live on different scales, so one constant
      // mis-flags. Semantic pairs use SEMANTIC_DUP_THRESHOLD (near-paraphrase cosine); lexical-fallback
      // pairs keep SUGGEST_DUP_THRESHOLD (token-overlap scale).
      const dupBar = semantic ? SEMANTIC_DUP_THRESHOLD : SUGGEST_DUP_THRESHOLD;
      const duplicate = score >= dupBar && OPEN.has(x.status) && x.kind !== 'note';
      const suggestKind = (overlayStore.isNonTaskNodeKind(x.kind) || x.status === 'done') ? 'context' : 'blocking';
      return { key: x.id, label: x.label, status: x.status, score: Math.round(score * 1000) / 1000, shared: shared.slice(0, 8), suggest_kind: suggestKind, duplicate, via: semantic ? 'semantic' : 'lexical' };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Semantic auto-wire threshold. Cosine similarity over MiniLM embeddings sits on a DIFFERENT scale
// than lexical token-overlap (related prose lands ~0.4–0.7 cosine, where it scored ~0 lexically), so
// the lexical 0.25 bar is wrong here — it would wire nearly everything into a clique. Tuned on the
// post-backfill cloude corpus (128 notes); see STEP 2. Used only by the semantic note-wiring path.
// Production now seeds the top-per-kind autowire candidates unconditionally and the eager-judge
// arbitrates; cosine is a ranking signal, not a floor. Every new node seeds up to TASK_CREATE_FANOUT
// (=5) notes + 5 tasks and triggers an eager-judge pass; bounded by FANOUT.
// ENV OVERRIDE: ORCH_AUTOWIRE_THRESHOLD (env-overridable for bench or tuning runs).
const SEMANTIC_AUTOWIRE_THRESHOLD = process.env.ORCH_AUTOWIRE_THRESHOLD !== undefined ? parseFloat(process.env.ORCH_AUTOWIRE_THRESHOLD) : 0;
// Auto-wire a NOTE as a context PROVIDER: write weighted context edges (note -> neighbor) so the
// note's summary flows INTO each relevant open task instead of the note sitting as an orphan root.
// The note FEEDS existing consumers (the inverse of a consumer pulling in providers). `g` is the rebuilt graph; the note need not be in `g` yet (we build
// a synthetic target). Edges are ALWAYS note -> neighbor (the note is `from`) — the note is the
// PROVIDER, never the consumer of THIS edge. Scoring is SEMANTIC: cosine(targetVec, candidate.vec)
// when both carry an embedding, lexical fallback per-candidate otherwise. We skip `done` targets
// (feeding context into finished work is useless) but note->note IS now allowed: a note MAY receive
// an incoming context edge from ANOTHER note, knitting the knowledge notes into a navigable web
// (this intentionally reverses the earlier "no incoming edge on a note" rule). Cap to top-5 by score
// so a noisy note can't spam the graph. Pure on (overlay, g, noteKey, ...) ⇒ unit-testable; idempotent.
function autowireNoteProvider(overlay, g, noteKey, title, summary, targetVec = null, threshold = SEMANTIC_AUTOWIRE_THRESHOLD, options = {}) {
  const sourceNote = typeof noteKey === 'string' && noteKey.startsWith('note:')
    ? (overlay.note_nodes || {})[noteKey.slice('note:'.length)]
    : null;
  if (sourceNote && sourceNote.validTo != null) return 0;
  const target = { id: noteKey, label: title, summary: summary || '', deps: [], context_deps: [] };
  let added = 0;
  const kept = scoreMatchesSemantic(g, target, targetVec, options)
    .filter((m) => m.score >= threshold)                          // relevance bar (semantic cosine scale)
    .filter((m) => m.status !== 'done')                           // skip done (feeding finished work is useless); note->note IS now allowed
    .slice(0, 5);                                                 // cap fan-out — a noisy note can't spam the graph
  for (const m of kept) {
    const before = overlay.edges.length;
    // note is PROVIDER (from). Seed weight 0 (retrieval-invisible) + {by:'autowire', judged:false};
    // preserve cosine in `score` for judge promotion (the judge KEEP path is a promotion queue).
    // origin:'autowire-semantic' — note->task/note->note gated by the SEPARATE SEMANTIC bar (0.55),
    // a different cosine scale than the lexical path; keepRateByBand must NOT fold it into the
    // autowire-lexical curve.
    overlayStore.addEdge(overlay, noteKey, m.key, null, 'context', 0, { by: 'autowire', judged: false, score: m.score, origin: 'autowire-semantic' });
    if (overlay.edges.length > before) added++; // count only genuinely-new edges (addEdge dedupes)
  }
  return added;
}

// Per-kind fan-out cap for the creation-time whole-graph recall: at most this many note candidates
// AND this many task candidates seeded for a new anchor, so a generic task can't spam the graph.
const TASK_CREATE_FANOUT = 5;
// CREATION-TIME whole-graph recall for a NEW anchor task. Symmetric to autowireNoteProvider, but run
// when a TASK is born (its vec just set) so it gets weight-0, judged:false candidate edges to BOTH:
//   - relevant NOTES  → mirror the note->task direction (note is PROVIDER ⇒ edge note -> anchor), so
//                       the note's knowledge flows INTO the new task once the judge promotes it.
//   - relevant TASKS  → the anchor is the PROVIDER ⇒ edge anchor -> task, so the judge's edge item
//                       (it.from=anchor, it.to=task) classifies taskTask=true and runs the kind/dup
//                       path. DONE tasks are eligible providers — a new task's best context is the
//                       completed work it builds on (scoreMatchesSemantic does not filter done here).
// Closes the gap left by removing lexical task->task autowire (task /5) and by note->task wiring only
// firing on NOTE creation (autowireNoteProvider), never on task creation. SEMANTIC only (Step 1 proved
// lexical fusion regresses): scoreMatchesSemantic over the whole graph, gated at SEMANTIC_AUTOWIRE_THRESHOLD.
// All seeded edges are weight 0 (retrieval-invisible) + {by:'autowire', judged:false, origin:'autowire-semantic'}
// so they surface on /judge/next and stay invisible to retrieval until the neighborhood-aware judge
// promotes them. Pure on (overlay, g, anchorKey, ...) ⇒ unit-testable; idempotent (addEdge dedupes).
async function autowireNewTaskWholeGraph(overlay, g, anchorKey, title, summary, targetVec = null, threshold = SEMANTIC_AUTOWIRE_THRESHOLD, options = {}) {
  const target = { id: anchorKey, label: title, summary: summary || '', deps: [], context_deps: [] };
  // CROSS-ENCODER GATE (opt-in via ORCH_RERANK) — "cross-encoder first, then gate". When on, take the
  // top-K cosine candidates as the recall pool (ORCH_RERANK_K, default 50 — a rank-based COST CAP, not
  // a score floor: no brittle cosine threshold to calibrate, K just bounds how many candidates the
  // cross-encoder must score), rerank them, and SEED on the cross-encoder score (ORCH_RERANK_SEED_
  // THRESHOLD, default 0.5 on the sigmoid scale). The CE score is the precision arbiter; cosine is
  // only the cheap recall stage. This sharpens which weight-0 candidate edges reach the edge-judge.
  // NULL-SAFE: if the rerank sidecar is unavailable, rerank() returns null and we fall back to the
  // exact cosine-0.55 gate (today's behavior). DEFAULT OFF ⇒ identical to today.
  // NOTE: seeded edges keep the COSINE in `score` (the judge's keepRateByBand is calibrated on the
  // cosine scale) and carry the cross-encoder score separately as `ceScore` in the edge meta.
  let scored;
  if (isTruthy(process.env.ORCH_RERANK)) {
    const K = Math.max(1, parseInt(process.env.ORCH_RERANK_K || '50', 10) || 50);
    const pool = scoreMatchesSemantic(g, target, targetVec, options).slice(0, K);
    const byKey = new Map(g.tasks.map((t) => [t.id, t]));
    const ce = pool.length
      ? await rerank(`${title}\n${summary || ''}`.trim(),
                     pool.map((m) => `${m.label}\n${(byKey.get(m.key) || {}).summary || ''}`.trim()))
      : null;
    if (Array.isArray(ce) && ce.length === pool.length) {
      const seedThresh = parseFloat(process.env.ORCH_RERANK_SEED_THRESHOLD || '0.5') || 0.5;
      scored = pool
        .map((m, i) => ({ ...m, ceScore: Math.round(ce[i] * 1000) / 1000 }))
        .filter((m) => m.ceScore >= seedThresh)
        .sort((a, b) => b.ceScore - a.ceScore);
    } else {
      // rerank unavailable ⇒ degrade to the cosine gate (current behavior, no throw)
      scored = scoreMatchesSemantic(g, target, targetVec, options).filter((m) => m.score >= threshold);
    }
  } else {
    // ORCH_AUTOWIRE_K: optional top-K cap on the cosine pool BEFORE the per-kind fan-out.
    // When ORCH_AUTOWIRE_THRESHOLD=0 (bench mode), the cosine filter is effectively disabled;
    // ORCH_AUTOWIRE_K bounds cost by capping how many candidates reach the judge (default:
    // no cap in production, preserving existing behaviour; bench sets it to 20 via daemon.py).
    const awK = parseInt(process.env.ORCH_AUTOWIRE_K || '0', 10) || 0;
    const allScored = scoreMatchesSemantic(g, target, targetVec, options).filter((m) => m.score >= threshold);
    scored = awK > 0 ? allScored.slice(0, awK) : allScored;
  }
  const isNote = (k) => typeof k === 'string' && k.startsWith('note:');
  const notes = scored.filter((m) => isNote(m.key)).slice(0, TASK_CREATE_FANOUT);
  const taskCands = scored.filter((m) => !isNote(m.key)).slice(0, TASK_CREATE_FANOUT);
  let added = 0;
  const seed = (from, to, score, ceScore) => {
    const before = overlay.edges.length;
    const meta = { by: 'autowire', judged: false, score, origin: 'autowire-semantic' };
    if (ceScore !== undefined) meta.ceScore = ceScore;
    overlayStore.addEdge(overlay, from, to, null, 'context', 0, meta);
    if (overlay.edges.length > before) added++; // count only genuinely-new edges (addEdge dedupes)
  };
  // NOTE candidates: note is provider ⇒ note -> anchor (mirrors autowireNoteProvider's direction).
  for (const m of notes) seed(m.key, anchorKey, m.score, m.ceScore);
  // TASK candidates: anchor is provider ⇒ anchor -> task (taskTask path fires in the judge).
  for (const m of taskCands) seed(anchorKey, m.key, m.score, m.ceScore);
  return added;
}

// Seed low-weight context edges from a task's blocking prerequisites (gate-transparent).
// Called at block-edge creation and at task adoption so prerequisites flow as retrieval context.
// Gate nodes (kind==='gate') are structural — seed their predecessors instead (1-hop transit).
// Pure on (overlay, ws, taskId) — mutates `overlay` in place; the CALLER is responsible for saving.
// Idempotent: addEdge dedupes on (from, to, fromWorkspace) — safe to call multiple times.
// Uses ov.edges directly for blocking-edge lookup (buildGraph output does not expose edges array).
// `_g` is an optional pre-built graph (for unit tests — omit in production and buildGraph(ws) is used).
function seedBlockingDepContext(ov, ws, taskId, _g) {
  if (!ov || !taskId) return;
  const g = _g || buildGraph(ws);
  const task = g.tasks.find((t) => t.id === taskId);
  if (!task || (task.kind || 'task') === 'gate') return; // gates don't receive context seeds
  const edges = ov.edges || [];
  // Blocking edges are stored WITHOUT a kind field (absent = blocking, back-compat) — match both.
  const isBlocking = (e) => !e.kind || e.kind === 'blocking';
  const directBlockers = edges.filter((e) => e.to === taskId && isBlocking(e));
  for (const e of directBlockers) {
    const dep = g.tasks.find((t) => t.id === e.from);
    if (!dep) continue;
    if ((dep.kind || 'task') === 'gate') {
      // Gate-transparent: seed gate's own blocking deps instead (1-hop transit, no recursion)
      const gateBlockers = edges.filter((ge) => ge.to === dep.id && isBlocking(ge));
      for (const ge of gateBlockers) {
        const realDep = g.tasks.find((t) => t.id === ge.from);
        if (realDep && (realDep.kind || 'task') !== 'gate') {
          overlayStore.addEdge(ov, ge.from, taskId, null, 'context', 0,
            { weight: 0, judged: false, by: 'autowire-blockdep', origin: 'blocking-dep-seed' });
        }
      }
    } else {
      overlayStore.addEdge(ov, e.from, taskId, null, 'context', 0,
        { weight: 0, judged: false, by: 'autowire-blockdep', origin: 'blocking-dep-seed' });
    }
  }
}

// UNIFIED INGEST FUNNEL — the one path every node passes through at BIRTH (BUILD1 of the lifecycle
// unification, design note:note-mqeapqae6jf). Historically embed → setTaskVec → autowire → markEagerJudge
// fired ONLY inside /overlay/status on the first vec, so native/file-drop/follow-up tasks reached
// `ready`/dispatch with no vec, no candidate edges, and no eager mark → the judging→ready D-gate was a
// no-op for those lanes. ingestNode collapses the four steps into one funnel callable at creation time:
//   embed(title+summary) → setTaskVec → autowireNewTaskWholeGraph (seed weight-0 candidate edges) →
//   markEagerJudge (stamps judgingSince) when edges were seeded.
// Null-safe + best-effort: a null vec (sidecar loading/disabled) yields no autowire and no mark, exactly
// like the lazy path. Mutates `overlay` in place; the CALLER is responsible for saving. `g` is a built
// graph for the recall pass (pass a fresh buildGraph(ws)). Idempotent at the edge layer (addEdge dedupes)
// and at the vec layer (re-embed just rewrites the vec). Returns { vec, seeded, marked } for callers/tests.
// `ws` is optional: when provided, seedBlockingDepContext fires after autowire to seed blocking-dep
// context edges for tasks that already have blocking prerequisites at adoption time.
async function ingestNode(overlay, g, key, { title, summary } = {}, ws = null) {
  const out = { vec: null, seeded: 0, marked: false };
  if (!overlay || !key) return out;
  try {
    // Gate nodes are structural coordination primitives — skip embed + autowire
    const snap = overlay.snapshots && overlay.snapshots[key];
    if (snap && snap.metadata && snap.metadata.gate_kind) {
      return { skipped: 'gate', key };
    }
    const isNote = typeof key === 'string' && key.startsWith('note:');
    if (isNote) {
      // Note born-path: vec was already embedded + stored in note_nodes[bareId].vec by addNoteNode.
      // Pull it from there — no re-embed, no setTaskVec (notes use .vec on the node, not taskVecs).
      const bareId = key.slice('note:'.length);
      const noteNode = overlay.note_nodes && overlay.note_nodes[bareId];
      const vec = noteNode && Array.isArray(noteNode.vec) ? noteNode.vec : null;
      if (!vec) return out;
      out.vec = vec;
      // Notes are PROVIDERS: seed note -> neighbor candidate edges (mirrors autowireNoteProvider direction).
      const noteMeta = noteNode && noteNode.vecMeta ? noteNode.vecMeta : null;
      const seeded = autowireNoteProvider(overlay, g, key, title, summary, vec, undefined, { expectedMeta: noteMeta, targetVecMeta: noteMeta });
      out.seeded = seeded;
      if (seeded > 0) { overlayStore.markEagerJudge(overlay, key); out.marked = true; }
    } else {
      const er = typeof embedWithMeta === 'function'
        ? await embedWithMeta(taskEmbedText({ title, summary }), { mode: 'document', overlay })
        : { vec: await embed(taskEmbedText({ title, summary })), meta: null };
      const vec = er.vec;
      if (!vec) return out;                                 // no embedding ⇒ lexical fallback, nothing to seed
      overlayStore.setTaskVec(overlay, key, vec, er.meta);
      out.vec = vec;
      const seeded = await autowireNewTaskWholeGraph(overlay, g, key, title, summary, vec, undefined, { expectedMeta: er.meta, targetVecMeta: er.meta });
      out.seeded = seeded;
      if (seeded > 0) { overlayStore.markEagerJudge(overlay, key); out.marked = true; }
      // Seed context edges from existing blocking deps (covers tasks adopted after their block edges exist).
      // Best-effort: errors in seedBlockingDepContext must not abort ingestion.
      if (ws) { try { seedBlockingDepContext(overlay, ws, key); } catch { /* best-effort */ } }
    }
  } catch { /* best-effort — never let ingestion throw into a caller's hot path */ }
  return out;
}

// RECALL half of the RAG-candidate → agent-adjudicator pipeline. For an orphan/under-connected note,
// return up to `top` semantic candidates (cosine >= RAG_RECALL_THRESHOLD) the AGENT will adjudicate —
// it does NOT write any edge (that's the judge's verdict, never a cosine score). Looser than the old
// autowire bar: recall, not precision (the agent supplies precision). Each candidate carries the
// endpoint's title+summary+key+score+via so the judge can reason without extra reads. Skips candidates
// the note ALREADY has a context edge to (no point re-proposing an existing edge). Pure read of `g`.
const RAG_RECALL_THRESHOLD = 0.40;   // RECALL bar — deliberately below the old 0.55 precision bar
function noteRagCandidates(overlay, g, noteKey, title, summary, targetVec = null, top = 8, options = {}) {
  const target = { id: noteKey, label: title, summary: summary || '', deps: [], context_deps: [] };
  const existing = new Set(overlay.edges.filter((e) => e.from === noteKey && e.kind === 'context').map((e) => e.to));
  return scoreMatchesSemantic(g, target, targetVec, options)
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

// Periodic file-drop stub GC: adopt missing snapshots, remove terminal stubs with snapshots.
function sweepFiledropStubs(ws) {
  if (!ws) return { adopted: [], removed: [] };
  const ov = overlayFor(ws);
  const result = filedropGc.sweepWorkspaceStubs(ws, ov, { dryRun: false });
  if (result.adopted.length || result.removed.length) {
    overlayStore.save(ws, ov); refreshOverlayStamp(ws);
    cache.agg.delete(ws); cache.aggAt.delete(ws);
  }
  return result;
}

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
      ov[ws] = overlayFor(ws);
    }
    return { tasks: agg[ws], overlay: ov[ws] };
  }

  // Dependency refs for a task: native (same ws) + inbound overlay edges (from may be ghost).
  function depRefs(ws, key) {
    const { tasks, overlay } = loadWs(ws);
    const t = tasks[key];
    const local = t ? t.deps
      .filter((k) => !overlayStore.isReversePairedJudgeBlockingEdge(overlay, k, key, { tasks }))
      .map((k) => ({ ws, key: k, kind: 'blocking' })) : [];
    const edges = overlay.edges
      .filter((e) => e.to === key && !e.toWorkspace)
      .filter((e) => e.kind === 'context' || !overlayStore.isReversePairedJudgeBlockingEdge(overlay, e.from, e.to, { tasks }))
      // Weight is a relevance MULTIPLIER for context edges: a weight-0 edge contributes ZERO and is
      // EXCLUDED from the context_deps payload (DAG-tier injection + structural rerank), not merely
      // deprioritized. This is how unjudged autowire edges (seeded at weight 0) stay retrieval-
      // invisible until the judge promotes them. The edge remains in overlay.edges so the judge still
      // sees it. Blocking edges carry no weight and are never filtered.
      .filter((e) => !(e.kind === 'context' && overlayStore.edgeWeight(e) === 0))
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
    const ready = depRefs(ws, key).filter((d) => d.kind !== 'context').every((d) => depSatisfied(effective(d.ws, d.key, seen))); // context edges never block; a dep is satisfied by terminal-success (done OR tested)
    seen.delete(id);
    if (!ready) return (memo[id] = 'not_ready');
    // JUDGING→READY gate (task D / P6 STRICT): blocking deps are satisfied, but if this task still
    // carries ANY unjudged autowire candidate edge its inherited context is provisional — hold it in
    // 'not_ready' (the 'judging' phase) so it is NOT spawned/claimable yet. P6: STRICT, no time-based
    // release — the task holds until the candidate set drains (eager judge on node-add is the happy
    // path; `node scripts/judge-drain-once.js --node <key> --workspace <ws>` is the on-demand un-gate).
    const js = judge.judgingState(overlay, key);
    if (js.judging) return (memo[id] = 'not_ready');
    return (memo[id] = 'ready');
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
  // P3: there is no daemon-global state.overlay — callers pass st={...state, overlay:<resolved ov>}.
  // Guard the lookup so a st without an overlay (or the bare `state` default) degrades to no-assignee
  // resolution instead of crashing (mirrors taskTokens' `st.overlay || EMPTY`).
  const ov = st.overlay || overlayStore.EMPTY();
  const assignee = ov.assignee[key];
  const agent = assignee ? st.agents[assignee] : null;
  let tp = agent && agent.transcript_path;
  if (!tp && agent && agent.session) {                                   // derive from per-session binding
    tp = sessionBindings.resolveSessionTranscriptPath(st, agent.session, agent.subagent_session || agent.session);
  }
  if (!tp) tp = harnessTranscriptForTask(st, key, session);             // time-window correlation fallback
  if (!tp && anySession && session) {                                    // task's shared session transcript
    tp = sessionBindings.resolveSessionTranscriptPath(st, session, session);
  }
  if (!tp) return null;
  try { return fs.existsSync(tp) ? tp : null; } catch { return null; }
}

// Per-task token total for the graph node. null = unknown.
function taskTokens(key, session, dedicated, st = state) {
  const ov = st.overlay || overlayStore.EMPTY();
  const fromRecords = usageAccounting.taskOutputFromRecords(ov, key);
  if (fromRecords > 0) return fromRecords;
  const tp = taskTranscript(key, session, dedicated, st);
  if (tp) {
    const u = usageCached(tp);
    if (u && typeof u.total === 'number') return u.total;
  }
  const assignee = ov.assignee[key];
  const agent = assignee ? st.agents[assignee] : null;
  const ru = agent && claudeHarness.transcripts.taskUsageFromAgent && claudeHarness.transcripts.taskUsageFromAgent(agent);
  return ru && typeof ru.total === 'number' ? ru.total : null;
}

function reconcileGraphBeforeProjection(ws, ovWs) {
  // Release dead/abandoned claims BEFORE reading native, busting the aggregate cache so a reverted
  // native status is reflected in this same build (not one poll later). Sweeps the TARGET
  // workspace's overlay, so stale claims release wherever the read lands.
  const invalidate = () => { cache.agg.delete(ws); cache.aggAt.delete(ws); };
  if (sweepStaleClaims(ws, ovWs)) invalidate();
  let native = aggregateCached(ws);
  if (sweepStaleNativeClaims(ws, ovWs, native)) {
    invalidate();
    native = aggregateCached(ws);
  }
  const nativeByKey = Object.fromEntries(native.map((t) => [t.key, t]));
  const repairedReverseJudgeEdges = overlayStore.pruneReversePairedJudgeBlockingEdges(ovWs, { tasks: nativeByKey });
  return { native, effects: {
    tsDirty: false,
    edgesDirty: repairedReverseJudgeEdges > 0,
    adoptDirty: false,
    newlySeen: [],
    newlyAdoptedSet: new Set(),
    newlyAdopted: [],
  } };
}

function commitGraphProjectionEffects(ws, ovWs, effects) {
  // A node was first seen THIS build ⇒ bump the graph-change epoch so the edge-judge re-pulls notes
  // whose neighborhood may now have a new candidate (judgedAtEpoch < epoch becomes true again). One
  // bump per build that saw new nodes — cheap, monotonic, persisted with the overlay below. (Lexical
  // task->task autowire was removed: it had no agent in its lifecycle, was never judged, and seeded
  // weight-0 edges that stayed permanently invisible — suggest_links + the adoption nudge cover
  // task->task wiring with agent judgment.)
  if (effects.newlySeen.length) {
    overlayStore.bumpEpoch(ovWs);
    effects.edgesDirty = true;
  }
  if (effects.tsDirty || effects.edgesDirty || effects.adoptDirty) {
    overlayStore.save(ws, ovWs, { deferred: true }); refreshOverlayStamp(ws); notifyChange();
  }
  // INGEST-AT-BIRTH (BUILD1): native tasks adopted THIS build pass through the unified ingestNode funnel
  // (embed → setTaskVec → autowire → markEagerJudge) so they carry a vec + candidate edges + an eager mark
  // BEFORE they can reach `ready`/dispatch. Fire-and-forget so buildGraph stays synchronous.
  if (effects.newlyAdopted.length) {
    (async () => {
      for (const n of effects.newlyAdopted) {
        try {
          const r = await ingestNode(ovWs, buildGraph(ws), n.key, { title: n.title, summary: n.summary }, ws);
          // If ingest found no edges to seed (embed disabled, isolated node, etc.), there are no
          // unjudged candidate edges, so the STRICT judgingState gate already reports judging:false and
          // the node progresses to ready on the next build — no judge is needed. We still clear the
          // vestigial judgingSince anchor here purely to keep the overlay tidy (the gate no longer reads
          // it; readiness is derived solely from unverifiedEdgesForNode).
          if (r.seeded === 0) { overlayStore.clearJudgingSince(ovWs, n.key); }
          if (r.vec || r.seeded === 0) { overlayStore.save(ws, ovWs, { deferred: true }); refreshOverlayStamp(ws); notifyChange(); }
        } catch { /* best-effort birth ingest */ }
      }
    })();
  }
}

function projectGraphFromNative(ws, ovWs, native, effects) {
  const R = makeResolver();
  const ghostMap = {}; // "ws|key" -> ghost stub
  const sessionCount = {}; for (const t of native) sessionCount[t.session] = (sessionCount[t.session] || 0) + 1;
  const stWs = { ...state, overlay: ovWs };   // taskTokens reads assignee from the target overlay

  // Preserve the old buildGraph order: first-sight/adoption/unwired stamps happen before each node's
  // visible projection is computed; the commit phase only persists and schedules follow-on ingest.
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
    let ts = ovWs.timestamps[t.key] || null;   // read+stamp the target workspace's (writable) overlay
    if (!ts) {
      ts = { firstSeen: now(), lastChanged: now(), lastStatus: status }; ovWs.timestamps[t.key] = ts; effects.tsDirty = true; effects.newlySeen.push(t.key);
      if (adoptNativeTask(ovWs, t.key, ws)) {
        effects.adoptDirty = true; effects.newlyAdopted.push({ key: t.key, title: t.label, summary: ovWs.summaries[t.key] || '' });
        // ADOPT-HOLD: stamp judgingSince synchronously so the judging→ready gate fires on THIS build's
        // projection (status already computed by R.effective before we knew the node was newly adopted,
        // so we override status/judging below for keys in newlyAdoptedSet). Without this, the async
        // ingestNode path stamped the mark too late — the node reached ready/dispatch unjudged.
        overlayStore.markEagerJudge(ovWs, t.key);
        effects.newlyAdoptedSet.add(t.key);
      }
      // Unwired quarantine: a task FIRST SEEN with no edges in either direction is stamped
      // unwired — /overlay/status refuses an in_progress claim until the creator wires it
      // (add_dependency clears the flag) or declares it a root (POST /mark-root). Tasks that
      // existed before this feature already carry firstSeen and are NEVER stamped (back-compat).
      if (!deps.length && !context_deps.length && !ovWs.edges.some((e) => e.from === t.key || e.to === t.key)) {
        if (!ovWs.unwired) ovWs.unwired = {};
        ovWs.unwired[t.key] = true;
      }
    }
    else if (ts.lastStatus !== status) {
      ts.lastChanged = now(); ts.lastStatus = status; effects.tsDirty = true;
    }
    const _rc = ovWs.retryConfig && ovWs.retryConfig[t.key];
    // JUDGING→READY gate (task D / P6 STRICT): expose the judging phase so the dashboard / next_action
    // can show it. `judging` = task still has unjudged autowire edges (held not_ready above, with NO
    // time-based release). `provisional` is retained for projection-shape stability but is now always
    // false: P6 removed the timeout fallback, so there is no "fell back to ready while still unjudged"
    // state — a task is either fully judging (held) or fully ready.
    const _js = judge.judgingState(ovWs, t.key);
    // ADOPT-HOLD projection fix: R.effective() memoized status BEFORE we stamped markEagerJudge at
    // adoption. For newly adopted nodes that would otherwise be 'ready', hold them at 'not_ready' and
    // show judging:true so this build's projection is consistent with the persist. The hold expires
    // when the async ingest either seeds edges (which the strict judgingState gate then manages) or
    // finds nothing to seed (which clears the eager mark).
    const _adoptHold = effects.newlyAdoptedSet.has(t.key) && status === 'ready';
    const _status = (_adoptHold || (_js.judging && status === 'ready')) ? 'not_ready' : status;
    const _judging = _adoptHold || _js.judging;
    const taskVecNode = embeddingStore.taskNode(ovWs, t.key);
    return { id: t.key, label: t.label, session: t.session, deps, context_deps, context_weights, status: _status, judging: _judging, provisional: false, note: ovWs.notes[t.key] || '', agent_id: ovWs.assignee[t.key] || null, summary: ovWs.summaries[t.key] || '', vecs: taskVecNode.vecs, vecsMeta: taskVecNode.vecsMeta, tags: (ovWs.taskTags && ovWs.taskTags[t.key]) || [], git: ovWs.git[t.key] || null, git_user: (ovWs.git_users && ovWs.git_users[t.key]) || null, repo: (ovWs.repos && ovWs.repos[t.key]) || null, metric: (ovWs.metrics && ovWs.metrics[t.key]) || null, measurement: (ovWs.measurements && ovWs.measurements[t.key]) || null, benchmark: (ovWs.benchmarks && ovWs.benchmarks[t.key]) || null, firstSeen: ts ? ts.firstSeen : null, lastChanged: ts ? ts.lastChanged : null, tokens: taskTokens(t.key, t.session, sessionCount[t.session] === 1, stWs), maxRetries: (_rc && _rc.maxRetries) || 0, retryCount: (_rc && _rc.retryCount) || 0, blocked: (ovWs.blocked && ovWs.blocked[t.key]) || null };
  });
  // KEPT context edges → context_deps for overlay-only graph nodes. The structBoost reranker
  // (/search) and BFS path tier read each node's context_deps as graph adjacency. Mirror the task-side
  // convention (depRefs): a context edge e.to=<node> contributes e.from to that node's context_deps.
  // JUDGED-KEPT ONLY — same filter as depRefs: kind==='context' AND weight!==0, so raw weight-0
  // autowire candidates are excluded; only a judge-promoted/asserted edge registers.
  const keptCtxDeps = {};     // node key -> [from-key, ...] of kept context edges
  const keptCtxWeights = {};  // node key -> { from-key: weight }
  for (const e of (ovWs.edges || [])) {
    if (e.kind !== 'context' || e.toWorkspace) continue;
    if (overlayStore.edgeWeight(e) === 0) continue;   // unjudged autowire candidate — excluded
    (keptCtxDeps[e.to] || (keptCtxDeps[e.to] = [])).push(e.from);
    (keptCtxWeights[e.to] || (keptCtxWeights[e.to] = {}))[e.from] = overlayStore.edgeWeight(e);
  }
  // Append overlay-only NOTE nodes (durable decisions/findings). They are context providers,
  // not real tasks: deps:[] (level-0), status 'note', and excluded from status counts.
  for (const [noteId, n] of Object.entries(ovWs.note_nodes || {})) {
    const bareNoteId = n.id || noteId;
    const noteKey = 'note:' + bareNoteId;
    tasks.push({ id: noteKey, label: n.title, kind: 'note', status: 'note', session: null, deps: [], context_deps: keptCtxDeps[noteKey] || [], context_weights: keptCtxWeights[noteKey] || {}, note: '', agent_id: null, summary: n.summary, vec: Array.isArray(n.vec) ? n.vec : null, vecMeta: n.vecMeta || null, vecs: Array.isArray(n.vecs) ? n.vecs : null, vecsMeta: Array.isArray(n.vecsMeta) ? n.vecsMeta : null,
      // Temporal/state-change fields (null on pre-temporal notes — back-compat): validFrom/validTo
      // bound when the fact was true; supersedes/supersededBy chain it to the note it replaced / was
      // replaced by. The dashboard reads these for the superseded indicator; /search for as-of.
      validFrom: n.validFrom || n.created_at || null, validTo: n.validTo || null,
      created_at: n.created_at || null,   // transaction time (when the KB learned this) — read by /search?knownAsOf
      supersedes: n.supersedes ? 'note:' + n.supersedes : null,
      supersededBy: n.supersededBy ? 'note:' + n.supersededBy : null,
      // pending_dup: this note was admitted PROVISIONAL on a write-time dup-guard fire and is awaiting
      // the dup-judge. While set it is RETRIEVAL-INVISIBLE (the /search recall path excludes it). Derived
      // from the local overlay.pendingDup map (round-trips via save's LOCAL_FIELDS) — NOT a note_node field.
      pending_dup: !!(ovWs.pendingDup && ovWs.pendingDup[noteKey]),
      dup_match: (ovWs.pendingDup && ovWs.pendingDup[noteKey] && ovWs.pendingDup[noteKey].match) || null,
      category: n.category || null, tags: Array.isArray(n.tags) ? n.tags : [] });
  }
  // Append typed knowledge nodes for source/provenance structure. They are graph/search nodes only:
  // no native status lifecycle, no assignee/session/todo semantics.
  for (const [nodeKey, n] of Object.entries(ovWs.knowledge_nodes || {})) {
    if (!overlayStore.isKnowledgeNodeKind(n && n.type)) continue;
    const key = n.key || nodeKey;
    tasks.push({
      id: key,
      label: n.label || n.title || key,
      kind: n.type,
      status: 'knowledge',
      session: null,
      deps: [],
      context_deps: keptCtxDeps[key] || [],
      context_weights: keptCtxWeights[key] || {},
      note: '',
      agent_id: null,
      summary: n.summary || '',
      vec: Array.isArray(n.vec) ? n.vec : null,
      vecMeta: n.vecMeta || null,
      vecs: Array.isArray(n.vecs) ? n.vecs : null,
      vecsMeta: Array.isArray(n.vecsMeta) ? n.vecsMeta : null,
      metadata: n.metadata || {},
      source_path: n.source_path || null,
      section_ref: n.section_ref || null,
      chunk_ref: n.chunk_ref || null,
      cluster_ref: n.cluster_ref || null,
      created_at: n.created_at || null,
      updated_at: n.updated_at || null,
    });
  }
  const ghosts = Object.values(ghostMap);
  return { tasks, ghosts, effects };
}

// Build the graph for one workspace: explicit reconciliation side effects, then projection.
function buildGraph(ws) {
  if (!ws) return { tasks: [], ghosts: [], summary: summaryFor([], [], overlayStore.EMPTY()) };
  // P3: every workspace's overlay is the per-workspace cache entry (overlayFor) — there is no
  // special "current" workspace. The cache entry is the authoritative, write-coalesced in-memory
  // store for ANY workspace, so lifecycle reconciliation runs for every valid ws.
  const ovWs = overlayFor(ws);
  const inputs = reconcileGraphBeforeProjection(ws, ovWs);
  const projection = projectGraphFromNative(ws, ovWs, inputs.native, inputs.effects);
  commitGraphProjectionEffects(ws, ovWs, projection.effects);
  return { tasks: projection.tasks, ghosts: projection.ghosts, summary: summaryFor(projection.tasks, projection.ghosts, ovWs) };
}

function summaryFor(tasks, ghosts, ov = overlayStore.EMPTY()) {
  const real = tasks.filter((t) => !overlayStore.isNonTaskNode(t)); // note/knowledge nodes aren't tasks
  const notes = tasks.filter((t) => t.kind === 'note').length;
  const knowledge_nodes = tasks.length - real.length - notes;
  const c = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  for (const t of real) c[t.status] = (c[t.status] || 0) + 1;
  c.local_in_progress = localInProgressCount(real, ov);
  const a = agentsArr();
  return {
    tasks_total: real.length,
    notes,
    knowledge_nodes,
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

// Sum per-message token usage from a transcript JSONL — delegated to usage-accounting (MS3).
function readUsage(p) {
  return usageAccounting.parseTranscriptUsage(p);
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
function readBody(req) {
  if (req.__orchBody !== undefined) return Promise.resolve(req.__orchBody);
  return new Promise((r) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1048576) { req.destroy(); return r({}); } chunks.push(c); });
    req.on('end', () => {
      try {
        const b = Buffer.concat(chunks).toString('utf8');
        const parsed = b ? JSON.parse(b) : {};
        if (parsed && parsed.agent_id) {
          touchAgent(String(parsed.agent_id), {
            workspace: parsed.workspace,
            task_key: parsed.key || parsed.task_key,
            session: parsed.session,
            agent_type: parsed.agent_type,
            transcript_path: parsed.transcript_path,
            subagent_session: parsed.subagent_session,
            status: parsed.status,
          });
        }
        req.__orchBody = parsed;
        r(parsed);
      } catch { req.__orchBody = {}; r({}); }
    });
  });
}

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
const configRoute = require('./routes/config');
const analyticsRoute = require('./routes/analytics');
const onboardRoute = require('./routes/onboard');
const sessionRoute = require('./routes/session');
const execRoute = require('./routes/exec');
const classifyRoute = require('./routes/classify');
const uiRoute = require('./routes/ui');
const usageRoute = require('./routes/usage');
const subconsciousRoute = require('./routes/subconscious');

// ctx: live access to daemon state + helpers. State fields use getters so reassignment
// (state = {...} at /reset) is always visible. P3: there is no daemon-global workspace/overlay.
const ctx = {
  get state() { return state; },
  setState(s) { state = s; },
  // setWorkspace REGISTERS a workspace (into workspaces.json) + BINDS it to this session/SSE client
  // + WARMS its overlay into the per-workspace cache. It sets NO daemon-global default — P3 removed
  // that. Per-session binding (state.sessions) survives: the dashboard + change events rely on
  // knowing a client's workspace; only the single global pointer is gone.
  setWorkspace(p, bind = {}) {
    const opts = typeof bind === 'string' ? { transcript: bind } : (bind || {});
    const ov = overlayFor(p);                 // warm + cache this workspace's overlay (no global)
    migrateBlindEdges(p, ov); refreshOverlayStamp(p);
    graphStore.open(require('path').join(p, '.graph'));
    graphStore.initGitAttributes(p);
    git.ensureMergeDriver(p);   // register `ours` driver so `.graph/** merge=ours` takes effect (FU-2 desync guard)
    const transcript = opts.transcript || null;
    const sessionId = sessionBindings.resolveSessionId(opts, transcript);
    if (sessionId) {
      state.sessions = sessionBindings.bindSession(state.sessions, sessionId, {
        transcript, workspace: p, harness: opts.harness,
      });
    }
    // Register the repo into the workspace REGISTRY (workspaces.json) — the source of truth for
    // sweeps + the dashboard switcher. This is registration, NOT a global-default write (the old
    // `workspace` file is gone). `p` is always a repo path; the workspace it joins defaults to
    // basename(p) — a single-repo workspace, preserving today's behavior — unless an explicit
    // bind.workspace names a group. registry.addRepo migrates any legacy v1 array, is atomic, and
    // is idempotent (re-adding the same repo is a no-op).
    try {
      fs.mkdirSync(BASE, { recursive: true });
      const workspace = (opts && opts.workspace) || path.basename(p);
      registry.addRepo(WORKSPACES_FILE, { workspace, repo: p });
    } catch { /* best effort */ }
    const harnessName = opts.harness || (sessionId && state.sessions[sessionId] && state.sessions[sessionId].harness) || 'claude';
    try {
      runUsageReconcile(ctx, { harness: harnessName, workspace: p, session: sessionId || opts.session_id || null });
    } catch { /* advisory cold-path reconcile */ }
    try {
      const adapter = harnessRegistry.get(harnessName);
      if (adapter.usage && adapter.usage.onSessionStart && sessionId) {
        adapter.usage.onSessionStart({ session: sessionId, workspace: p, port: PORT, scheduler: adapter.scheduler });
      }
    } catch { /* advisory scheduler arm */ }
  },
  bindSession(sessionId, patch) {
    if (!sessionId) return;
    state.sessions = sessionBindings.bindSession(state.sessions, sessionId, patch);
  },
  // Workspace-registry ctx contract (consumed by U3 / routes/meta.js):
  //   - WORKSPACES_FILE                : path to the v2 registry file.
  //   - registeredWorkspaces()         : flat Set of REPO PATHS (de-duped, union of registry + active loops).
  //   - loadRegistry(WORKSPACES_FILE)  : the grouped v2 registry { version:2, workspaces:{ name:{ repos:[] } } }
  //                                      (lazily migrates a legacy v1 flat array in place).
  //   - repoToWorkspace(reg)           : Map<repoPath, workspaceName> reverse index over a loaded registry.
  //   - workspaceForRepo(repoPath)     : convenience reverse lookup (loads + indexes the registry), name|null.
  //   - repoRoot(startDir)             : walk up to the containing repo dir (.graph preferred), excludes worktrees.
  loadRegistry: () => registry.loadRegistry(WORKSPACES_FILE),
  repoToWorkspace: registry.repoToWorkspace,
  workspaceForRepo: (repoPath) => registry.repoToWorkspace(registry.loadRegistry(WORKSPACES_FILE)).get(repoPath) || null,
  repoRoot: registry.repoRoot,
  send, sendOp, readBody, notifyChange, buildGraph, targetOverlay, overlayFor, resolveRepo, nodeExistsInGraph, registeredWorkspaces,
  validateMetricSpec, validateBenchmark,
  overlayStore, harness: claudeHarness, harnessRegistry, filedrop, writeTaskStatus, readNativeTask, git, measure, graphStore, analytics, analyticsState, analyticsFlush,
  cache, loops, saveLoops, saveAgents,
  get bootState() { return bootState; },
  GIT_HEAD, BOOTED_AT, FEATURES, PUBLIC, BASE, MCP_CALL, WORKSPACES_FILE, STALE_MINUTES_DEFAULT,
  sseClients, agentsArr,
  taskTranscript, usageCached, harnessTranscriptForTask,
  touchAgent, staleClaimKeys, releaseClaim, reapAgent, sweepStaleClaims, sweepStaleLoops,
  mainTranscriptForSession: (sid) => sessionBindings.mainTranscriptForSession(state, sid),
  sessionCount: () => sessionBindings.sessionCount(state),
  snapshotNative, now, isTruthy,
  embed, embedBatch, embedWithMeta, embeddingMeta, vectorMatchesMeta, cosine, embedStatus, DIMS, EMBED_MODEL,
  gateTask, haikusGate,
  scoreMatchesSemantic, scoreNodeAgainstTokens, suggestToks, suggestForTask,
  SUGGEST_DUP_THRESHOLD, SEMANTIC_DUP_THRESHOLD, SEMANTIC_AUTOWIRE_THRESHOLD,
  autowireNoteProvider, autowireNewTaskWholeGraph, ingestNode, seedBlockingDepContext, noteRagCandidates, RAG_RECALL_THRESHOLD,
  noteCurrentAsOf, gatedSearchCounts, checkGatedRateLimit,
  knowledgeText, digestRejected, leanLearnings,
  respCacheGet, respCachePut, frontier,
  followups, verdicts, stopSignalFor,
  opReplay,
  ALL_STATUSES, ESCALATION_DEFAULTS, OPTIMIZE_DEFAULTS, LOOP_CONFIG_KEYS, CATCHALL_ESCALATE_TOKENS,
  newLoop, decideAll,
  MAX_ROUTES,
  PORT,
};
const routeModules = [
  metaRoute(ctx), graphRoute(ctx), taskRoute(ctx), overlayRoute(ctx),
  gitRoute(ctx), judgeRoute(ctx), labelRoute(ctx), configRoute(ctx), analyticsRoute(ctx), onboardRoute(ctx),
  sessionRoute(ctx), execRoute(ctx), classifyRoute(ctx), usageRoute(ctx), subconsciousRoute(ctx), uiRoute(ctx),
];

function superviseCodexWakeDeliveryForRegisteredWorkspaces() {
  try {
    const codex = harnessRegistry.get('codex');
    if (codex && codex.wakeDelivery && typeof codex.wakeDelivery.superviseCodexBridgeWorkspaces === 'function') {
      codex.wakeDelivery.superviseCodexBridgeWorkspaces(registeredWorkspaces());
    }
  } catch { /* advisory wake delivery supervision */ }
}

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

    // Auth gate: when a token is configured, all mutating routes require it.
    // Public reads of the CURRENT workspace + the dashboard stay open; any ?workspace= read is gated too.
    const mutatingRequest = !['GET', 'HEAD', 'OPTIONS'].includes(m);
    const sensitiveRead = p === '/peek'
      || p === '/active-claim'
      || p === '/agents'
      || p === '/events'
      || p === '/next-action'
      || p === '/session-info'
      || p === '/should-stop'
      || p === '/task/adjacent'
      || p === '/task/context'
      || p === '/task/detail'
      || p === '/task/tree'
      || p === '/workspaces'
      || p.startsWith('/agent/')
      || p.startsWith('/guidance')
      || p.startsWith('/git/');
    const protectedPath = p === '/mcp' || mutatingRequest || sensitiveRead;
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
module.exports = { taskTokens, taskTranscript, harnessTranscriptForTask, digestRejected, leanLearnings, isTruthy, scoreMatchesSemantic, scoreNodeAgainstTokens, noteCurrentAsOf, suggestToks, suggestForTask, autowireNoteProvider, autowireNewTaskWholeGraph, ingestNode, seedBlockingDepContext, noteRagCandidates, RAG_RECALL_THRESHOLD, SEMANTIC_AUTOWIRE_THRESHOLD, SEMANTIC_DUP_THRESHOLD, touchAgent, staleClaimKeys, staleSnapshotClaimKeys, releaseSnapshotClaim, staleNativeClaimKeys, releaseNativeClaim, localInProgressCount, staleVerdictKeys, sweepStaleClaims, sweepStaleVerdicts, sweepStaleGuidance, migrateBlindEdges, sessionBindings, worktreeVouchesLive, depSatisfied, vouchedLive, STALE_MINUTES_DEFAULT,
  isPrimaryCheckout, respCacheGet, respCachePut, notifyChange, RESP_TTL, sseClients, nodeExistsInGraph,
  // test hooks (no server side effects): drive a single loop's per-tick decision in isolation.
  decideOne, decideAll, ensureManagedGraphLoops, buildGraph, targetOverlay, sweepFailedTasks, sweepFiledropStubs, registeredWorkspaces, overlayFor, refreshOverlayStamp, __clearOverlayCacheForTest: () => overlayCache.clear(), __setOverlayForTest: (o) => { __testOv = o; if (__testWs !== null) overlayCache.set(__testWs, { ov: o, stamp: overlayStamp(__testWs) }); }, __setWorkspaceForTest: (w) => { __testWs = w; }, __setAgentsForTest: (a) => { state.agents = a; }, __getAgentsForTest: () => state.agents, __getLoopsForTest: () => loops, __setLoopsForTest: (entries) => { loops.clear(); for (const [k, v] of entries) loops.set(k, v); }, __clearLoopsForTest: () => loops.clear() };

if (require.main === module) {
  // Log unhandled promise rejections instead of crashing (Node's default is to exit the process).
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`unhandledRejection: ${(err && err.stack) || err}\n`);
  });

  const server = http.createServer(handler);

  const PORT_BASE = PORT;
  const MAX_PORT_ATTEMPTS = 10;

  // P3: no single global workspace — write/remove the daemon.port discovery file in EVERY
  // registered workspace's .graph so any client (whatever workspace it pins) can find this daemon.
  function writeDaemonPort(port) {
    for (const ws of registeredWorkspaces()) {
      try {
        const graphDir = path.join(ws, '.graph');
        fs.mkdirSync(graphDir, { recursive: true });
        fs.writeFileSync(path.join(graphDir, 'daemon.port'), String(port));
      } catch { /* skip an unwritable/relocated workspace */ }
    }
  }

  function removeDaemonPort() {
    for (const ws of registeredWorkspaces()) {
      try { fs.unlinkSync(path.join(ws, '.graph', 'daemon.port')); } catch { /* already gone */ }
    }
  }

  // Global singleton pidfile: the bound daemon advertises its pid here so the spawner guards
  // (mcp-graph.js / hooks/start-daemon.js hasDaemonProcess) can detect a LIVE daemon cross-platform
  // via process.kill(pid, 0), instead of a `ps` scan that THREW on Windows (no `ps`) and always
  // returned false — which let every slow-ping moment spawn a redundant daemon, piling up zombies.
  const runtimePaths = require('./lib/runtime-paths');
  const DAEMON_PIDFILE = runtimePaths.runtimePath('daemon.pid');
  function writeDaemonPidfile() {
    try {
      fs.mkdirSync(path.dirname(DAEMON_PIDFILE), { recursive: true });
      fs.writeFileSync(DAEMON_PIDFILE, String(process.pid));
    } catch { /* best effort — the guard still falls back to ping */ }
  }
  function removeDaemonPidfile() {
    try {
      // Only remove the pidfile if it is still OURS (a racing successor may have rewritten it).
      if (fs.readFileSync(DAEMON_PIDFILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(DAEMON_PIDFILE);
    } catch { /* already gone / not ours */ }
  }

  let httpsServer = null; // assigned in the listen callback when certs exist; closed on signal
  let server6 = null;     // IPv6 loopback listener — so `localhost` (→ ::1 on Windows) reaches us

  process.on('exit', () => { removeDaemonPort(); removeDaemonPidfile(); }); // 'exit' stays synchronous — port + pidfile cleanup only
  // SIGINT/SIGTERM: release BOTH listening ports at SIGNAL time, not exit time. server.close()
  // alone waits for open connections — and SSE clients hold theirs indefinitely, so exit rode the
  // 5s force-timer while the (previously never-closed) HTTPS listener kept 8788 bound; a relaunch
  // in that window crashed EADDRINUSE (observed twice 2026-06-12). closeAllConnections() drops
  // SSE/keep-alive sockets so a successor can bind within ~1s of the signal.
  ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
    removeDaemonPort();
    removeDaemonPidfile();
    try {
      const codex = harnessRegistry.get('codex');
      if (codex && codex.wakeDelivery && codex.wakeDelivery.defaultSupervisor) codex.wakeDelivery.defaultSupervisor.stopAll();
    } catch { /* best effort */ }
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (httpsServer) {
      try { httpsServer.close(); if (typeof httpsServer.closeAllConnections === 'function') httpsServer.closeAllConnections(); } catch { /* already down */ }
    }
    if (server6) {
      try { server6.close(); if (typeof server6.closeAllConnections === 'function') server6.closeAllConnections(); } catch { /* already down */ }
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
          const pingReq = http.get(`http://127.0.0.1:${port}/ping`, (res) => {
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
          });
          // The incumbent daemon is single-threaded; under load it can accept the socket but not
          // answer /ping promptly. WITHOUT a timeout this GET hung forever, leaving a redundant
          // daemon alive-but-portless — the zombie pile-up behind the Windows console-window storm.
          // Bound the wait: on timeout, assume the bound port is our own busy daemon and exit this
          // redundant instance cleanly rather than hang.
          pingReq.setTimeout(2000, () => {
            pingReq.destroy();
            process.stdout.write(`Daemon already running at port ${port} (busy; /ping timed out) — exiting redundant instance\n`);
            process.exit(0);
          });
          pingReq.on('error', () => {
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
      writeDaemonPidfile(); // advertise our pid for the cross-platform singleton guard (early, pre-loadState)

      // Also bind IPv6 loopback so `localhost` resolves on every OS — Windows resolves it to ::1
      // first, which an IPv4-only bind misses. Best-effort + loopback-only (no 0.0.0.0 exposure).
      try {
        server6 = http.createServer(handler);
        server6.on('error', (e) => { if (e.code !== 'EADDRINUSE') process.stderr.write(`IPv6 loopback listener skipped: ${e.message}\n`); });
        server6.listen(port, '::1');
      } catch (e) { process.stderr.write(`IPv6 loopback listener skipped: ${e.message}\n`); }

      // BIND-EARLY: the port is now held; load state asynchronously so /health (whitelisted
      // through the 503 gate) reports boot progress while everything else gets an honest 503.
      // writeDaemonPort iterates the registered workspaces, so it runs after loadState resolves.
      loadState().then(() => {
        writeDaemonPort(port);
        superviseCodexWakeDeliveryForRegisteredWorkspaces();
      })
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
  setInterval(() => { try { sweepStaleLoops(); ensureManagedGraphLoops(); } catch { /* best effort */ } }, 60000).unref();

  // Headless drain runner: unless ORCH_HEADLESS_DRAINS explicitly opts out, runs due background
  // maintenance drains (learner/judge/label). This is the NO-SESSION path; real ready-task impl
  // work remains session-dispatched. The runner is a self-scheduling pump: graph mutations wake it
  // immediately, successful passes keep it pumping while queues have content, and no_due_drains
  // returns it to idle. A low-frequency idle poll remains as a fallback for external file writes
  // that do not pass through notifyChange(). Governor/backoff limits in lib/headless-drain.js still
  // cap fork rate, token budget, timeouts, and 429/529 retry behavior.
  const HEADLESS_DRAIN_IDLE_POLL_MS =
    (Number(process.env.HEADLESS_DRAIN_IDLE_POLL_MS)
      || Number(process.env.HEADLESS_DRAIN_INTERVAL_MS)
      || 2 * 60 * 1000)
    + Math.floor(Math.random() * 60 * 1000);
  const HEADLESS_DRAIN_CONTINUOUS_DELAY_MS =
    Number(process.env.HEADLESS_DRAIN_CONTINUOUS_DELAY_MS) || 1000;
  const HEADLESS_DRAIN_RETRY_DELAY_MS =
    Number(process.env.HEADLESS_DRAIN_RETRY_DELAY_MS) || 5000;
  let headlessDrainTimer = null;
  let headlessDrainNextAt = 0;
  let headlessDrainRunning = false;
  let headlessDrainWakePending = false;

  function scheduleHeadlessDrain(delayMs, reason) {
    if (!headlessDrain.isHeadlessEnabled()) return;
    const delay = Math.max(0, Number(delayMs) || 0);
    if (headlessDrainRunning) {
      headlessDrainWakePending = true;
      return;
    }
    const nextAt = Date.now() + delay;
    if (headlessDrainTimer && headlessDrainNextAt <= nextAt) return;
    if (headlessDrainTimer) clearTimeout(headlessDrainTimer);
    headlessDrainNextAt = nextAt;
    headlessDrainTimer = setTimeout(() => runHeadlessDrainPump(reason), delay);
    if (headlessDrainTimer && typeof headlessDrainTimer.unref === 'function') headlessDrainTimer.unref();
  }

  function nextHeadlessDrainDelay(result) {
    const backoffUntil = headlessDrain._governor && headlessDrain._governor.backoffUntil;
    if (backoffUntil && Date.now() < backoffUntil) {
      return Math.max(HEADLESS_DRAIN_RETRY_DELAY_MS, backoffUntil - Date.now());
    }
    if (result && result.ran > 0) return HEADLESS_DRAIN_CONTINUOUS_DELAY_MS;
    if (result && result.skipped === 'backoff') {
      return backoffUntil && Date.now() < backoffUntil
        ? Math.max(HEADLESS_DRAIN_RETRY_DELAY_MS, backoffUntil - Date.now())
        : HEADLESS_DRAIN_RETRY_DELAY_MS;
    }
    if (result && (
      result.skipped === 'concurrency_cap'
      || result.skipped === 'global_concurrency_cap'
      || result.skipped === 'global_lease_lock_busy'
      || result.skipped === 'label_in_progress'
    )) {
      return HEADLESS_DRAIN_RETRY_DELAY_MS;
    }
    return HEADLESS_DRAIN_IDLE_POLL_MS;
  }

  async function runHeadlessDrainPump(reason) {
    headlessDrainTimer = null;
    headlessDrainNextAt = 0;
    if (headlessDrainRunning) {
      headlessDrainWakePending = true;
      return;
    }
    headlessDrainRunning = true;
    let result = null;
    try {
      result = await headlessDrain.runDueDrains(state);
    } catch (e) {
      result = { ran: 0, skipped: 'error', error: e && e.message ? e.message : String(e) };
    } finally {
      headlessDrainRunning = false;
    }
    if (headlessDrainWakePending) {
      headlessDrainWakePending = false;
      const hardPause = result && [
        'backoff',
        'iterations_exhausted',
        'token_budget_exhausted',
        'no_backend',
        'flag_off',
      ].includes(result.skipped);
      scheduleHeadlessDrain(hardPause ? nextHeadlessDrainDelay(result) : HEADLESS_DRAIN_CONTINUOUS_DELAY_MS, 'pending-change');
      return;
    }
    scheduleHeadlessDrain(nextHeadlessDrainDelay(result), result && result.skipped ? result.skipped : 'drained');
  }

  requestHeadlessDrainWake = () => scheduleHeadlessDrain(0, 'graph-change');
  scheduleHeadlessDrain(0, 'boot');

  // Periodic claim sweep: release orphaned in_progress claims when no route (buildGraph) is being
  // called — catches the case after a Claude app restart where the user hasn't issued any command
  // yet but old agent claims are blocking work. Matches the loop-sweep cadence (60s).
  // Iterates the REAL set of registered workspaces (workspaces.json, P2b) so per-repo loops don't
  // miss stale claims just because no route is being served for that workspace — never the single
  // daemon-global state.workspace pointer.
  setInterval(() => {
    try {
      for (const ws of registeredWorkspaces()) {
        const ov = overlayFor(ws);
        sweepStaleClaims(ws, ov);
      }
    } catch { /* best effort */ }
  }, 60000).unref();
  // sweepStaleAgents stays global: agent liveness is workspace-agnostic — an agent's heartbeat
  // is a process-level signal, not a workspace-specific one. An agent may serve tasks across
  // multiple workspaces, so a per-workspace agent sweep would incorrectly dead-mark a live
  // cross-workspace worker.
  setInterval(() => { try { sweepStaleAgents(); } catch { /* best effort */ } }, 60000).unref();

  // Periodic orphan-note self-heal: re-wire note nodes that are still orphaned as the graph grows
  // (a zero-match note at creation can gain a real neighbor later). Re-check is side-effect-free —
  // no match ⇒ no edge, no write. Cheap; unref'd so it never holds the process open.
  setInterval(() => { try { sweepOrphanNotes(); } catch { /* best effort */ } }, 300000).unref();
  // sweepFiledropStubs iterates the REAL set of registered workspaces (workspaces.json, P2b) so
  // stub GC covers per-repo loops that target non-default workspaces — never the single daemon-
  // global state.workspace pointer.
  setInterval(() => {
    try {
      for (const ws of registeredWorkspaces()) sweepFiledropStubs(ws);
    } catch { /* best effort */ }
  }, 300000).unref();

  // Heartbeat to MiniLM sidecar every 60s so the sidecar knows the daemon is alive.
  // The sidecar exits if it misses 2 consecutive pings (2 min), keeping its lifecycle
  // tied to the daemon without requiring a clean shutdown signal.
  setInterval(() => { embedPing().catch(() => {}); }, 60000).unref();

  // Graph-store compaction: fold terminal-status nodes' JSONL event files into checkpoint.json
  // so .graph/ stops growing without bound. Covers every workspace store this process has loaded
  // (graphStore.allStores() — P3 removed the single state.graphStore; loadState/setWorkspace open a
  // store per registered workspace). Deduped by dir. One pass ~5 min after boot, then daily.
  function compactGraphStores() {
    const stores = new Map();
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
