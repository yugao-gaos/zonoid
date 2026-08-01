'use strict';
/**
 * headless-spawn.js — daemon-internal executor for managed graph-loop SPAWN decisions.
 *
 * DESIGN
 * ------
 * Closes the full-autonomy gap: when a MANAGED graph loop (lib/loop-autostart.js — managed:'graph',
 * session:null) decides action:'spawn' and NO interactive session is driving, the daemon dispatches
 * the workers itself via headless LLM-backend children instead of waiting for a /next-action driver
 * that will never come. Real interactive drivers keep priority: the executor runs ONLY in the
 * zero-session regime and ONLY for workspaces that opted in (overlay config `headless_driver:true`,
 * default off).
 *
 * REUSED INFRASTRUCTURE (deliberately no second governor / spawn path)
 * --------------------------------------------------------------------
 *   - lib/headless-drain: the shared governor (_governor, effectiveConfig, backoff via
 *     recordDrainOutcome), the host-wide drain lease (_acquireGlobalDrainSlot), the async child
 *     spawner (runDrain — timeoutMs + SIGKILL bound), and _resolveMcpConfig (shared HTTP MCP).
 *   - lib/headless-drain-runner: the pump. daemon.js instantiates a SECOND runner over this
 *     executor's facade ({ runDueDrains, _governor }), so scheduling/backoff/wake behavior is
 *     identical to the drain pump with zero runner changes.
 *   - daemon decideAll: spawn decisions come from THE SAME decide pass /next-action serves.
 *     decideOne charges the loop (iterations++, estPerTick spend, headroom vs in_progress count)
 *     and acquires the 60s per-task spawn leases — so requirement "charge the loop like
 *     /next-action does" is satisfied by construction: it IS that path, not a reimplementation.
 *   - subconscious prepare: assignments are allocated through POST /subconscious/assignment
 *     (routes/subconscious.js), the same route the MCP `subconscious_assignment prepare` facade
 *     hits — same worktree allocation, same permit minting, same review-state recording.
 *
 * DOUBLE-DISPATCH SAFETY
 * ----------------------
 * The per-task spawn lease (overlay.spawnLease, 60s TTL, released on claim via
 * setStatus→clearSpawnLease) is the exclusivity primitive, exactly as for interactive drivers:
 * decideOne only returns tasks it could lease, and the executor re-verifies per task that the live
 * lease belongs to the deciding loop before dispatch (a foreign live lease ⇒ skip). A worker that
 * dies before claiming leaves the lease to expire (60s) — the task simply becomes spawnable again.
 *
 * WORKER FAILURE HANDLING
 * -----------------------
 * On child timeout/spawn-error/non-zero exit — or a clean exit that left the task in_progress
 * (worker exited without calling complete) — the executor posts the terminal failed status itself
 * (POST /overlay/status, task_result v1 status:'failed') so the task never strands in_progress
 * waiting for the staleness sweep. A task the worker never claimed (still ready) is left alone:
 * the spawn-lease TTL frees it for redispatch.
 *
 * WHY THE EXECUTOR SKIPS ENTIRELY WHILE ANY SESSION LOOP IS ACTIVE
 * ----------------------------------------------------------------
 * decideAll is a GLOBAL heartbeat: calling it leases every spawn decision it returns, including
 * session-bound loops' — consuming those here would stall the interactive driver's dispatch for a
 * lease TTL. And while an interactive session drives, its /next-action polling already serves the
 * managed loops too. So one active session-bound loop anywhere ⇒ the executor stands down.
 */

const path = require('path');
const http = require('http');
const headlessDrain = require('./headless-drain');

// ---- constants -----------------------------------------------------------------------

const SELF_REPO = path.resolve(__dirname, '..');

// Stable drain key for dashboard/telemetry summaries (mirrors the drain-key naming convention).
const SPAWN_EXECUTOR_KEY = 'followup/harness-spawn-executor';

// Minted worker agent ids carry this prefix so claims/registrations are attributable.
const HEADLESS_WORKER_PREFIX = 'headless-worker-';

// Default daemon base URL for internal HTTP (prepare / terminal status) — same shape as
// headless-drain's DAEMON_BASE_URL (not exported there; the sibling drain task owns that file).
const DAEMON_BASE_URL = `http://localhost:${Number(process.env.ORCH_PORT) || 8787}`;

