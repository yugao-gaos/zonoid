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
function aggregateCached(ws) {
  const now = Date.now();
  if (cache.agg.has(ws) && now - (cache.aggAt.get(ws) || 0) < AGG_TTL) return cache.agg.get(ws);
  const v = nt.aggregateWorkspace(ws);
  cache.agg.set(ws, v); cache.aggAt.set(ws, now);
  return v;
}
function usageCached(p) {
  const now = Date.now();
  if (cache.usage.has(p) && now - (cache.usageAt.get(p) || 0) < USAGE_TTL) return cache.usage.get(p);
  const v = readUsage(p);
  cache.usage.set(p, v); cache.usageAt.set(p, now);
  return v;
}
try { fs.watch(TASKS_DIR, { recursive: true }, () => { cache.agg.clear(); cache.aggAt.clear(); }); } catch { /* TTL is the fallback */ }

const ACTION_STATUSES = ['in_progress', 'tested', 'done', 'failed', 'canceled'];
const ALL_STATUSES = ['not_ready', 'ready', ...ACTION_STATUSES];

// The five escalation triggers — the situations where the loop should stop and ask the user
// instead of guessing. All default ON; tunable per-workspace via POST /config { escalation }.
const ESCALATION_DEFAULTS = () => ({ ambiguous_intent: true, irreversible_action: true, low_confidence_high_impact: true, repeated_failure: true, scope_expansion: true });
// Optimize-loop knobs (⑥): epsilon = the per-cycle improvement below which a round counts as
// "diminishing"; diminishing_rounds (K) = how many consecutive sub-epsilon / no-win rounds trigger
// converge / stuck. Tunable per-workspace via POST /config { optimize }. (Budget reuses the loop's
// existing tokenBudget — no separate knob.) Defaults live in lib/optimize.js.
const OPTIMIZE_DEFAULTS = () => ({ ...optimize.DEFAULTS });

let state = { workspace: null, overlay: overlayStore.EMPTY(), routes: [], agents: {}, mainTranscript: null };
// Persist + restore the workspace, so a daemon respawn (e.g. after a crash/kill) keeps serving
// the same project instead of coming back with no workspace.
const WS_FILE = path.join(BASE, 'workspace');
try { const w = fs.readFileSync(WS_FILE, 'utf8').trim(); if (w) { state.workspace = w; state.overlay = overlayStore.load(w); } } catch { /* none yet */ }
// Persist + restore agent records (incl. transcript_path/session) so token attribution survives a restart.
const AGENTS_FILE = path.join(BASE, 'agents.json');
try { const a = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); if (a && typeof a === 'object') state.agents = a; } catch { /* none yet */ }
// Post-restart the daemon can't vouch for any agent it "remembers" as running — demote them so
// the liveness sweep can reclaim their stale claims; a genuinely-live agent re-asserts on its next touch.
for (const x of Object.values(state.agents)) if (x && x.state === 'running') x.state = 'unknown';

// SSE: push a "changed" event to connected dashboards on every mutation (live updates without polling).
const sseClients = new Set();
function notifyChange() { for (const r of sseClients) { try { r.write('data: changed\n\n'); } catch { sseClients.delete(r); } } }

// Heartbeat loop: the daemon is the decider. The agent polls next_action on a schedule; the
// daemon replies spawn/idle/stop + how long to wait before checking again (adaptive backoff),
// and enforces hard caps so token burn can't run away. Persisted to disk so a daemon restart
// resumes the budget/iteration count mid-run.
// Keyed REGISTRY of heartbeat loops (was a singleton `loop`). Each entry is independent — its own
// budget/iterations/session/config — and ONE heartbeat (decideAll) advances them all. Keyed by a UUID
// loopId so /loop/start can INSERT (never clobber) and multiple driving conversations can coexist.
const LOOP_CONFIG_KEYS = ['tokenBudget', 'maxIterations', 'minPoll', 'maxPoll', 'estPerTick', 'batch'];
const STALE_PROGRESS_MIN_DEFAULT = 30;   // a loop with no progress past this many minutes is swept to inactive
function newLoop(over) {
  return { id: null, active: false, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null,
    session: null, lastProgress: null,
    config: { tokenBudget: 100000, maxIterations: 200, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8 },
    ...over };
}
const loops = new Map();   // loopId -> entry
// Restore the registry on boot. Prefer the keyed loops.json; if absent, migrate a legacy singleton
// loop.json into ONE entry (backward compat) so an in-flight run survives the upgrade.
(function restoreLoops() {
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
})();
function saveLoops() { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(LOOPS_FILE, JSON.stringify(Object.fromEntries(loops))); } catch { /* best effort */ } }
function saveAgents() { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(AGENTS_FILE, JSON.stringify(state.agents)); } catch { /* best effort */ } }

