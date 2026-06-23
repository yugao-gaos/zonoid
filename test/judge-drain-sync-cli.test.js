#!/usr/bin/env node
/**
 * test/judge-drain-sync-cli.test.js
 *
 * Focused unit test for the CLI-kind branch of the SYNCHRONOUS node-scoped judge drain (P7):
 *   lib/headless-drain.runJudgeDrainSync(...) driving an agentic-cli backend (claude/codex/cursor).
 *
 * P1 wired runJudgeDrainSync to the api-kind in-process judge only (provider.runJudgeLoop). P7 makes
 * it backend-AGNOSTIC: a cli-kind backend is driven by SPAWNING the configured provider's invocation
 * (the SAME machinery the background cli drain uses), bounded by the per-call timeout + SIGKILL.
 *
 * Property under test: a node seeded with weight-0 autowire candidate edges (judged:false) is driven
 * to idle:true by REPEATEDLY SPAWNING the configured cli provider — NO real CLI / LLM runs: the
 * cli-spawn seam (child_process.spawn) is stubbed exactly as the background cli-drain tests stub it
 * (patched BEFORE freshModule so the fresh module captures the patched spawn), and the fake child
 * simulates the CLI judge applying verdicts to the daemon by draining the node's unjudged edges in a
 * synthetic in-memory overlay. idle-detection reads that overlay via injected overlayLoad/judgeLib.
 *
 * Run: node --test test/judge-drain-sync-cli.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const child_process = require('child_process');

const realJudge = require('../lib/judge');

/** Reset module cache so each test gets a fresh headless-drain module (captures patched spawn fresh). */
function freshModule() {
  const key = require.resolve('../lib/headless-drain');
  delete require.cache[key];
  return require('../lib/headless-drain');
}

/**
 * A node seeded with `n` weight-0 autowire candidate edges (judged:false) — the exact shape
 * whole-graph recall seeds on node-add. Mirrors test/judge-drain-sync.test.js seededOverlay.
 */
function seededOverlay(node, n) {
  const edges = [];
  for (let i = 0; i < n; i++) {
    edges.push(i % 2 === 0
      ? { from: node, to: `note:cand${i}`, kind: 'context', by: 'autowire', weight: 0, judged: false, score: 0.7 }
      : { from: `note:cand${i}`, to: node, kind: 'context', by: 'autowire', weight: 0, judged: false, score: 0.7 });
  }
  return { epoch: 1, edges, note_nodes: {}, config: { backend: { provider: 'mock-cli', model: 'mock-model' } } };
}

/**
 * A fake child for the async spawn seam (mirrors headless-drain.test.makeFakeChild): an EventEmitter
 * with stdout/stderr sub-emitters that schedules its lifecycle on the next tick. `onSpawn(child)` runs
 * synchronously at spawn time so a test can mutate shared state (the overlay) to simulate the CLI judge
 * applying verdicts before the child closes.
 */
function makeFakeChild({ code = 0, stdout = '', stderr = '', never = false, emitError = null, onSpawn = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.emit('close', null); return true; };
  if (typeof onSpawn === 'function') { try { onSpawn(child); } catch { /* ignore */ } }
  setImmediate(() => {
    if (emitError) { child.emit('error', emitError); return; }
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    if (!never) child.emit('close', code);
  });
  return child;
}

/**
 * Patch child_process.spawn, then freshModule() so the fresh headless-drain captures the patched fn —
 * the SAME seam freshModuleWithMockedSpawn uses in test/headless-drain.test.js. Each spawn is recorded;
 * `stub(bin,args,opts)` returns the fake child. Returns { hd, calls, restore }.
 */
function freshModuleWithMockedSpawn(stub) {
  const orig = child_process.spawn;
  const calls = [];
  child_process.spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return stub ? stub(bin, args, opts) : makeFakeChild();
  };
  const hd = freshModule();
  return { hd, calls, restore: () => { child_process.spawn = orig; } };
}

/**
 * cli-kind backendDeps whose buildInvocation yields a recognizable argv (with a `--backend-id` marker),
 * GENERIC across providers. Mirrors test/headless-drain.test.mockBackendDeps' agentic-cli default.
 * The PROVIDER never spawns — runJudgeDrainSync does (through runDrain), intercepted by the patched
 * child_process.spawn above.
 */
