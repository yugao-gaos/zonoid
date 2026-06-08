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
const { URL } = require('url');
const nt = require('./lib/native-tasks');
const overlayStore = require('./lib/overlay');
const mcpCore = require('./lib/mcp-core');
const git = require('./lib/git');

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROUTES = 50;
const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks');
const LOOP_FILE = path.join(BASE, 'loop.json');
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

let state = { workspace: null, overlay: overlayStore.EMPTY(), routes: [], agents: {}, mainTranscript: null };
// Persist + restore the workspace, so a daemon respawn (e.g. after a crash/kill) keeps serving
// the same project instead of coming back with no workspace.
const WS_FILE = path.join(BASE, 'workspace');
try { const w = fs.readFileSync(WS_FILE, 'utf8').trim(); if (w) { state.workspace = w; state.overlay = overlayStore.load(w); } } catch { /* none yet */ }

// SSE: push a "changed" event to connected dashboards on every mutation (live updates without polling).
const sseClients = new Set();
function notifyChange() { for (const r of sseClients) { try { r.write('data: changed\n\n'); } catch { sseClients.delete(r); } } }

// Heartbeat loop: the daemon is the decider. The agent polls next_action on a schedule; the
// daemon replies spawn/idle/stop + how long to wait before checking again (adaptive backoff),
// and enforces hard caps so token burn can't run away. Persisted to disk so a daemon restart
// resumes the budget/iteration count mid-run.
let loop = { active: false, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null,
  config: { tokenBudget: 100000, maxIterations: 200, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8 } };
try { Object.assign(loop, JSON.parse(fs.readFileSync(LOOP_FILE, 'utf8'))); } catch { /* fresh */ }
function saveLoop() { try { fs.mkdirSync(BASE, { recursive: true }); fs.writeFileSync(LOOP_FILE, JSON.stringify(loop)); } catch { /* best effort */ } }

function decideAction() {
  if (!loop.active) return { action: 'stop', reason: 'loop not active' };
  loop.iterations++;
  if (loop.real && state.mainTranscript) {                    // real token accounting from the main transcript
    const u = usageCached(state.mainTranscript);
    loop.spent = Math.max(0, (u.total || 0) - loop.baseline);
  } else {
    loop.spent += loop.config.estPerTick;                     // estimate fallback (predictable ceiling)
  }
  const remaining = Math.max(0, loop.config.tokenBudget - loop.spent);
  const base = { iterations: loop.iterations, spent: loop.spent, budget_remaining: remaining };
  if (loop.iterations > loop.config.maxIterations) { loop.active = false; return { ...base, action: 'stop', reason: 'iteration cap reached' }; }
  if (loop.spent > loop.config.tokenBudget) { loop.active = false; return { ...base, action: 'stop', reason: 'token budget exhausted' }; }

  const g = buildGraph(state.workspace);
  const ready = g.tasks.filter((t) => t.status === 'ready');
  const running = g.tasks.filter((t) => t.status === 'in_progress').length;
  const ghostWait = g.tasks.filter((t) => t.status === 'not_ready' && t.deps.some((d) => d.startsWith('ghost:'))).length;

  if (ready.length) return { ...base, action: 'spawn', tasks: ready.slice(0, loop.config.batch).map((t) => ({ key: t.id, label: t.label })), next_poll_seconds: loop.config.minPoll };
  if (running > 0) return { ...base, action: 'idle', reason: 'work in flight', next_poll_seconds: Math.min(loop.config.maxPoll, loop.config.minPoll * 2) };
  if (ghostWait > 0) return { ...base, action: 'idle', reason: 'waiting on cross-workspace dependencies', next_poll_seconds: loop.config.maxPoll };
  // DAG drained. Normally we stop. But if self-planning is opted in AND budget remains, hand the
  // agent a 'plan' tick instead — the planner subagent reads the learnings digest and proposes new
  // initiatives, keeping the loop alive (do NOT clear loop.active). Hard caps above still win.
  if (state.overlay.config.self_plan && remaining > 0) return { ...base, action: 'plan', reason: 'DAG drained; self-planning a next initiative', next_poll_seconds: loop.config.minPoll };
  loop.active = false;
  return { ...base, action: 'stop', reason: 'DAG drained (nothing ready, running, or externally pending)' };
}