// Resolve the TARGET git repo for a task's git op. Precedence (back-compat default = workspace):
//   explicit (request body repo_path) > task's overlay repo field > daemon workspace.
// Lets the loop branch/merge/measure on a repo distinct from the daemon's own workspace.
function resolveRepo(key, explicit) {
  return explicit || (key && state.overlay.repos && state.overlay.repos[key]) || state.workspace;
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
function releaseClaim(key, reason) {
  if (state.overlay.status[key] !== 'in_progress') return false;
  delete state.overlay.status[key];
  state.overlay.notes[key] = String(reason).slice(0, 280);
  // Also revert the native status (start_task wrote it to in_progress via write-through); otherwise
  // the task would still derive as in_progress from its native file. 'pending' = available to retry.
  const i = key.indexOf('/');
  if (i > 0) { try { nt.writeStatus(key.slice(0, i), key.slice(i + 1), 'pending'); } catch { /* best effort */ } }
  return true;
}
// Sweep abandoned claims: an in_progress task whose worker isn't running AND whose status hasn't
// changed for stale_minutes is treated as dead (kill / crash / idle / cross-session / daemon
// restart) and released. Authoritative liveness — survives restart (overlay is persisted) and
// needs no stop hook to fire. Returns true if anything was released.
function sweepStaleClaims() {
  const mins = state.overlay.config.stale_minutes ?? 10;   // ?? not || so an explicit 0 is honored
  const cutoff = Date.now() - mins * 60000;
  let dirty = false;
  for (const [key, st] of Object.entries(state.overlay.status)) {
    if (st !== 'in_progress') continue;
    const agentId = state.overlay.assignee[key];
    const agent = agentId ? state.agents[agentId] : null;
    if (agent && agent.state === 'running') continue;          // live worker — leave it alone
    const ts = state.overlay.timestamps[key];
    if (ts && Date.parse(ts.lastChanged) > cutoff) continue;   // changed recently — give it time
    if (releaseClaim(key, `auto-released: worker '${agentId || '?'}' not running (stale >${mins}m)`)) dirty = true;
  }
  if (dirty) { overlayStore.save(state.workspace, state.overlay); notifyChange(); }
  return dirty;
}

// Is a driving conversation `session` still live? Authoritative, same basis as sweepStaleClaims:
// live iff it has a RUNNING agent, OR an in_progress claim that changed within stale_minutes. A
// session with neither is dead (closed conversation / killed driver). Empty session ⇒ treat as live
// (a manually-started loop with no bound conversation isn't a zombie by this signal alone).
function sessionIsLive(session) {
  if (!session) return true;
  // A running agent in this session, OR a recently-touched in_progress claim owned by an agent in
  // this session, both prove the conversation is still driving work.
  const cutoff = Date.now() - (state.overlay.config.stale_minutes ?? 10) * 60000;
  for (const a of Object.values(state.agents)) {
    if (!a || a.session !== session) continue;
    if (a.state === 'running') return true;
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
    else if (!sessionIsLive(L.session)) reason = `driving session '${L.session}' dead`;
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
function stopSignalFor(session) {
  if (!session) return null;
  const g = buildGraph(state.workspace);
  const claims = g.tasks.filter((t) => t.status === 'in_progress' && t.session === session);
  for (const t of claims) {
    const agent = t.agent_id || state.overlay.assignee[t.id] || null;
    const cr = state.overlay.cancel_requested[t.id] || null;
    const sr = agent ? (state.overlay.stop_requested[agent] || null) : null;
    if (cr || sr) return { task: t.id, agent, reason: cr ? 'cancel_requested' : 'stop_requested', cancel_requested: cr, stop_requested: sr };
  }
  return null;
}

// Collect a problem's judge VERDICTS chronologically (oldest→newest) from its overlay knowledge.
// A verdict is any knowledge item whose value parses to an object carrying a `winner` field (same
// convention the /learnings route uses). Order follows insertion order (attach_knowledge appends),
// which is the round order. Returns [] when the key has none. Pure read of the current overlay.
function verdictsFor(key) {
  const items = (state.overlay.knowledge && state.overlay.knowledge[key]) || [];
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
// round). Returns { task, verdicts } or null. Caller passes the already-built graph.
function pendingOptimizeProblem(g) {
  for (const t of g.tasks) {
    if (t.kind === 'note' || t.status !== 'done' || !t.metric) continue;
    const rec = (state.overlay.optimize && state.overlay.optimize[t.id]) || {};
    if (rec.closed) continue;                                  // already converged/budget/stuck-escalated
    const verdicts = verdictsFor(t.id);
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
function applyOptimize(prob, base, L) {
  const P = prob.task;
  const last = prob.verdicts[prob.verdicts.length - 1];
  const d = optimize.decideOptimize({
    spec: P.metric,
    verdicts: prob.verdicts,
    budgetRemaining: base.budget_remaining,
    config: { ...OPTIMIZE_DEFAULTS(), ...(state.overlay.config.optimize || {}) },
  });
  if (d.decision === 'iterate') {
    overlayStore.setOptimize(state.overlay, P.id, { decision: 'iterate', verdicts: prob.verdicts.length });
    overlayStore.save(state.workspace, state.overlay); notifyChange();
    return { ...base, action: 'optimize', problem: P.id, label: P.label, metric: P.metric.metric,
      reason: d.reason, prior_verdict: last, next_poll_seconds: L.config.minPoll };
  }
  if (d.decision === 'stuck') {
    // Human-gated halt — reuse the escalation queue exactly like request_guidance. Marks closed so
    // the same problem isn't re-escalated every tick; L.active=false stops this loop.
    overlayStore.addGuidance(state.overlay, {
      question: `Optimization of "${P.label}" is stuck — ${d.reason}. Drop it, retry with a new approach, or take over?`,
      context: `metric=${P.metric.metric}; ${prob.verdicts.length} judged round(s), no usable winner. The loop will NOT auto-cancel or replan — your call.`,
      trigger: 'repeated_failure',
    });
    overlayStore.setOptimize(state.overlay, P.id, { closed: true, decision: 'stuck' });
    L.active = false;
    overlayStore.save(state.workspace, state.overlay); notifyChange();
    return { ...base, action: 'await_user', reason: `optimize stuck on ${P.id}: ${d.reason}` };
  }
  // converged | budget — stop iterating THIS problem; let the normal drained logic decide next.
  overlayStore.setOptimize(state.overlay, P.id, { closed: true, decision: d.decision });
  overlayStore.save(state.workspace, state.overlay); notifyChange();
  return null; // fall through to drained→plan/stop
}

// Decide ONE loop L's action this tick. Honors L's own budget/iterations/config/session. Mutates L
// (iterations++, spent, active=false on terminal). `ctx` carries the shared per-tick graph + a
// mutable spawn pool {batch} multiplexed ACROSS loops, so the daemon never spawns more than the
// configured batch total in a single heartbeat. Returns the loop's decision object (no loopId yet).
function decideOne(L, ctx) {
  // Cooperative self-stop (poll EVERY iteration, before anything else): honors a cancel on this
  // loop's claimed task OR a stop on its agent. Self-exits within one tick; registry persisted by caller.
  if (L.active && L.session) {
    const sig = stopSignalFor(L.session);
    if (sig) { L.active = false; return { action: 'stop', reason: 'cooperative stop', stop: sig }; }
  }
  // Escalation gate: an open guidance question outranks everything. Halt the loop and wait for the user.
  if (ctx.pendingGuidance.length) {
    L.active = false;
    return { action: 'await_user', reason: 'awaiting user guidance', questions: ctx.pendingGuidance.map((g) => ({ id: g.id, question: g.question, context: g.context, trigger: g.trigger })) };
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
  const ready = g.tasks.filter((t) => t.status === 'ready');
  const running = g.tasks.filter((t) => t.status === 'in_progress').length;
  const ghostWait = g.tasks.filter((t) => t.status === 'not_ready' && t.deps.some((d) => d.startsWith('ghost:'))).length;

  if (ready.length) {
    // Spawn pool is shared ACROSS loops this tick: take up to min(this loop's batch, pool remaining).
    const take = Math.max(0, Math.min(L.config.batch, ctx.batch.remaining));
    if (take > 0) {
      ctx.batch.remaining -= take;
      L.lastProgress = now();                                 // progress signal for the liveness sweep (task 3)
      return { ...base, action: 'spawn', tasks: ready.slice(0, take).map((t) => ({ key: t.id, label: t.label })), next_poll_seconds: L.config.minPoll };
    }
    // Pool exhausted by earlier loops this tick — idle briefly and retry next heartbeat.
    return { ...base, action: 'idle', reason: 'spawn batch exhausted this tick', next_poll_seconds: L.config.minPoll };
  }
  if (running > 0) return { ...base, action: 'idle', reason: 'work in flight', next_poll_seconds: Math.min(L.config.maxPoll, L.config.minPoll * 2) };
  if (ghostWait > 0) return { ...base, action: 'idle', reason: 'waiting on cross-workspace dependencies', next_poll_seconds: L.config.maxPoll };
  // DAG drained. Metric-driven CONVERGED-VS-ITERATE control (⑥) — unchanged, now per-loop.
  const prob = pendingOptimizeProblem(g);
  if (prob) { const a = applyOptimize(prob, base, L); if (a) return a; }
  if (state.overlay.config.self_plan && remaining > 0) return { ...base, action: 'plan', reason: 'DAG drained; self-planning a next initiative', next_poll_seconds: L.config.minPoll };
  L.active = false;
  return { ...base, action: 'stop', reason: 'DAG drained (nothing ready, running, or externally pending)' };
}

// ONE heartbeat drives the WHOLE registry. Iterate every ACTIVE loop, compute each one's decision
// honoring its own budget/config/session, and return a batched array [{ loopId, action, ... }]. The
// `batch` config multiplexes across loops via a shared per-tick spawn pool (max of the active loops'
// batch settings — generous but bounded). Inactive loops are skipped. Caller persists the registry.
function decideAll() {
  sweepStaleLoops();   // central liveness sweep (same pass): demote dead/exhausted/stalled loops first
  const ctx = {
    graph: buildGraph(state.workspace),
    pendingGuidance: overlayStore.pendingGuidance(state.overlay),
    batch: { remaining: 0 },
  };
  const active = [...loops.values()].filter((L) => L.active);
  ctx.batch.remaining = active.reduce((m, L) => Math.max(m, L.config.batch || 0), 0);
  const out = [];
  for (const L of active) {
    const d = decideOne(L, ctx);
    out.push({ loopId: L.id, ...d });
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
function scoreNodeAgainstTokens(node, qt) {
  const xt = suggestToks(`${node.label} ${node.summary || ''}`);
  const shared = [...qt].filter((w) => xt.has(w));
  const score = qt.size && xt.size ? shared.length / Math.sqrt(qt.size * xt.size) : 0;
  return { shared, score };
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

// Default auto-wire relevance threshold (conservative — err toward FEWER false edges). A newly
// seen task auto-gets a weighted context edge to each context-eligible match scoring >= this.
const DEFAULT_AUTOWIRE_THRESHOLD = 0.25;
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

// Per-task token total. Prefer the assignee agent's own transcript (accurate). Else fall back to a
// same-session harness agent whose run window overlaps the task's claim (the SubagentStart-registered
// record that actually holds transcript_path; the assignee key never matches it directly). Else fall
// back to the task's session transcript — but ONLY when that session maps to a single task, so we
// never paint the same conversation-wide total across many tasks. null = unknown.
function taskTokens(key, session, dedicated, st = state) {
  const assignee = st.overlay.assignee[key];
  const agent = assignee ? st.agents[assignee] : null;
  let tp = agent && agent.transcript_path;
  if (!tp && agent && agent.session && st.mainTranscript) {              // worker registered its own session transcript
    tp = path.join(path.dirname(st.mainTranscript), `${agent.session}.jsonl`);
  }
  if (!tp) tp = harnessTranscriptForTask(st, key, session);             // time-window correlation fallback
  if (!tp && dedicated && session && st.mainTranscript) {                // session dedicated to one task
    tp = path.join(path.dirname(st.mainTranscript), `${session}.jsonl`);
  }
  if (!tp) return null;
  try { if (!fs.existsSync(tp)) return null; } catch { return null; }
  const u = usageCached(tp);
  return u && typeof u.total === 'number' ? u.total : null;
}

// Build the graph for one workspace: its task nodes + any ghost stubs they reference.
function buildGraph(ws) {
  if (!ws) return { tasks: [], ghosts: [], summary: summaryFor([], []) };
  // Release dead/abandoned claims BEFORE reading native, busting the aggregate cache so a reverted
  // native status is reflected in this same build (not one poll later).
  if (ws === state.workspace && sweepStaleClaims()) { cache.agg.delete(ws); cache.aggAt.delete(ws); }
  const R = makeResolver();
  const native = aggregateCached(ws);
  const ghostMap = {}; // "ws|key" -> ghost stub
  const sessionCount = {}; for (const t of native) sessionCount[t.session] = (sessionCount[t.session] || 0) + 1;

  // Stamp lifecycle timestamps in OUR own overlay (current workspace only — the writable store).
  // firstSeen: set once, never overwritten. lastChanged: set on first sight + whenever the
  // effective status changes. lastStatus tracks the value used to detect changes. Not backfilled.
  const own = ws === state.workspace;
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
    let ts = (own && state.overlay.timestamps[t.key]) || null;
    if (own) {
      if (!ts) { ts = { firstSeen: now(), lastChanged: now(), lastStatus: status }; state.overlay.timestamps[t.key] = ts; tsDirty = true; newlySeen.push(t.key); }
      else if (ts.lastStatus !== status) { ts.lastChanged = now(); ts.lastStatus = status; tsDirty = true; }
    }
    return { id: t.key, label: t.label, session: t.session, deps, context_deps, context_weights, status, note: state.overlay.notes[t.key] || '', agent_id: state.overlay.assignee[t.key] || null, summary: state.overlay.summaries[t.key] || '', git: state.overlay.git[t.key] || null, repo: (state.overlay.repos && state.overlay.repos[t.key]) || null, metric: (state.overlay.metrics && state.overlay.metrics[t.key]) || null, measurement: (state.overlay.measurements && state.overlay.measurements[t.key]) || null, benchmark: (state.overlay.benchmarks && state.overlay.benchmarks[t.key]) || null, firstSeen: ts ? ts.firstSeen : null, lastChanged: ts ? ts.lastChanged : null, tokens: taskTokens(t.key, t.session, sessionCount[t.session] === 1) };
  });
  // Append overlay-only NOTE nodes (durable decisions/findings). They are context providers,
  // not real tasks: deps:[] (level-0), status 'note', and excluded from status counts.
  const ovForNotes = own ? state.overlay : overlayStore.load(ws);
  for (const n of Object.values(ovForNotes.note_nodes || {})) {
    tasks.push({ id: 'note:' + n.id, label: n.title, kind: 'note', status: 'note', session: null, deps: [], context_deps: [], note: '', agent_id: null, summary: n.summary });
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
  }
  if (tsDirty || edgesDirty) { overlayStore.save(state.workspace, state.overlay); notifyChange(); }
  const ghosts = Object.values(ghostMap);
  return { tasks, ghosts, summary: summaryFor(tasks, ghosts) };
}

function summaryFor(tasks, ghosts) {
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
    edges: state.overlay.edges.length,
    ghosts: ghosts.length,
    agents: { total: a.length, running: a.filter((x) => x.state === 'running').length, done: a.filter((x) => x.state === 'done').length },
    lastRoute: state.routes[state.routes.length - 1] || null,
  };
}

// Digest a "rejected" ledger of approaches NOT to re-propose: verdict losers (beaten by a winner) plus
// GENUINE dead-end failures. Superseded/duplicate/consolidated failures are replaced work, not dead
// ends, so they are excluded. `labelFor(key)` resolves a task label ('' if unknown). Pure — unit-tested.
// Truthy query-param test for flags like ?compact=1 / =true / =yes (any non-falsey present value).
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
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = (o.message && o.message.usage) || o.usage;
      if (u) { messages++; input += u.input_tokens || 0; output += u.output_tokens || 0; cacheRead += u.cache_read_input_tokens || 0; cacheCreate += u.cache_creation_input_tokens || 0; }
    }
    return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, total: input + output, messages };
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
}
function readBody(req) { return new Promise((r) => { const chunks = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > 1048576) { req.destroy(); return r({}); } chunks.push(c); }); req.on('end', () => { try { const b = Buffer.concat(chunks).toString('utf8'); r(b ? JSON.parse(b) : {}); } catch { r({}); } }); }); }

const handler = async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname, m = req.method;
  try {
    // Auth gate: /mcp + destructive/write endpoints require the token (when one is configured).
    // Default-deny for writes, workspace-targeting, and agent/file-read endpoints (review H1).
    // Public reads of the CURRENT workspace + the dashboard stay open; any ?workspace= read is gated too.
    const protectedPath = p === '/mcp' || p === '/reset' || p.startsWith('/overlay/') || p === '/loop/start' || p === '/loop/stop'
      || p === '/workspace' || p === '/peek' || p === '/config' || p === '/route' || p.startsWith('/agent/') || p.startsWith('/git/')
      || p.startsWith('/guidance') || p === '/supersede';
    if ((protectedPath || u.searchParams.has('workspace')) && m !== 'OPTIONS' && !authed(req, u)) return send(res, 401, { error: 'unauthorized: bearer token required' });

    if (p === '/ping') return send(res, 200, { ok: true, workspace: state.workspace });

    // SSE stream for live dashboard updates.
    if (p === '/events' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write('retry: 3000\n\ndata: changed\n\n');
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 25000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }

    // MCP Streamable HTTP transport — lets this daemon be added as a custom connector
    // (Settings → Connectors → http://localhost:8787/mcp), which unlocks inline MCP Apps UI.
    if (p === '/mcp') {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version', 'Access-Control-Expose-Headers': 'mcp-session-id' };
      if (m === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (m === 'GET') { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); return res.write(': connected\n\n'); }
      if (m === 'POST') {
        const msg = await readBody(req);
        const resp = await mcpCore.handleRpc(msg, { call: MCP_CALL, uiHtml: mcpCore.uiHtml });
        if (resp === undefined) { res.writeHead(202, cors); return res.end(); }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'orchestrator', 'Connection': 'close' });
        return res.end(JSON.stringify(resp));
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (p === '/reset' && m === 'POST') { state = { workspace: state.workspace, overlay: state.workspace ? overlayStore.load(state.workspace) : overlayStore.EMPTY(), routes: [], agents: {}, mainTranscript: state.mainTranscript }; return send(res, 200, { ok: true }); }

    if (p === '/workspace' && m === 'POST') {
      const b = await readBody(req);
      if (!b.path) return send(res, 400, { ok: false, error: 'path required' });
      state.workspace = b.path;
      state.overlay = overlayStore.load(b.path);
      if (b.transcript) state.mainTranscript = b.transcript; // enables real loop token accounting
      try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(WS_FILE, b.path); } catch { /* best effort */ }
      return send(res, 200, { ok: true, workspace: state.workspace });
    }

    // Format-health + status — fails loud if the native task format drifts.
    if (p === '/health') {
      const allLoops = [...loops.values()];
      const loopHealth = { count: allLoops.length, active: allLoops.filter((L) => L.active).length, iterations: allLoops.reduce((s, L) => s + L.iterations, 0), spent: allLoops.reduce((s, L) => s + L.spent, 0) };
      return send(res, 200, { ok: true, workspace: state.workspace, mainTranscript: !!state.mainTranscript, loops: loopHealth, native_format: state.workspace ? nt.formatHealth(state.workspace) : null });
    }

    // Read-only ready set (for the nudge hook + UI; does NOT advance the loop/budget).
    if (p === '/ready') {
      const g = buildGraph(state.workspace);
      return send(res, 200, { ready: g.tasks.filter((t) => t.status === 'ready').map((t) => ({ key: t.id, label: t.label })) });
    }

    // Read-only learnings digest: what the graph has accumulated, for a self-planner to read on a
    // 'plan' tick. Three buckets — verdicts (attempt judgements), failures (failed/canceled tasks),
    // recent (recent completions' summaries). Reads the current workspace overlay/graph; no writes.
    if (p === '/learnings') {
      const ws = u.searchParams.get('workspace') || state.workspace;
      const g = buildGraph(ws);
      const ov = (ws === state.workspace) ? state.overlay : overlayStore.load(ws);
      // (a) Verdicts: knowledge items whose value parses to an object carrying a `winner` field.
      const verdicts = [];
      for (const [key, items] of Object.entries(ov.knowledge || {})) {
        for (const it of (items || [])) {
          let v = it && it.value;
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
          if (v && typeof v === 'object' && 'winner' in v) verdicts.push({ key, verdict: v });
        }
      }
      // (b) Failures: failed/canceled task labels + notes (most recent first by lastChanged).
      const byChanged = (a, b) => String((ov.timestamps[b.id] || {}).lastChanged || '').localeCompare(String((ov.timestamps[a.id] || {}).lastChanged || ''));
      const failures = g.tasks.filter((t) => t.status === 'failed' || t.status === 'canceled')
        .sort(byChanged).slice(0, 25)
        .map((t) => ({ key: t.id, label: t.label, status: t.status, note: ov.notes[t.id] || '' }));
      // (c) Recent: recently-done tasks with their summary (the interface other work pulls).
      const recent = g.tasks.filter((t) => t.status === 'done' && (ov.summaries[t.id] || ''))
        .sort(byChanged).slice(0, 25)
        .map((t) => ({ key: t.id, label: t.label, summary: ov.summaries[t.id] || '' }));
      // (d) Rejected: a digested ledger of approaches NOT to re-propose — verdict losers (beaten by a
      // winner) plus GENUINE dead-end failures (superseded/duplicate/consolidated excluded). Labels
      // resolved from the graph when available.
      const labelFor = (k) => { const t = g.tasks.find((x) => x.id === k); return t ? t.label : ''; };
      const rejected = digestRejected(verdicts, failures, labelFor);
      const full = { verdicts: verdicts.slice(0, 25), failures, recent, rejected };
      // Lean mode (?compact=1): drop the high-volume buckets a planner doesn't need every turn —
      // keeps the digested rejected[] ledger, trims verdicts to the bottom line, drops recent, and
      // collapses failures to a count. Default returns the full payload unchanged.
      const compact = isTruthy(u.searchParams.get('compact'));
      return send(res, 200, compact ? leanLearnings(full) : full);
    }

    // Query-by-text retrieval (rung-1): rank EVERY node (especially note nodes, incl. [ingest]
    // knowledge) by lexical relevance to a free-text query — no anchor task needed. Reuses the
    // same token scorer as /task/suggest (scoreNodeAgainstTokens / suggestToks / SUGGEST_STOP).
    // Returns top-k compact { key, title, summary (truncated), score, kind }. Default k=5.
    if (p === '/search') {
      const q = u.searchParams.get('q') || '';
      const k = Math.max(1, Math.min(parseInt(u.searchParams.get('k') || '5', 10) || 5, 50));
      const g = buildGraph(u.searchParams.get('workspace') || state.workspace);
      const qt = suggestToks(q);
      const results = g.tasks
        .map((node) => {
          const { score } = scoreNodeAgainstTokens(node, qt);
          return { key: node.id, title: node.label, summary: String(node.summary || '').slice(0, 200), score: Math.round(score * 1000) / 1000, kind: node.kind || 'task' };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
      return send(res, 200, { query: q, k, results });
    }

    // Read-only in_progress claims (for the PreToolUse gate hook). Optional ?session= filters to
    // claims whose task belongs to that conversation; `claimed` reflects the filtered set.
    if (p === '/active-claim') {
      const g = buildGraph(state.workspace);
      const sid = u.searchParams.get('session');
      const all = g.tasks.filter((t) => t.status === 'in_progress').map((t) => ({ key: t.id, label: t.label, session: t.session, agent_id: t.agent_id }));
      const claims = sid ? all.filter((t) => t.session === sid) : all;
      return send(res, 200, { claimed: claims.length > 0, claims });
    }

    // Enforced cooperative-stop probe for the PreToolUse hook. Maps session -> its claimed
    // in_progress task(s) -> assigned agent, and reports whether the worker should halt because
    // a cancel was requested on the task OR a stop was requested on the agent. Pure read.
    if (p === '/should-stop') {
      const sid = u.searchParams.get('session');
      const sig = stopSignalFor(sid);
      return send(res, 200, sig ? { stop: true, ...sig } : { stop: false });
    }

    // Policy: require_review makes the daemon reject `done` unless the task is `tested` first.
    if (p === '/config' && m === 'POST') {
      const b = await readBody(req);
      if (b.require_review != null) state.overlay.config.require_review = !!b.require_review;
      if (b.self_plan != null) state.overlay.config.self_plan = !!b.self_plan; // opt-in self-scheduling (default off)
      if (b.stale_minutes != null) state.overlay.config.stale_minutes = Number(b.stale_minutes); // liveness sweep threshold (min)
      // Escalation toggles: which triggers warrant pausing for the user. All default ON; pass an
      // `escalation` object to tune any subset (the judge/agent honors these before request_guidance).
      if (b.escalation && typeof b.escalation === 'object') {
        const cur = state.overlay.config.escalation || ESCALATION_DEFAULTS();
        for (const k of Object.keys(ESCALATION_DEFAULTS())) if (b.escalation[k] != null) cur[k] = !!b.escalation[k];
        state.overlay.config.escalation = cur;
      }
      // Optimize-loop knobs (⑥): epsilon (per-cycle improvement floor) + diminishing_rounds (K).
      // Merge any subset onto the defaults (the converged-vs-iterate control sanitizes them again).
      if (b.optimize && typeof b.optimize === 'object') {
        const cur = { ...OPTIMIZE_DEFAULTS(), ...(state.overlay.config.optimize || {}) };
        if (b.optimize.epsilon != null) cur.epsilon = Number(b.optimize.epsilon);
        if (b.optimize.diminishing_rounds != null) cur.diminishing_rounds = Number(b.optimize.diminishing_rounds);
        state.overlay.config.optimize = cur;
      }
      overlayStore.save(state.workspace, state.overlay);
      return send(res, 200, { ok: true, config: state.overlay.config });
    }

    // --- escalation gate: "only stop when the user is needed" -----------------------------
    // Raise a guidance question: queue it AND halt the autonomous loop. The agent/judge calls this
    // (via request_guidance) instead of guessing when it hits a decision the user must make.
    if (p === '/guidance' && m === 'POST') {
      const b = await readBody(req);
      if (!b.question) return send(res, 400, { ok: false, error: 'question required' });
      const id = overlayStore.addGuidance(state.overlay, { question: b.question, context: b.context, trigger: b.trigger });
      for (const L of loops.values()) L.active = false; saveLoops();   // workspace-wide gate: halt every loop until the user answers
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, id });
    }
    // List unresolved guidance (what the loop is waiting on). Read-only.
    if (p === '/guidance' && m === 'GET') {
      return send(res, 200, { pending: overlayStore.pendingGuidance(state.overlay) });
    }
    // Resolve a guidance item with the user's answer, clearing the halt for that question.
    if (p === '/guidance/resolve' && m === 'POST') {
      const b = await readBody(req);
      if (!b.id) return send(res, 400, { ok: false, error: 'id required' });
      const ok = overlayStore.resolveGuidance(state.overlay, b.id, b.answer);
      if (!ok) return send(res, 404, { ok: false, error: 'unknown guidance id' });
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, pending: overlayStore.pendingGuidance(state.overlay).length });
    }

    // --- replan reconciliation: supersede an old task with its replacement -----------------
    // Cancel the OLD task (with a note pointing at NEW) and link old->new via a supersede edge, so
    // a replan reads as old→new instead of leaving orphaned canceled duplicates beside fresh ones.
    if (p === '/supersede' && m === 'POST') {
      const b = await readBody(req);
      if (!b.old_key || !b.new_key) return send(res, 400, { ok: false, error: 'old_key and new_key required' });
      const note = `superseded by ${b.new_key}${b.reason ? ': ' + b.reason : ''}`;
      overlayStore.setStatus(state.overlay, b.old_key, 'canceled', note);
      overlayStore.addEdge(state.overlay, b.old_key, b.new_key, null, 'supersede');
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, old_key: b.old_key, new_key: b.new_key });
    }

    // --- git: isolated attempt worktrees (foundation for side-by-side experiments) ---------
    // Each /git/* op targets a repo resolved by resolveRepo(key, explicit): explicit repo_path >
    // task's overlay repo field > daemon workspace. Lets the loop run on an arbitrary repo distinct
    // from the daemon's own workspace; absent any override it stays the workspace (back-compat).
    //
    // Set/clear the target repo path a task's git ops run against (persisted on the overlay).
    if (p === '/git/repo' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      overlayStore.setRepo(state.overlay, b.key, b.repo_path);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, key: b.key, repo: state.overlay.repos[b.key] || null });
    }
    // Initialize git in the target repo (idempotent). Run once before /git/worktree.
    if (p === '/git/init' && m === 'POST') {
      const b = await readBody(req);
      const repo = resolveRepo(b.key, b.repo_path);
      if (!repo) return send(res, 400, { ok: false, error: 'no repo: set a workspace or pass repo_path' });
      const r = git.initRepo(repo);
      notifyChange();
      return send(res, 200, { ...r, repo });
    }
    // Report repo state + active attempt worktrees for the target repo.
    if (p === '/git/status') {
      const repo = resolveRepo(u.searchParams.get('key'), u.searchParams.get('repo_path'));
      if (!repo) return send(res, 200, { isRepo: false });
      return send(res, 200, { repo, isRepo: git.isRepo(repo), worktrees: git.listWorktrees(repo) });
    }
    // Create an isolated worktree+branch for a task attempt; record it on the overlay.
    if (p === '/git/worktree' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      const repo = resolveRepo(b.key, b.repo_path);
      if (!repo || !git.isRepo(repo)) return send(res, 409, { ok: false, error: 'target repo is not a git repo: run git_init first' });
      const info = git.createWorktree(repo, b.key);
      overlayStore.setGit(state.overlay, b.key, info);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ...info, repo });
    }
    // Remove a task attempt's worktree+branch (idempotent) and drop its overlay record.
    if (p === '/git/worktree/remove' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      const repo = resolveRepo(b.key, b.repo_path);
      if (repo) git.removeWorktree(repo, b.key);
      delete state.overlay.git[b.key];
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true });
    }
    // Merge a winning attempt's branch back into the base branch. The merge half of the judge loop.
    if (p === '/git/merge' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      const repo = resolveRepo(b.key, b.repo_path);
      if (!repo || !git.isRepo(repo)) return send(res, 409, { ok: false, error: 'target repo is not a git repo: run git_init first' });
      const result = git.mergeBranch(repo, b.key, { message: b.message });
      notifyChange();
      return send(res, 200, result);
    }

    // --- metric-driven loop: inline metric spec on a task/problem node ----------------------
    // Set/clear the INLINE metric spec a task is optimizing. The measure node (later) runs
    // measure_command in the attempt's worktree and parses a number via `parse`; the judge weighs
    // `metric` in `direction`. Absent ⇒ rationale-only judging (back-compat). Pass a falsy spec to
    // clear. Validated: { metric, direction∈{min,max}, measure_command } required; parse/target/
    // guardrails optional. Each guardrail (if any) must itself carry metric/direction/measure_command.
    if (p === '/task/metric' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      if (b.spec) {
        const err = validateMetricSpec(b.spec);
        if (err) return send(res, 400, { ok: false, error: err });
      }
      overlayStore.setMetricSpec(state.overlay, b.key, b.spec || null);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, key: b.key, metric: state.overlay.metrics[b.key] || null });
    }

    // Set/clear the researched competitor/industry-average BENCHMARK for a task's metric — the
    // EXTERNAL axis the judge compares the winning attempt's measured value against (beyond our own
    // baseline). A record is { metric, value (number), unit?, source, note?, confidence?, researched_at? }.
    // Absent ⇒ baseline-only judging (back-compat). Pass a falsy benchmark to clear. Validated:
    // metric/value/source required; an invalid record is rejected (400) leaving any prior benchmark untouched.
    if (p === '/task/benchmark' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      if (b.benchmark) {
        const err = validateBenchmark(b.benchmark);
        if (err) return send(res, 400, { ok: false, error: err });
      }
      overlayStore.setBenchmark(state.overlay, b.key, b.benchmark || null);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, key: b.key, benchmark: state.overlay.benchmarks[b.key] || null });
    }

    // Run the task's metric spec and store the measured value(s) on the node — the MEASURE half of
    // the metric-driven loop. Resolves the repo via resolveRepo (NO workspace hardcode) and runs in
    // the attempt's worktree (createWorktree gives the existing one) by default; pass baseline:true to
    // measure the repo's current main (repo root, no attempt) and store it as the judge's reference.
    // Surfaces the measured value(s) on the task node + /task/detail (overlay measurements[key]).
    if (p === '/task/measure' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      const spec = state.overlay.metrics && state.overlay.metrics[b.key];
      if (!spec) return send(res, 409, { ok: false, error: 'no metric spec on task: set one with set_task_metric first' });
      const repo = resolveRepo(b.key, b.repo_path);
      if (!repo || !git.isRepo(repo)) return send(res, 409, { ok: false, error: 'target repo is not a git repo: run git_init first' });
      // Baseline = repo root (current main, no attempt); attempt = the task's isolated worktree.
      const cwd = b.baseline ? repo : git.createWorktree(repo, b.key).worktree;
      let result;
      try { result = measure.runMeasure(cwd, spec); }
      catch (e) { return send(res, 422, { ok: false, error: String(e.message || e) }); }
      const record = { ...result, command: spec.measure_command, measured_at: new Date().toISOString() };
      overlayStore.setMeasurement(state.overlay, b.key, b.baseline ? { baseline: record } : record);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, key: b.key, baseline: !!b.baseline, repo, measurement: state.overlay.measurements[b.key] });
    }

    // Add a dependency edge. Local by default; pass fromWorkspace for a ghost (foreign provider).
    // The consumer (`to`) must belong to the current workspace; the edge is stored here.
    if (p === '/overlay/edge' && m === 'POST') {
      const b = await readBody(req);
      if (!b.from || !b.to) return send(res, 400, { ok: false, error: 'from and to required' });
      overlayStore.addEdge(state.overlay, b.from, b.to, b.fromWorkspace, b.kind, b.weight);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, edges: state.overlay.edges.length, ghost: !!b.fromWorkspace, kind: b.kind === 'context' ? 'context' : 'blocking' });
    }

    // Remove a dependency edge (idempotent). Mirrors /overlay/edge add. Optional kind narrows the
    // match ('blocking'|'context'); omit to drop every edge from->to. Lets a graph re-parallelize.
    if (p === '/overlay/edge/remove' && m === 'POST') {
      const b = await readBody(req);
      if (!b.from || !b.to) return send(res, 400, { ok: false, error: 'from and to required' });
      const before = state.overlay.edges.length;
      overlayStore.removeEdge(state.overlay, b.from, b.to, b.fromWorkspace, b.kind);
      const removed = before - state.overlay.edges.length;
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, removed, edges: state.overlay.edges.length });
    }

    if (p === '/overlay/status' && m === 'POST') {
      const b = await readBody(req);
      if (!ALL_STATUSES.includes(b.status)) return send(res, 400, { ok: false, error: 'invalid status', allowed: ALL_STATUSES });
      if (b.status === 'done' && state.overlay.config.require_review && state.overlay.status[b.key] !== 'tested')
        return send(res, 409, { ok: false, error: 'review required: task must be "tested" before "done" (require_review policy is on)' });
      const cur = state.overlay.status[b.key];
      // Optimistic concurrency: caller may pin the status it observed. If the overlay has since
      // moved on (another session/agent wrote it), reject with 409 so the stale writer re-reads
      // instead of clobbering (last-write-wins was the live-collision bug). expected_status may be
      // null/'' to assert "no prior status".
      if (b.expected_status !== undefined && (cur || null) !== (b.expected_status || null))
        return send(res, 409, { ok: false, error: 'stale write: status changed under you', current: cur || null, expected: b.expected_status || null });
      // cancel-wins: 'canceled' is terminal. A late heartbeat trying to resume work (-> in_progress)
      // must not silently override a human cancel. Require explicit force/reopen to leave canceled.
      if (cur === 'canceled' && b.status !== 'canceled' && !b.force && !b.reopen)
        return send(res, 409, { ok: false, error: 'task is canceled (terminal): pass force/reopen to override', current: cur, attempted: b.status });
      // claim-steal guard (CAS on ownership): a claim (-> in_progress, with an agent_id) must not
      // silently steal a task already in_progress under a DIFFERENT agent. This was the live-collision
      // bug — two workers each wrote in_progress, last-write-won the assignee. Refuse with 409 unless
      // force:true (an explicit takeover). Re-claim by the same agent is a no-op pass-through.
      if (b.status === 'in_progress' && b.agent_id && cur === 'in_progress' && !b.force) {
        const owner = state.overlay.assignee[b.key];
        if (owner && owner !== b.agent_id)
          return send(res, 409, { ok: false, error: 'task is already in_progress by another agent: pass force to take over', current: cur, owner, attempted_by: b.agent_id });
      }
      // Record an advisory cancel-requested flag so an in-flight worker can observe it and stop
      // cooperatively even before its own write lands.
      if (b.status === 'canceled') state.overlay.cancel_requested[b.key] = now();
      else if ((b.force || b.reopen) && cur === 'canceled') delete state.overlay.cancel_requested[b.key];
      overlayStore.setStatus(state.overlay, b.key, b.status, b.note);
      if (b.agent_id) {
        state.overlay.assignee[b.key] = b.agent_id;                          // who's working it (animation)
        // Also surface the worker in the Subagents panel/counter when it claims/finishes a task.
        const a = state.agents[b.agent_id] || { agent_id: b.agent_id, agent_type: b.agent_id, transcript_path: null, startedAt: now(), endedAt: null };
        if (b.status === 'in_progress') { a.state = 'running'; a.endedAt = null; }
        else if (['done', 'tested', 'failed', 'canceled'].includes(b.status)) { a.state = 'done'; a.endedAt = now(); }
        state.agents[b.agent_id] = a; saveAgents();
      }
      if (b.summary != null) state.overlay.summaries[b.key] = String(b.summary).slice(0, 2000); // on-complete interface
      overlayStore.save(state.workspace, state.overlay);
      // Write-through to the native task file so ~/.claude/tasks doesn't drift from the overlay.
      // Daemon writes via fs (no edit-gate), best-effort. Map overlay status -> native; skip the rest.
      const NATIVE_STATUS = { in_progress: 'in_progress', done: 'completed', tested: 'completed' };
      const ns = NATIVE_STATUS[b.status];
      if (ns && b.key) { const i = String(b.key).indexOf('/'); if (i > 0) nt.writeStatus(b.key.slice(0, i), b.key.slice(i + 1), ns); }
      notifyChange();
      return send(res, 200, { ok: true });
    }

    // Attach a Tier-2 knowledge item (file/snippet/link/note) to a task.
    if (p === '/overlay/knowledge' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key || !b.item) return send(res, 400, { ok: false, error: 'key and item required' });
      (state.overlay.knowledge[b.key] = state.overlay.knowledge[b.key] || []).push(b.item);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, count: state.overlay.knowledge[b.key].length });
    }

    // Create an overlay-only NOTE node: durable decision/finding captured as a Tier-1 context
    // provider in the graph (NOT a native todo). Surfaces via buildGraph + context edges.
    if (p === '/overlay/note' && m === 'POST') {
      const b = await readBody(req);
      if (!b.title || !b.summary) return send(res, 400, { ok: false, error: 'title and summary required' });
      const id = overlayStore.addNoteNode(state.overlay, b);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, id, key: 'note:' + id });
    }

    // Tier 1 (cheap): a task's base context = its dependencies' summaries — BOTH blocking deps
    // and non-blocking context edges (the latter let it inherit completed nodes' summaries).
    if (p === '/task/context') {
      const g = buildGraph(u.searchParams.get('workspace') || state.workspace);
      const t = g.tasks.find((x) => x.id === u.searchParams.get('key'));
      if (!t) return send(res, 404, { ok: false, error: 'unknown task' });
      const mk = (d, kind) => { const dep = g.tasks.find((x) => x.id === d); return { key: d, label: dep ? dep.label : d, status: dep ? dep.status : '?', summary: (dep && dep.summary) || state.overlay.summaries[d] || '', via: kind }; };
      const summaries = [
        ...t.deps.filter((d) => !d.startsWith('ghost:')).map((d) => mk(d, 'blocking')),
        ...t.context_deps.filter((d) => !d.startsWith('ghost:')).map((d) => mk(d, 'context')),
      ];
      const allGhostRefs = [...t.deps, ...t.context_deps];
      const ghost = g.ghosts.filter((gh) => allGhostRefs.includes(`ghost:${gh.workspace}|${gh.key}`)).map((gh) => ({ workspace: gh.workspace, key: gh.key, label: gh.label, status: gh.status }));
      return send(res, 200, { task: { id: t.id, label: t.label, status: t.status }, dependencySummaries: summaries, ghostDependencies: ghost });
    }

    // Suggest existing tasks (INCLUDING completed) a task should link to, by token overlap of
    // label + summary. Completed matches → context edges (summary becomes Tier-1 context);
    // open matches the agent may promote to blocking. Call after TaskCreate to avoid orphan roots.
    if (p === '/task/suggest') {
      const ws = u.searchParams.get('workspace') || state.workspace;
      const g = buildGraph(ws);
      const key = u.searchParams.get('key');
      const target = g.tasks.find((x) => x.id === key);
      if (!target) return send(res, 404, { ok: false, error: 'unknown task' });
      const out = scoreMatches(g, target).slice(0, 5);
      const duplicates = out.filter((c) => c.duplicate).map((c) => c.key);
      let hint = 'Link DONE matches as kind:context (their summary becomes Tier-1 context); link a true prerequisite as kind:blocking. Skip unrelated ones.';
      if (duplicates.length) hint = `WARNING: this looks like a near-duplicate of OPEN task(s) ${duplicates.join(', ')}. If it is the same work re-planned, do NOT keep both — call supersede_task(old_task_key=<existing>, new_task_key=${target.id}) so the graph reconciles old→new instead of leaving orphaned duplicates. ` + hint;
      return send(res, 200, { task: { id: target.id, label: target.label }, suggestions: out, duplicates, hint });
    }

    // Vertical traversal: walk UP the dependency chain (transitive deps / deps-of-deps),
    // returning each ancestor with its summary + depth. Cheap (summaries only). Ghost deps
    // are a frontier (not auto-expanded across workspaces — use /peek on demand).
    if (p === '/task/tree') {
      const key = u.searchParams.get('key');
      const maxDepth = Math.min(parseInt(u.searchParams.get('depth') || '6', 10) || 6, 25);
      const g = buildGraph(u.searchParams.get('workspace') || state.workspace);
      const byId = Object.fromEntries(g.tasks.map((t) => [t.id, t]));
      const root = byId[key];
      if (!root) return send(res, 404, { ok: false, error: 'unknown task' });
      const ancestors = [], ghostFrontier = [], seen = new Set([key]);
      let frontier = [{ key, depth: 0 }];
      while (frontier.length) {
        const next = [];
        for (const { key: k, depth } of frontier) {
          if (depth >= maxDepth) continue;
          const t = byId[k];
          if (!t) continue;
          for (const d of t.deps) {
            if (d.startsWith('ghost:')) {
              const gh = g.ghosts.find((x) => `${x.workspace}|${x.key}` === d.slice('ghost:'.length));
              if (gh) ghostFrontier.push({ workspace: gh.workspace, key: gh.key, label: gh.label, status: gh.status, via: k, depth: depth + 1 });
              continue;
            }
            if (seen.has(d)) continue;
            seen.add(d);
            const dep = byId[d];
            if (!dep) continue;
            ancestors.push({ key: dep.id, label: dep.label, status: dep.status, summary: state.overlay.summaries[dep.id] || '', depth: depth + 1, via: k });
            next.push({ key: d, depth: depth + 1 });
          }
        }
        frontier = next;
      }
      return send(res, 200, { root: { key: root.id, label: root.label, status: root.status }, maxDepth, ancestors, ghostFrontier });
    }

    // Tier 2 (on demand): full detail for one task — knowledge, summary, assignee, token usage.
    if (p === '/task/detail') {
      const key = u.searchParams.get('key');
      const g = buildGraph(u.searchParams.get('workspace') || state.workspace);
      const t = g.tasks.find((x) => x.id === key);
      if (!t) return send(res, 404, { ok: false, error: 'unknown task' });
      const assignee = state.overlay.assignee[key] || null;
      const agent = assignee ? state.agents[assignee] : null;
      return send(res, 200, {
        task: t,
        summary: state.overlay.summaries[key] || '',
        knowledge: state.overlay.knowledge[key] || [],
        git: state.overlay.git[key] || null,
        repo: (state.overlay.repos && state.overlay.repos[key]) || null,
        metric: (state.overlay.metrics && state.overlay.metrics[key]) || null,
        measurement: (state.overlay.measurements && state.overlay.measurements[key]) || null,
        benchmark: (state.overlay.benchmarks && state.overlay.benchmarks[key]) || null,
        assignee,
        cancel_requested: state.overlay.cancel_requested[key] || null,  // advisory cooperative-cancel flag
        tokenUsage: agent && agent.transcript_path ? usageCached(agent.transcript_path) : null,
        transcript: agent ? agent.transcript_path : null,
      });
    }

    // On-demand: load another workspace's full graph without changing the current one.
    if (p === '/peek') {
      const ws = u.searchParams.get('workspace');
      if (!ws) return send(res, 400, { ok: false, error: 'workspace required' });
      return send(res, 200, buildGraph(ws));
    }

    if (p === '/task/adjacent') {
      const key = u.searchParams.get('key');
      const g = buildGraph(u.searchParams.get('workspace') || state.workspace);
      const t = g.tasks.find((x) => x.id === key);
      if (!t) return send(res, 404, { ok: false, error: 'unknown task', key });
      const deps = g.tasks.filter((x) => t.deps.includes(x.id));
      const ghostDeps = g.ghosts.filter((gh) => t.deps.includes(`ghost:${gh.workspace}|${gh.key}`));
      const dependents = g.tasks.filter((x) => x.deps.includes(key));
      return send(res, 200, { task: t, dependencies: deps, ghostDependencies: ghostDeps, dependents });
    }

    // Heartbeat loop control. The registry is KEYED by loopId — /loop/start INSERTS a fresh entry
    // (never clobbers an existing one), so concurrent driving conversations each get their own loop.
    if (p === '/loop/start' && m === 'POST') {
      const b = await readBody(req);
      // Accept a caller-supplied loopId (idempotent restart) or mint one. If it already exists we
      // RESET that entry in place rather than refusing — but we never overwrite a DIFFERENT loop.
      const loopId = (b.loopId && String(b.loopId)) || crypto.randomUUID();
      const L = newLoop({ id: loopId });
      L.active = true; L.startedAt = now(); L.lastProgress = now();
      L.session = b.session || null;   // the conversation driving this loop — addresses its cooperative-stop signal
      L.real = !!state.mainTranscript;
      L.baseline = state.mainTranscript ? (usageCached(state.mainTranscript).total || 0) : 0;
      for (const k of LOOP_CONFIG_KEYS) if (b[k] != null) L.config[k] = b[k];
      loops.set(loopId, L);
      saveLoops();
      return send(res, 200, { ok: true, loopId, loop: L });
    }
    if (p === '/loop/stop' && m === 'POST') {
      const b = await readBody(req);
      const loopId = b.loopId || u.searchParams.get('loopId');
      if (!loopId) return send(res, 400, { ok: false, error: 'loopId required' });
      const L = loops.get(loopId);
      if (!L) return send(res, 404, { ok: false, error: 'unknown loopId', loopId });
      L.active = false; saveLoops();
      return send(res, 200, { ok: true, loopId });
    }
    if (p === '/loop/status') {
      const loopId = u.searchParams.get('loopId');
      if (loopId) {
        const L = loops.get(loopId);
        if (!L) return send(res, 404, { ok: false, error: 'unknown loopId', loopId });
        return send(res, 200, L);
      }
      return send(res, 200, { loops: Object.fromEntries(loops) });
    }
    if (p === '/next-action') { const r = decideAll(); saveLoops(); return send(res, 200, { loops: r }); }

    if (p === '/route' && m === 'POST') {
      const b = await readBody(req);
      state.routes.push({ ts: now(), prompt: String(b.prompt || '').slice(0, 280), decision: b.decision || 'solo', reason: String(b.reason || '').slice(0, 280) });
      if (state.routes.length > MAX_ROUTES) state.routes.shift();
      return send(res, 200, { ok: true });
    }

    if (p === '/agent/start' && m === 'POST') {
      const b = await readBody(req);
      if (!b.agent_id) return send(res, 400, { ok: false, error: 'agent_id required' });
      const prev = state.agents[b.agent_id] || {};
      // Capture task/session/workspace so a colliding worker is visible across sessions (GET /agents).
      state.agents[b.agent_id] = { agent_id: b.agent_id, agent_type: b.agent_type || prev.agent_type || 'agent', state: 'running', transcript_path: b.transcript_path || prev.transcript_path || null, task: b.task || prev.task || null, session: b.session || prev.session || null, workspace: b.workspace || prev.workspace || state.workspace || null, startedAt: prev.startedAt || now(), endedAt: null };
      saveAgents();
      notifyChange();
      return send(res, 200, { ok: true });
    }
    if (p === '/agent/done' && m === 'POST') {
      const b = await readBody(req);
      const a = state.agents[b.agent_id];
      if (!a) return send(res, 404, { ok: false, error: 'unknown agent' });
      a.state = 'done'; a.endedAt = now();
      // Cascade: release any in_progress task this agent still holds (it stopped without completing),
      // so the claim doesn't linger as a phantom in_progress. Fixes the stale-status bug directly.
      let released = 0;
      for (const [key, st] of Object.entries(state.overlay.status))
        if (st === 'in_progress' && state.overlay.assignee[key] === b.agent_id
            && releaseClaim(key, `auto-released: agent '${b.agent_id}' stopped without completing`)) released++;
      if (released) overlayStore.save(state.workspace, state.overlay);
      saveAgents();
      notifyChange();
      return send(res, 200, { ok: true, released });
    }

    // Cross-session visibility: list every known agent with task/session/workspace/startedAt and
    // its current cooperative-stop flag, so one session can SEE a worker running in another.
    if (p === '/agents') {
      const list = agentsArr().map((a) => ({
        agent_id: a.agent_id, agent_type: a.agent_type, state: a.state,
        task: a.task || null, session: a.session || null, workspace: a.workspace || null,
        startedAt: a.startedAt || null, endedAt: a.endedAt || null,
        stop_requested: state.overlay.stop_requested[a.agent_id] || null,
      }));
      return send(res, 200, { agents: list });
    }

    // Cooperative stop: raise an advisory stop flag for a worker (by agent_id, or by task_key via
    // its assignee). No cross-process kill — the worker is expected to poll /agents (or
    // /agent/stop-requested) and self-terminate. Returns the resolved agent or 404.
    if (p === '/agent/stop' && m === 'POST') {
      const b = await readBody(req);
      let agentId = b.agent_id || null;
      if (!agentId && b.task_key) agentId = state.overlay.assignee[b.task_key] || agentsArr().find((a) => a.task === b.task_key)?.agent_id || null;
      if (!agentId) return send(res, 404, { ok: false, error: 'no agent for that agent_id/task_key' });
      state.overlay.stop_requested[agentId] = now();
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, agent_id: agentId, stop_requested: state.overlay.stop_requested[agentId] });
    }
    // A worker polls this to learn whether it should cooperatively stop.
    if (p === '/agent/stop-requested') {
      const id = u.searchParams.get('agent_id');
      if (!id) return send(res, 400, { ok: false, error: 'agent_id required' });
      return send(res, 200, { agent_id: id, stop_requested: state.overlay.stop_requested[id] || null });
    }

    if (p === '/state') {
      const ws = u.searchParams.get('workspace') || state.workspace;
      const g = buildGraph(ws);
      return send(res, 200, { workspace: ws, tasks: g.tasks, ghosts: g.ghosts, edges: state.overlay.edges, routes: state.routes, agents: agentsArr(), summary: g.summary });
    }

    if (p.startsWith('/agent/')) {
      const id = decodeURIComponent(p.slice('/agent/'.length));
      const a = state.agents[id];
      if (!a) return send(res, 404, 'unknown agent', 'text/plain');
      return send(res, 200, `Agent: ${a.agent_id}\nType: ${a.agent_type}\nState: ${a.state}\nTranscript: ${a.transcript_path || '-'}\n\n--- output ---\n${a.transcript_path ? readTranscript(a.transcript_path) : '(no transcript path)'}`, 'text/plain; charset=utf-8');
    }

    if ((p === '/' || p === '/graph') && m === 'GET') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'graph.html'), 'utf8'), 'text/html; charset=utf-8');
    return send(res, 404, { error: 'not found', path: p });
  } catch (e) {
    return send(res, 500, { error: String((e && e.stack) || e) });
  }
};