// Per-worker wall-clock timeout. Impl work runs far longer than a judge round (5min) — default
// 30min, overridable. runDrain enforces it with SIGKILL, so a hung worker cannot wedge a slot.
function workerTimeoutMs() {
  return Math.max(60_000, Number(process.env.HEADLESS_SPAWN_TIMEOUT_MS) || 30 * 60 * 1000);
}

// ---- config gate ---------------------------------------------------------------------

// Executor opt-in is per workspace: overlay config `headless_driver:true` (default OFF). Session-
// bound loops are never served here regardless of this flag — they belong to their driver.
function headlessDriverEnabled(overlay) {
  const v = overlay && overlay.config && overlay.config.headless_driver;
  return v === true || v === 1 || v === '1' || v === 'true';
}

// ---- internal daemon HTTP ------------------------------------------------------------
// Small local POST helper (mirrors headless-drain's postDaemonJson, which is not exported — the
// parallel review-drain task owns that file, so we keep our edits there at zero).

function daemonToken() {
  try { return require('./mcp-core').readToken(); } catch { return null; }
}

function postDaemonJson(route, body, httpModule = http) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(route, DAEMON_BASE_URL); } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      return;
    }
    const payload = JSON.stringify(body || {});
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    };
    const token = daemonToken();
    if (token) headers['x-orch-token'] = token;
    const req = httpModule.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        if (res.statusCode >= 400) parsed = { ...parsed, ok: false, status: res.statusCode, error: parsed.error || `HTTP ${res.statusCode}` };
        resolve(parsed);
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err && err.message ? err.message : String(err) }));
    req.end(payload);
  });
}

// ---- worker identity / envelope / prompt ----------------------------------------------