function makeCliDeps(overlay, { id = 'mock-cli', available = true, authed = true, bin = '/mock/bin/agent', model = 'mock-model' } = {}) {
  const calls = { buildInvocation: 0, buildInvocationArgs: [] };
  const provider = {
    id,
    displayName: `Mock ${id}`,
    kind: 'agentic-cli',
    isAvailable: () => available,
    isAuthed: () => authed,
    buildInvocation(opts = {}) {
      calls.buildInvocation++;
      calls.buildInvocationArgs.push(opts);
      const args = ['-p', opts.prompt, '--model', opts.model || model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--backend-id', id];
      if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
      if (opts.addDir) args.push('--add-dir', opts.addDir);
      return { bin, args, env: { MOCK_ENV: '1' } };
    },
    runJudgeLoop() { throw new Error('agentic-cli backend must not call runJudgeLoop (it spawns)'); },
    parseResult: (out) => ({ result: null, usage: null, raw: String(out || '') }),
  };
  const backendLib = {
    getActiveBackend: () => ({ provider, providerId: id, model, config: { provider: id, model } }),
    getProvider: (q) => (q === id ? provider : null),
    listProviders: () => [provider],
  };
  const deps = {
    backendDeps: { backendLib },
    overlayLoad: () => overlay,
    judgeLib: realJudge,
    timeoutMs: 5000,
    mcpConfig: '/mock/.mcp.json',
  };
  return { deps, calls, provider, bin, id };
}

// ---- core property: a cli backend is SPAWNED per round and drains the node to idle ----------------

test('runJudgeDrainSync drives a CLI-kind backend by SPAWNING the provider invocation to idle', async () => {
  const node = 's/anchor';
  const overlay = seededOverlay(node, 4);
  // Each spawned "CLI judge" drains up to `perRound` of the node's unjudged edges in the shared overlay
  // — the on-disk effect a real CLI judge has by POSTing verdicts to the daemon. The overlay delta is
  // what runJudgeDrainSync reads for idle, so the cli path needs no stdout markers.
  const perRound = 2;
  const cli = makeCliDeps(overlay, { id: 'mock-cli', bin: '/mock/bin/agent' });
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({
    code: 0,
    onSpawn: () => {
      const unjudged = realJudge.unverifiedEdgesForNode(overlay, node);
      for (let i = 0; i < unjudged.length && i < perRound; i++) unjudged[i].judged = true;
    },
  }));
  try {
    assert.equal(realJudge.unverifiedEdgesForNode(overlay, node).length, 4);
    const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 50, deps: cli.deps });

    assert.equal(out.idle, true, 'cli rounds drained the node to idle');
    assert.equal(out.judged, 4, 'all 4 candidate edges judged (overlay delta)');
    assert.equal(realJudge.unverifiedEdgesForNode(overlay, node).length, 0, 'overlay edge-set fully drained');
    // It SPAWNED the cli provider (2 rounds over 4 edges at 2/round), NOT an in-process call.
    assert.equal(calls.length, 2, 'two cli spawns (cap 2/round over 4 edges)');
    assert.ok(cli.calls.buildInvocation >= 2, 'each round built the provider invocation');
    // The spawn bin + argv came from THIS provider's invocation, not a hardcoded claude path.
    assert.equal(calls[0].bin, '/mock/bin/agent', 'spawn bin is the provider-resolved binary (generic)');
    assert.ok(calls[0].args.includes('--backend-id'), 'spawn argv carries the provider marker');
    assert.equal(calls[0].args[calls[0].args.indexOf('--backend-id') + 1], 'mock-cli', 'argv built by THIS provider');
    assert.equal(calls[0].opts.env.MOCK_ENV, '1', 'spawn env comes from the provider invocation');
    // Every SPAWNED round carries a node-scoped prompt (the daemon /judge/next?node= target baked in by
    // buildJudgePrompt) and the forwarded mcpConfig — asserted on the actual spawned argv (-p <prompt>),
    // i.e. what was EXECUTED, not the eager validation-build resolveJudgeBackend discards.
    const spawnedPrompts = calls.map((c) => c.args[c.args.indexOf('-p') + 1]);
    assert.ok(spawnedPrompts.every((p) => String(p).includes(node)), 'every spawned round is node-scoped');
    assert.ok(calls.every((c) => c.args.includes('--mcp-config') && c.args[c.args.indexOf('--mcp-config') + 1] === '/mock/.mcp.json'), 'mcpConfig forwarded to the cli judge');
  } finally {
    restore();
  }
});