// Export pure helpers for unit tests (no port binding). When run as the main module the daemon
// still starts its listeners below; when require()d (tests) it just exposes the functions.
module.exports = { taskTokens, harnessTranscriptForTask, digestRejected, leanLearnings, isTruthy, scoreMatches, scoreNodeAgainstTokens, suggestToks, autowireNewTask, DEFAULT_AUTOWIRE_THRESHOLD };

if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, '127.0.0.1', () => process.stdout.write(`orchestrator daemon on http://127.0.0.1:${PORT}\n`));

  // Periodic liveness sweep: reclaim zombie loops even when NO driver is polling next_action (a loop
  // bound to a closed conversation is otherwise never re-evaluated). decideAll already sweeps on each
  // heartbeat; this catches the un-driven case. Cheap; unref'd so it never holds the process open.
  setInterval(() => { try { sweepStaleLoops(); } catch { /* best effort */ } }, 60000).unref();

  // Optional HTTPS listener for the custom-connector path (needs a locally-trusted cert — run
  // scripts/setup-https.sh, which uses mkcert). Off unless cert + key exist. Then connect a
  // custom connector to https://localhost:<ORCH_HTTPS_PORT>/mcp .
  const HTTPS_PORT = process.env.ORCH_HTTPS_PORT ? Number(process.env.ORCH_HTTPS_PORT) : 8788;
  const CERT = process.env.ORCH_TLS_CERT || path.join(BASE, 'certs', 'cert.pem');
  const KEY = process.env.ORCH_TLS_KEY || path.join(BASE, 'certs', 'key.pem');
  try {
    if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
      require('https').createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
        .listen(HTTPS_PORT, '127.0.0.1', () => process.stdout.write(`orchestrator HTTPS on https://127.0.0.1:${HTTPS_PORT}\n`));
    }
  } catch (e) { process.stderr.write(`HTTPS listener skipped: ${e.message}\n`); }
}