const now = () => new Date().toISOString();
const agentsArr = () => Object.values(state.agents);
function baseStatus(s) { return s === 'completed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'pending'; }

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
      .map((e) => ({ ws: e.fromWorkspace || ws, key: e.from, ghost: !!e.fromWorkspace, kind: e.kind === 'context' ? 'context' : 'blocking' }));
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

// Per-task token total. Prefer the assignee agent's own transcript (accurate). Else fall back to
// the task's session transcript (same dir as the main transcript) — but ONLY when that session maps
// to a single task, so we never paint the same conversation-wide total across many tasks. null = unknown.
function taskTokens(key, session, dedicated) {
  const assignee = state.overlay.assignee[key];
  const agent = assignee ? state.agents[assignee] : null;
  let tp = agent && agent.transcript_path;
  if (!tp && dedicated && session && state.mainTranscript) {
    tp = path.join(path.dirname(state.mainTranscript), `${session}.jsonl`);
  }
  if (!tp) return null;
  try { if (!fs.existsSync(tp)) return null; } catch { return null; }
  const u = usageCached(tp);
  return u && typeof u.total === 'number' ? u.total : null;
}

// Build the graph for one workspace: its task nodes + any ghost stubs they reference.
function buildGraph(ws) {
  if (!ws) return { tasks: [], ghosts: [], summary: summaryFor([], []) };
  const R = makeResolver();
  const native = aggregateCached(ws);
  const ghostMap = {}; // "ws|key" -> ghost stub
  const sessionCount = {}; for (const t of native) sessionCount[t.session] = (sessionCount[t.session] || 0) + 1;

  // Stamp lifecycle timestamps in OUR own overlay (current workspace only — the writable store).
  // firstSeen: set once, never overwritten. lastChanged: set on first sight + whenever the
  // effective status changes. lastStatus tracks the value used to detect changes. Not backfilled.
  const own = ws === state.workspace;
  let tsDirty = false;

  const tasks = native.map((t) => {
    const refs = R.depRefs(ws, t.key);
    const deps = [];          // blocking deps (gate readiness + drive layout)
    const context_deps = [];  // non-blocking context providers (summary feeds in)
    for (const d of refs) {
      const bucket = d.kind === 'context' ? context_deps : deps;
      if (d.ws === ws) { bucket.push(d.key); }
      else {
        const gid = `${d.ws}|${d.key}`;
        bucket.push(`ghost:${gid}`);
        if (!ghostMap[gid]) ghostMap[gid] = { workspace: d.ws, key: d.key, label: R.label(d.ws, d.key), status: R.effective(d.ws, d.key) };
      }
    }
    const status = R.effective(ws, t.key);
    let ts = (own && state.overlay.timestamps[t.key]) || null;
    if (own) {
      if (!ts) { ts = { firstSeen: now(), lastChanged: now(), lastStatus: status }; state.overlay.timestamps[t.key] = ts; tsDirty = true; }
      else if (ts.lastStatus !== status) { ts.lastChanged = now(); ts.lastStatus = status; tsDirty = true; }
    }
    return { id: t.key, label: t.label, session: t.session, deps, context_deps, status, note: state.overlay.notes[t.key] || '', agent_id: state.overlay.assignee[t.key] || null, summary: state.overlay.summaries[t.key] || '', git: state.overlay.git[t.key] || null, firstSeen: ts ? ts.firstSeen : null, lastChanged: ts ? ts.lastChanged : null, tokens: taskTokens(t.key, t.session, sessionCount[t.session] === 1) };
  });
  if (tsDirty) { overlayStore.save(state.workspace, state.overlay); notifyChange(); }
  // Append overlay-only NOTE nodes (durable decisions/findings). They are context providers,
  // not real tasks: deps:[] (level-0), status 'note', and excluded from status counts.
  const ovForNotes = own ? state.overlay : overlayStore.load(ws);
  for (const n of Object.values(ovForNotes.note_nodes || {})) {
    tasks.push({ id: 'note:' + n.id, label: n.title, kind: 'note', status: 'note', session: null, deps: [], context_deps: [], note: '', agent_id: null, summary: n.summary });
  }
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
      || p === '/workspace' || p === '/peek' || p === '/config' || p === '/route' || p.startsWith('/agent/') || p.startsWith('/git/');
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
      return send(res, 200, { ok: true, workspace: state.workspace, mainTranscript: !!state.mainTranscript, loop: { active: loop.active, iterations: loop.iterations, spent: loop.spent }, native_format: state.workspace ? nt.formatHealth(state.workspace) : null });
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
      return send(res, 200, { verdicts: verdicts.slice(0, 25), failures, recent });
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

    // Policy: require_review makes the daemon reject `done` unless the task is `tested` first.
    if (p === '/config' && m === 'POST') {
      const b = await readBody(req);
      if (b.require_review != null) state.overlay.config.require_review = !!b.require_review;
      if (b.self_plan != null) state.overlay.config.self_plan = !!b.self_plan; // opt-in self-scheduling (default off)
      overlayStore.save(state.workspace, state.overlay);
      return send(res, 200, { ok: true, config: state.overlay.config });
    }

    // --- git: isolated attempt worktrees (foundation for side-by-side experiments) ---------
    // Initialize git in the current workspace (idempotent). Run once before /git/worktree.
    if (p === '/git/init' && m === 'POST') {
      if (!state.workspace) return send(res, 400, { ok: false, error: 'no workspace set' });
      const r = git.initRepo(state.workspace);
      notifyChange();
      return send(res, 200, r);
    }
    // Report repo state + active attempt worktrees.
    if (p === '/git/status') {
      if (!state.workspace) return send(res, 200, { isRepo: false });
      return send(res, 200, { isRepo: git.isRepo(state.workspace), worktrees: git.listWorktrees(state.workspace) });
    }
    // Create an isolated worktree+branch for a task attempt; record it on the overlay.
    if (p === '/git/worktree' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      if (!state.workspace || !git.isRepo(state.workspace)) return send(res, 409, { ok: false, error: 'workspace is not a git repo: run git_init first' });
      const info = git.createWorktree(state.workspace, b.key);
      overlayStore.setGit(state.overlay, b.key, info);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, info);
    }
    // Remove a task attempt's worktree+branch (idempotent) and drop its overlay record.
    if (p === '/git/worktree/remove' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      if (state.workspace) git.removeWorktree(state.workspace, b.key);
      delete state.overlay.git[b.key];
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true });
    }
    // Merge a winning attempt's branch back into the base branch. The merge half of the judge loop.
    if (p === '/git/merge' && m === 'POST') {
      const b = await readBody(req);
      if (!b.key) return send(res, 400, { ok: false, error: 'key required' });
      if (!state.workspace || !git.isRepo(state.workspace)) return send(res, 409, { ok: false, error: 'workspace is not a git repo: run git_init first' });
      const result = git.mergeBranch(state.workspace, b.key, { message: b.message });
      notifyChange();
      return send(res, 200, result);
    }

    // Add a dependency edge. Local by default; pass fromWorkspace for a ghost (foreign provider).
    // The consumer (`to`) must belong to the current workspace; the edge is stored here.
    if (p === '/overlay/edge' && m === 'POST') {
      const b = await readBody(req);
      if (!b.from || !b.to) return send(res, 400, { ok: false, error: 'from and to required' });
      overlayStore.addEdge(state.overlay, b.from, b.to, b.fromWorkspace, b.kind);
      overlayStore.save(state.workspace, state.overlay);
      notifyChange();
      return send(res, 200, { ok: true, edges: state.overlay.edges.length, ghost: !!b.fromWorkspace, kind: b.kind === 'context' ? 'context' : 'blocking' });
    }

    if (p === '/overlay/status' && m === 'POST') {
      const b = await readBody(req);
      if (!ALL_STATUSES.includes(b.status)) return send(res, 400, { ok: false, error: 'invalid status', allowed: ALL_STATUSES });
      if (b.status === 'done' && state.overlay.config.require_review && state.overlay.status[b.key] !== 'tested')
        return send(res, 409, { ok: false, error: 'review required: task must be "tested" before "done" (require_review policy is on)' });
      overlayStore.setStatus(state.overlay, b.key, b.status, b.note);
      if (b.agent_id) {
        state.overlay.assignee[b.key] = b.agent_id;                          // who's working it (animation)
        // Also surface the worker in the Subagents panel/counter when it claims/finishes a task.
        const a = state.agents[b.agent_id] || { agent_id: b.agent_id, agent_type: b.agent_id, transcript_path: null, startedAt: now(), endedAt: null };
        if (b.status === 'in_progress') { a.state = 'running'; a.endedAt = null; }
        else if (['done', 'tested', 'failed', 'canceled'].includes(b.status)) { a.state = 'done'; a.endedAt = now(); }
        state.agents[b.agent_id] = a;
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
      const STOP = new Set(['the', 'and', 'for', 'task', 'with', 'that', 'this', 'from', 'into', 'use', 'run', 'add', 'all', 'new', 'via', 'its']);
      const toks = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)));
      const tg = toks(`${target.label} ${target.summary || ''}`);
      const linked = new Set([...target.deps, ...target.context_deps]);
      const out = g.tasks
        .filter((x) => x.id !== key && !linked.has(x.id))
        .map((x) => {
          const xt = toks(`${x.label} ${x.summary || ''}`);
          const shared = [...tg].filter((w) => xt.has(w));
          const score = tg.size && xt.size ? shared.length / Math.sqrt(tg.size * xt.size) : 0;
          return { key: x.id, label: x.label, status: x.status, score: Math.round(score * 1000) / 1000, shared: shared.slice(0, 8), suggest_kind: (x.kind === 'note' || x.status === 'done') ? 'context' : 'blocking' };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      return send(res, 200, { task: { id: target.id, label: target.label }, suggestions: out, hint: 'Link DONE matches as kind:context (their summary becomes Tier-1 context); link a true prerequisite as kind:blocking. Skip unrelated ones.' });
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
        assignee,
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

    // Heartbeat loop control.
    if (p === '/loop/start' && m === 'POST') {
      const b = await readBody(req);
      loop.active = true; loop.iterations = 0; loop.spent = 0; loop.startedAt = now();
      loop.real = !!state.mainTranscript;
      loop.baseline = state.mainTranscript ? (usageCached(state.mainTranscript).total || 0) : 0;
      for (const k of ['tokenBudget', 'maxIterations', 'minPoll', 'maxPoll', 'estPerTick', 'batch']) if (b[k] != null) loop.config[k] = b[k];
      saveLoop();
      return send(res, 200, { ok: true, loop });
    }
    if (p === '/loop/stop' && m === 'POST') { loop.active = false; saveLoop(); return send(res, 200, { ok: true }); }
    if (p === '/loop/status') return send(res, 200, loop);
    if (p === '/next-action') { const r = decideAction(); saveLoop(); return send(res, 200, r); }

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
      state.agents[b.agent_id] = { agent_id: b.agent_id, agent_type: b.agent_type || prev.agent_type || 'agent', state: 'running', transcript_path: b.transcript_path || prev.transcript_path || null, startedAt: prev.startedAt || now(), endedAt: null };
      notifyChange();
      return send(res, 200, { ok: true });
    }
    if (p === '/agent/done' && m === 'POST') {
      const b = await readBody(req);
      const a = state.agents[b.agent_id];
      if (!a) return send(res, 404, { ok: false, error: 'unknown agent' });
      a.state = 'done'; a.endedAt = now();
      notifyChange();
      return send(res, 200, { ok: true });
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

const server = http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`orchestrator daemon on http://127.0.0.1:${PORT}\n`));

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