// ---- a cli round that HANGS is bounded by the per-call timeout (SIGKILL) → stops, never hangs ------

test('runJudgeDrainSync bounds a hanging cli round by the per-call timeout (no 9.5h hang)', async () => {
  const node = 's/anchor';
  const overlay = seededOverlay(node, 2);
  const cli = makeCliDeps(overlay, { id: 'mock-cli' });
  cli.deps.timeoutMs = 40; // tiny per-call timeout
  // The fake child NEVER closes on its own — runDrain must SIGKILL it after timeoutMs. The kill emits
  // close(null), so runDrain resolves timedOut:true and the sync loop stops on the failed round.
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({ never: true }));
  try {
    const t0 = Date.now();
    const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 10, maxRounds: 10, deps: cli.deps });
    const elapsed = Date.now() - t0;
    assert.equal(calls.length, 1, 'one spawn, then the timed-out round stops the loop (no re-fire spin)');
    assert.equal(out.idle, false, 'the node did not drain (the round timed out)');
    assert.equal(out.judged, 0, 'a timed-out round judged nothing');
    assert.ok(elapsed < 2000, `bounded by the per-call timeout, not a hang (elapsed=${elapsed}ms)`);
  } finally {
    restore();
  }
});

// ---- a cli backend that is NOT authed hard-blocks cleanly (no spawn, no crash) --------------------

test('runJudgeDrainSync hard-blocks a cli backend that is unavailable/unauthed (no spawn)', async () => {
  const node = 's/anchor';
  const overlay = seededOverlay(node, 2);
  const cli = makeCliDeps(overlay, { id: 'mock-cli', authed: false }); // unauthed ⇒ hard-block
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 10, deps: cli.deps });
    assert.equal(out.skipped, 'no_backend', 'unauthed cli backend ⇒ clean skip');
    assert.equal(calls.length, 0, 'hard-block spawns nothing');
    assert.equal(cli.calls.buildInvocation, 0, 'no invocation built when hard-blocked');
    assert.equal(out.judged, 0);
    assert.equal(out.rounds, 0);
  } finally {
    restore();
  }
});

// ---- a cli round whose spawn FAILS (bad bin) stops cleanly, never crashes -------------------------

test('runJudgeDrainSync treats a cli spawn failure as a stopped round (clean, no crash)', async () => {
  const node = 's/anchor';
  const overlay = seededOverlay(node, 3);
  const cli = makeCliDeps(overlay, { id: 'mock-cli' });
  // The spawned child emits 'error' (e.g. ENOENT) — runDrain resolves spawnError (exitCode null), a
  // non-clean round that stops the loop. The node stays un-drained but nothing throws.
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({ emitError: new Error('spawn ENOENT') }));
  try {
    const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 10, maxRounds: 10, deps: cli.deps });
    assert.equal(calls.length, 1, 'one spawn attempt, then the failed round stops the loop');
    assert.equal(out.idle, false, 'a failed spawn drains nothing');
    assert.equal(out.judged, 0);
  } finally {
    restore();
  }
});

// ---- stall guard: a CLEAN cli round that drains nothing stops (no maxRounds spawn-storm) ----------

test('runJudgeDrainSync stops when a clean cli round makes no progress (stall guard, not maxRounds)', async () => {
  const node = 's/anchor';
  const overlay = seededOverlay(node, 3);
  const cli = makeCliDeps(overlay, { id: 'mock-cli' });
  // The fake child exits 0 but NEVER mutates the overlay (the CLI judge applied nothing — e.g. couldn't
  // reach the daemon). The overlay still reports 3 unjudged edges, so the api-shaped idle/applied
  // markers never fire; the BACKEND-AGNOSTIC stall guard must stop after one no-progress round.
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({ code: 0 }));
  try {
    const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 10, maxRounds: 50, deps: cli.deps });
    assert.equal(calls.length, 1, 'stall guard stops after ONE no-progress round (not 50 spawns)');
    assert.equal(out.idle, false, 'the node never drained');
    assert.equal(out.judged, 0, 'no edges left the unjudged set');
    assert.ok(out.rounds <= 2, `bounded rounds, not the maxRounds ceiling (rounds=${out.rounds})`);
  } finally {
    restore();
  }
});