// Deterministic per-task worker id: reused on accept, complete, AND the executor's own failure
// write, so the terminal failed post matches the claim owner.
function workerAgentId(taskKey) {
  return `${HEADLESS_WORKER_PREFIX}${String(taskKey || '').replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

/**
 * Build the typed handoff_envelope (schemas/handoff.v1.schema.json) from the prepare response.
 * Slotted fields are copied from the daemon-allocated assignment — the worker copies them verbatim
 * into its graph calls instead of re-deriving them from prose. context_deps are the pre-resolved
 * Tier-1 dependency summaries the prepare route already assembled (dispatcher duty, not worker's).
 */
function buildHandoffEnvelope({ job, prepare, agentId, siblings }) {
  const a = (prepare && prepare.assignment) || {};
  const pdc = a.progressive_disclosure_context;
  const summaries = (a.context && Array.isArray(a.context.dependency_summaries)) ? a.context.dependency_summaries : [];
  return {
    version: 1,
    task_key: job.key,
    agent_id: agentId,
    branch: prepare.branch || a.branch,
    target_repo: prepare.target_repo || a.target_repo,
    worktree: prepare.worktree || a.worktree,
    base: a.base || null,
    files_in_scope: [],
    plan_goal: (pdc && pdc.layer1 && pdc.layer1.why) || job.label || job.key,
    sibling_tasks: (siblings || []).map((s) => ({ task_key: s.key, title: s.label || s.key })),
    context_deps: summaries
      .filter((d) => d && d.summary)
      .map((d) => ({ task_key: d.key || d.task_key || null, summary: d.summary })),
    return_contract: "task_result v1: {version:1, status:'tested'|'failed', summary, files_changed[], tests_run, decisions[]}",
  };
}

/**
 * The worker contract prompt: accept → implement in the worktree → commit → complete with a
 * task_result v1 (failed on any unrecoverable error). Same duties as an Agent-tool dispatched
 * worker; the envelope carries the slots. The child's cwd is the attempt worktree, and the
 * orchestrator-graph MCP is granted via the shared HTTP mcp-config (_resolveMcpConfig).
 */
function buildWorkerPrompt(envelope) {
  return [
    `You are an orchestrator worker dispatched headlessly by the daemon. Implement graph task ${envelope.task_key}` +
      ` ("${envelope.plan_goal}") in the attempt worktree you are running in.`,
    '',
    'HANDOFF ENVELOPE (copy these slots verbatim into your graph calls — do not re-derive):',
    JSON.stringify(envelope, null, 2),
    '',
    'MANDATORY WORKER PROTOCOL:',
    `1. FIRST call the orchestrator-graph MCP tool subconscious_assignment {action:"accept", task_key:${JSON.stringify(envelope.task_key)}, agent_id:${JSON.stringify(envelope.agent_id)}, session_id:${JSON.stringify(envelope.agent_id)}} BEFORE any file write. If it errors or returns 409, STOP — do not force or work around the gate.`,
    `2. ALL file edits happen inside your cwd (the attempt worktree, branch ${envelope.branch}). Never edit any other checkout.`,
    '3. Before completing: run `git add -A && git commit` in the worktree — uncommitted work makes the later merge a silent no-op.',
    `4. Finish with subconscious_assignment {action:"complete", task_key:${JSON.stringify(envelope.task_key)}, agent_id:${JSON.stringify(envelope.agent_id)}, status:"tested"|"failed", task_result:{version:1, status, summary:"<tight interface summary>", files_changed:[...], tests_run:"<cmd + outcome>", decisions:[]}}. On ANY unrecoverable error still call complete with status:"failed" — never exit silently.`,
    `5. If you record a durable decision via record_decision, pass wires_to:[${JSON.stringify(envelope.task_key)}].`,
  ].join('\n');
}

// ---- backend resolution ----------------------------------------------------------------
// Same shape as headless-drain's resolveJudgeBackend, but for IMPL workers: only agentic-cli
// providers can run one (api providers expose runJudgeLoop — a judge-only loop; there is no API
// code-worker yet), so an api backend HARD-BLOCKS with the same clean 'no_backend' pause as an
// unusable/unauthed CLI. No invocation is built here — the prompt is per-task.

function safeBool(fn) { try { return !!fn(); } catch { return false; } }

function resolveSpawnBackend(overlay, deps = {}) {
  const backendLib = deps.backendLib || require('./llm-backend');
  const active = backendLib.getActiveBackend(overlay);
  const provider = active && active.provider;
  if (!provider) return { skip: 'no_backend' };
  if (provider.kind !== 'agentic-cli') return { skip: 'no_backend' };
  const available = typeof provider.isAvailable === 'function' ? safeBool(provider.isAvailable.bind(provider)) : false;
  const authed = typeof provider.isAuthed === 'function' ? safeBool(provider.isAuthed.bind(provider)) : false;
  if (!available || !authed) return { skip: 'no_backend' };
  return { provider, providerId: active.providerId, model: active.model };
}

// ---- defaults for injectable seams ------------------------------------------------------

function defaultPrepareAssignment({ workspace, task_key, agent_id }, httpModule) {
  // Same-node review is requested by default (judge_requested:true, create_judge:false): the
  // headless review-verdict drain owns approving/merging these attempts, closing the loop without
  // an interactive dispatcher. The prepare route allocates orch/attempt/<key> + the envelope.
  return postDaemonJson('/subconscious/assignment', {
    action: 'prepare',
    workspace,
    task_key,
    agent_id,
    create_judge: false,
    judge_requested: true,
  }, httpModule);
}

function defaultCompleteFailed({ workspace, key, agent_id, reason }, httpModule) {
  return postDaemonJson('/overlay/status', {
    workspace,
    key,
    status: 'failed',
    agent_id,
    note: 'headless spawn executor: worker child did not complete',
    summary: reason,
    task_result: {
      version: 1,
      status: 'failed',
      summary: reason,
      files_changed: [],
      tests_run: 'none — headless worker child did not complete',
      decisions: [],
    },
  }, httpModule);
}

// ---- one worker dispatch ----------------------------------------------------------------

/**
 * Dispatch ONE prepared worker child and settle its outcome. Owns the governor slot handed to it
 * (decrements concurrentRunning + releases the host-wide lease in finally). Pushes a summary onto
 * `drains`. Never throws — every failure path resolves to a summary + (when needed) a terminal
 * failed write so the task cannot strand in_progress.
 */
async function _runOneWorker({ job, siblings, provider, model, deps, governor, slot, drains }) {
  const agentId = workerAgentId(job.key);
  const timeoutMs = workerTimeoutMs();
  const runDrain = deps.runDrain || headlessDrain.runDrain;
  const recordOutcome = deps.recordOutcome || headlessDrain.recordDrainOutcome;
  const summary = { drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, agent_id: agentId };

  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    governor.concurrentRunning = Math.max(0, governor.concurrentRunning - 1);
    if (slot && typeof slot.release === 'function') slot.release();
  };

  try {
    // 1. Prepare the assignment (attempt worktree orch/attempt/<key> + envelope) through the same
    //    route the MCP prepare facade uses — same worktree allocation and permit minting.
    let prepare;
    try {
      prepare = await (deps.prepareAssignment || defaultPrepareAssignment)(
        { workspace: job.ws, task_key: job.key, agent_id: agentId }, deps.httpModule
      );
    } catch (e) {
      prepare = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (!prepare || prepare.ok === false || !(prepare.worktree || (prepare.assignment && prepare.assignment.worktree))) {
      summary.skipped = 'prepare_failed';
      summary.error = (prepare && prepare.error) || 'prepare returned no worktree';
      drains.push(summary);
      process.stdout.write(`[headless-spawn] PREPARE FAILED task=${job.key} error=${summary.error}\n`);
      return;
    }
    const worktree = prepare.worktree || prepare.assignment.worktree;

    // 2. Build the typed envelope + worker-contract prompt, then the provider-owned invocation.
    const envelope = buildHandoffEnvelope({ job, prepare, agentId, siblings });
    const prompt = buildWorkerPrompt(envelope);
    const mcpConfig = (deps.resolveMcpConfig || headlessDrain._resolveMcpConfig)(job.ws);
    let invocation;
    try {
      invocation = provider.buildInvocation({
        prompt,
        model,
        mcpConfig: mcpConfig || undefined,
        addDir: [envelope.target_repo, worktree].filter(Boolean),
      });
    } catch (e) {
      summary.skipped = 'invocation_failed';
      summary.error = e && e.message ? e.message : String(e);
      drains.push(summary);
      return;
    }

    process.stdout.write(`[headless-spawn] WORKER starting task=${job.key} provider=${provider.id} worktree=${worktree}\n`);

    // 3. Spawn the child through the shared runDrain (timeoutMs + SIGKILL bound). cwd = the attempt
    //    worktree so the worker's file writes land on the right branch by construction.
    const env = invocation.env ? { ...process.env, ...invocation.env } : undefined;
    let result;
    try {
      result = await runDrain({ bin: invocation.bin, args: invocation.args, env, cwd: worktree, timeoutMs });
    } finally {
      releaseSlot();
    }

    const clean = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    if (clean) {
      // Clean run resets the shared LLM backoff (same semantics as a clean judge round; done here
      // directly because recordDrainOutcome only resets for its own drain kinds).
      governor.consecutiveThrottles = 0;
      governor.backoffUntil = 0;
    } else {
      recordOutcome(result); // throttle/timeout/failure feeds the shared rate-limit backoff
    }

    summary.exitCode = result.exitCode;
    summary.timedOut = result.timedOut;
    summary.spawnError = result.spawnError;

    // 4. Strand guard: whatever the exit looked like, the task's status decides the cleanup.
    //    in_progress ⇒ the worker claimed but never completed — post the terminal failed status
    //    (primary path; the staleness sweep is last resort). Still ready/pending ⇒ never claimed —
    //    the 60s spawn-lease TTL frees it for redispatch, nothing to write.
    const after = _safeOverlayLoad(job.ws, deps);
    const status = after && after.status ? after.status[job.key] : undefined;
    if (status === 'in_progress') {
      const reason = result.timedOut
        ? `Headless worker timed out after ${timeoutMs}ms without completing the assignment.`
        : `Headless worker exited (code ${result.exitCode}${result.spawnError ? `, spawn error: ${result.spawnError}` : ''}) without completing the assignment.`;
      const failed = await (deps.completeFailed || defaultCompleteFailed)(
        { workspace: job.ws, key: job.key, agent_id: agentId, reason }, deps.httpModule
      );
      summary.marked_failed = !(failed && failed.error);
      if (failed && failed.error) summary.error = failed.error;
    } else if (!clean && (status === undefined || status === 'ready' || status === 'pending')) {
      summary.never_claimed = true;
    }

    drains.push(summary);
    process.stdout.write(
      `[headless-spawn] WORKER ${clean ? 'done' : 'FAILED'} task=${job.key} exit=${result.exitCode} timedOut=${result.timedOut}` +
      `${summary.marked_failed ? ' marked_failed=true' : ''}\n`
    );
  } catch (e) {
    releaseSlot();
    summary.skipped = 'error';
    summary.error = e && e.message ? e.message : String(e);
    drains.push(summary);
  } finally {
    releaseSlot();
  }
}

function _safeOverlayLoad(workspaceRoot, deps = {}) {
  try {
    const overlayLoad = deps.overlayLoad || require('./overlay').load;
    return overlayLoad(workspaceRoot) || null;
  } catch {
    return null;
  }
}

// ---- pump entry point --------------------------------------------------------------------

/**
 * Check gates + governor and dispatch headless workers for any due managed-loop spawn decisions.
 * Facade-compatible with headless-drain's runDueDrains ({ ran, skipped, drains }), so it plugs
 * straight into createHeadlessDrainRunner as a second runner instance.
 *
 * @param {object} state — daemon state (unused beyond parity with runDueDrains; loops carry their
 *                         own workspace pins).
 * @param {object} deps — injection seams (all optional in production, used by tests):
 *   loops            — the daemon's loop registry Map (REQUIRED; supplied by createSpawnExecutor).
 *   decide           — () => decideAll() decisions (REQUIRED; supplied by createSpawnExecutor).
 *   overlayLoad/overlaySave, prepareAssignment, completeFailed, backendLib, runDrain,
 *   acquireSlot, governor, resolveMcpConfig, recordOutcome, effectiveConfig, httpModule.
 */
async function runDueSpawns(state, deps = {}) {
  const governor = deps.governor || headlessDrain._governor;
  const cfg = (deps.effectiveConfig || headlessDrain.effectiveConfig)();
  const loops = deps.loops;
  if (!loops || typeof deps.decide !== 'function') {
    return { ran: 0, skipped: 'not_wired', drains: [] };
  }

  // ---- shared-governor budget/backoff checks (identical semantics to runDueDrains) --------
  if (Date.now() < governor.backoffUntil) return { ran: 0, skipped: 'backoff', drains: [] };
  if (governor.iterationsUsed >= cfg.maxIterations) return { ran: 0, skipped: 'iterations_exhausted', drains: [] };
  if (governor.tokensUsed >= cfg.tokenBudget) return { ran: 0, skipped: 'token_budget_exhausted', drains: [] };
  if (governor.concurrentRunning >= cfg.maxConcurrency) return { ran: 0, skipped: 'concurrency_cap', drains: [] };

  // ---- eligibility gates (all BEFORE the decide pass, so a gated-off daemon never ticks loops
  //      or leases tasks from here) ---------------------------------------------------------
  const allLoops = [...loops.values()];
  // Requirement: never serve session-bound loops, and stand down entirely while any interactive
  // driver is live (see module header — decideAll is global; consuming it here would steal the
  // driver's spawn decisions for a lease TTL).
  if (allLoops.some((L) => L && L.active && L.session)) {
    return { ran: 0, skipped: 'interactive_driver_active', drains: [] };
  }
  const managed = allLoops.filter((L) => L && L.active && L.managed === 'graph' && !L.session && L.workspace);
  if (!managed.length) return { ran: 0, skipped: 'no_managed_loops', drains: [] };

  // Config gate: per-workspace opt-in (overlay config headless_driver:true, default OFF).
  const gatedWs = new Set();
  for (const L of managed) {
    if (gatedWs.has(L.workspace)) continue;
    const ov = _safeOverlayLoad(L.workspace, deps);
    if (headlessDriverEnabled(ov)) gatedWs.add(L.workspace);
  }
  if (!gatedWs.size) return { ran: 0, skipped: 'headless_driver_off', drains: [] };

  // ---- decide pass: THE SAME decideAll /next-action drivers call. decideOne charges each loop
  //      (iterations, estPerTick spend, in_progress headroom) and leases the picked tasks. -----
  let decisions;
  try {
    decisions = deps.decide() || [];
  } catch (e) {
    return { ran: 0, skipped: 'decide_failed', error: e && e.message ? e.message : String(e), drains: [] };
  }

  // Collect spawn jobs from MANAGED loops of gated-on workspaces only. Session-bound or foreign-
  // workspace decisions are never executed here (their tasks' leases simply expire in 60s — and in
  // the zero-session regime nobody else was going to dispatch them anyway).
  const jobs = [];
  for (const d of decisions) {
    if (!d || d.action !== 'spawn' || !Array.isArray(d.tasks)) continue;
    const L = loops.get(d.loopId);
    if (!L || L.managed !== 'graph' || L.session || !gatedWs.has(L.workspace)) continue;
    for (const t of d.tasks) {
      if (t && t.key) jobs.push({ ws: L.workspace, loopId: d.loopId, key: t.key, label: t.label });
    }
  }
  if (!jobs.length) return { ran: 0, skipped: 'no_spawn_decisions', drains: [] };

  const drains = [];
  let skipReason = null;
  const acquireSlot = deps.acquireSlot || headlessDrain._acquireGlobalDrainSlot;
  const overlayByWs = new Map();           // one post-decide overlay read per workspace this pump
  const backendByWs = new Map();           // one backend resolve per workspace this pump
  const active = new Set();
  let dispatched = 0;

  for (const job of jobs) {
    // Lease verification (double-dispatch guard, same primitive as interactive drivers): the live
    // spawn lease must belong to the loop whose decision we are executing. A foreign live lease
    // means another dispatcher owns this task right now — skip it. A missing/expired lease (e.g.
    // it lapsed between decide and dispatch) is re-acquired under the same loop id before spawn.
    let ov = overlayByWs.get(job.ws);
    if (!ov) {
      ov = _safeOverlayLoad(job.ws, deps);
      overlayByWs.set(job.ws, ov);
    }
    const overlayStore = deps.overlayStore || require('./overlay');
    const lease = ov && ov.spawnLease && ov.spawnLease[job.key];
    const live = !!(lease && lease.leaseExpiry > Date.now());
    if (live && lease.loopId !== job.loopId) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: 'lease_held' });
      skipReason = skipReason || 'lease_held';
      continue;
    }
    if (!live && ov) {
      if (!overlayStore.acquireSpawnLease(ov, job.key, job.loopId, 60000)) {
        drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: 'lease_held' });
        skipReason = skipReason || 'lease_held';
        continue;
      }
      const overlaySave = deps.overlaySave || overlayStore.save;
      try { overlaySave(job.ws, ov); } catch { /* lease is best-effort persisted; TTL bounds harm */ }
    }

    // Backend (once per workspace): agentic-cli only; a HARD-BLOCK is a clean pause, not a crash.
    let backend = backendByWs.get(job.ws);
    if (!backend) {
      backend = resolveSpawnBackend(ov || {}, deps);
      backendByWs.set(job.ws, backend);
    }
    if (backend.skip) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: backend.skip });
      skipReason = skipReason || backend.skip;
      continue;
    }

    // Governor slot (shared with the drain pool — one concurrency/budget surface for ALL headless
    // children). The host-wide lease uses the WORKER timeout for its expiry, not the drain default.
    if (governor.concurrentRunning >= cfg.maxConcurrency || governor.iterationsUsed >= cfg.maxIterations) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: 'concurrency_cap' });
      skipReason = skipReason || 'concurrency_cap';
      continue;
    }
    const slot = acquireSlot({ ...cfg, timeoutMs: workerTimeoutMs() }, 'spawn-exec');
    if (!slot.ok) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: slot.reason });
      skipReason = skipReason || slot.reason;
      continue;
    }
    governor.concurrentRunning++;
    governor.iterationsUsed++;
    dispatched++;

    const siblings = jobs.filter((j) => j !== job && j.ws === job.ws);
    let run;
    run = _runOneWorker({ job, siblings, provider: backend.provider, model: backend.model, deps, governor, slot, drains })
      .finally(() => { active.delete(run); });
    active.add(run);
  }

  // Await the dispatched children (the drain-pump pattern: the daemon event loop stays free —
  // runDrain is async — and the pump reschedules itself as soon as this resolves).
  while (active.size) await Promise.race(active);

  return { ran: dispatched, skipped: dispatched ? null : (skipReason || 'no_spawn_decisions'), drains };
}

// ---- executor factory ----------------------------------------------------------------------

/**
 * Build the executor facade daemon.js hands to createHeadlessDrainRunner (a second runner instance
 * over the SHARED headless-drain governor — same backoff, same concurrency surface, zero runner
 * changes).
 *
 * @param {object} hooks
 *   @param {Map}      hooks.loops  — the daemon's loop registry.
 *   @param {Function} hooks.decide — () => decideAll() decisions (caller persists the registry,
 *                                    mirroring the /next-action route's decideAll(); saveLoops()).
 *   plus any runDueSpawns seam override (tests).
 */
function createSpawnExecutor(hooks = {}) {
  const governor = hooks.governor || headlessDrain._governor;
  return {
    _governor: governor,
    runDueSpawns: (state) => runDueSpawns(state, hooks),
    // Facade parity with headless-drain so createHeadlessDrainRunner can pump this executor.
    runDueDrains: (state) => runDueSpawns(state, hooks),
  };
}

module.exports = {
  SPAWN_EXECUTOR_KEY,
  HEADLESS_WORKER_PREFIX,
  createSpawnExecutor,
  runDueSpawns,
  headlessDriverEnabled,
  resolveSpawnBackend,
  workerAgentId,
  workerTimeoutMs,
  buildHandoffEnvelope,
  buildWorkerPrompt,
};
