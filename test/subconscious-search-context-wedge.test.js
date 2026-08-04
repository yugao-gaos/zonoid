#!/usr/bin/env node
'use strict';
/**
 * subconscious-search-context-wedge.test.js
 *
 * Regression for the `/subconscious/search-context` daemon event-loop WEDGE.
 *
 * ROOT CAUSE (reproduced during benchmarking): the multi-round agentic search-context loop calls the
 * cross-encoder rerank() once per round (rerank is ON by default). rerank's sidecar is spawned LAZILY
 * on the first call, and the child writes its PID file only AFTER Node boots + server.listen fires,
 * and its socket doesn't accept until the ~80MB model finishes loading (seconds). The old spawn guard
 * deduped ONLY on the PID file, so every rerank() failure during that cold window spawned ANOTHER
 * sidecar. Firing a few back-to-back search-context calls (each several rounds) detonated a single
 * cold start into N concurrent model-loading processes that saturated the CPU and starved the daemon's
 * own event loop — /health stopped responding and later calls hung past their socket timeout (an
 * event-loop block, not slowness).
 *
 * THE FIX: an in-process spawn cooldown latch in lib/rerank.js (and lib/embed.js) caps spawns to one
 * per cooldown regardless of PID-file timing; plus a server-side EADDRINUSE guard so any bind-race
 * loser exits before loading a model. This test pins both properties:
 *
 *   PART 1 (root cause): a burst of rerank() calls during a simulated cold start spawns the sidecar
 *           AT MOST ONCE (spawn is stubbed/counted — no real model is loaded).
 *   PART 2 (integration): N rapid sequential search-context calls each return AND the event loop stays
 *           responsive throughout (a concurrent interval "health probe" is never starved).
 *
 * Run: node test/subconscious-search-context-wedge.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// ---------------------------------------------------------------------------------------------------
// PART 1 — spawn-storm guard (deterministic; no model is ever loaded).
// ---------------------------------------------------------------------------------------------------
async function part1() {
  // Isolate the sidecar data dir so no real PID file pre-exists (a live prod sidecar would mask the
  // cold-start path) and we never touch production sockets.
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wedge-rerank-')));
  const prevData = process.env.ORCH_DATA;
  process.env.ORCH_DATA = dataDir;

  // Stub child_process.spawn BEFORE requiring lib/rerank.js so its destructured `spawn` captures the
  // stub. The stub returns a dummy child (with pid + unref) and NEVER launches a real process, so no
  // PID file is ever written — exactly the cold window where the old code re-spawned on every call.
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  let spawnCount = 0;
  cp.spawn = function stubbedSpawn() {
    spawnCount++;
    return { pid: 100000 + spawnCount, unref() {}, on() {}, kill() {} };
  };

  // Force a fresh module instance that binds the stubbed spawn + isolated ORCH_DATA.
  const rerankPath = require.resolve('../lib/rerank');
  delete require.cache[rerankPath];
  const { rerank } = require(rerankPath);

  try {
    // Simulate the search-context loop: many rerank() calls in a tight burst. Every call fails to
    // connect (no sidecar is really listening) and falls into the spawn path. The cooldown latch must
    // collapse all of these into a SINGLE spawn.
    const burst = [];
    for (let i = 0; i < 24; i++) burst.push(rerank('query about handling a request', ['doc a', 'doc b', 'doc c']));
    const results = await Promise.all(burst);

    ok('part1: every rerank() during cold start degrades to null (never throws)', results.every((r) => r === null));
    ok(`part1: cold-start burst spawns the rerank sidecar AT MOST ONCE (got ${spawnCount})`, spawnCount <= 1);
    ok('part1: cold-start burst spawns the rerank sidecar AT LEAST ONCE', spawnCount >= 1);
  } finally {
    cp.spawn = realSpawn;
    delete require.cache[rerankPath];
    if (prevData === undefined) delete process.env.ORCH_DATA; else process.env.ORCH_DATA = prevData;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------------------------------
// PART 2 — search-context stays event-loop-responsive across N rapid calls (in-process, no models).
// ---------------------------------------------------------------------------------------------------
function rndVec(n = 384) {
  const v = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { v[i] = Math.random() * 2 - 1; s += v[i] * v[i]; }
  const norm = Math.sqrt(s) || 1;
  for (let i = 0; i < n; i++) v[i] /= norm;
  return v;
}

function suggestToks(s) { return new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])); }
function scoreNodeAgainstTokens(item, qt) {
  const xt = suggestToks(`${item.label || ''} ${item.summary || ''}`);
  const shared = [...qt].filter((t) => xt.has(t));
  return { shared, score: qt.size && xt.size ? shared.length / Math.sqrt(qt.size * xt.size) : 0 };
}

async function part2() {
  // rerank is exercised in part 1; here we isolate the LOOP's own responsiveness, so keep rerank out
  // of the hot path (its cold-start cost is what part 1 covers). ORCH_RERANK=0 keeps this test fast
  // and deterministic without changing what we assert about the loop.
  const prevRerank = process.env.ORCH_RERANK;
  process.env.ORCH_RERANK = '0';

  const { defaultSubconsciousStore } = require('../lib/subconscious');
  const embedProviders = require('../lib/embed-providers');
  const embeddingStore = require('../lib/embedding-store');

  const META = { provider: 'minilm', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, identity: 'minilm:Xenova/all-MiniLM-L6-v2:384' };
  const N_CODE = 1200;
  const N_CALLS = 6;

  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wedge-loop-')));
  fs.mkdirSync(path.join(workspace, '.graph'), { recursive: true });

  const tasks = [{ id: 'bench/anchor', label: 'Repository housekeeping', status: 'ready', kind: 'task', deps: [], context_deps: [], context_weights: {}, summary: 'maintenance umbrella', vecs: [rndVec()], vecsMeta: [META] }];
  for (let i = 0; i < 40; i++) tasks.push({ id: `note:n${i}`, label: `Note ${i} about search and embed`, kind: 'note', status: 'note', deps: [], context_deps: [], context_weights: {}, summary: `note ${i} content about retrieval`, vecs: [rndVec()], vecsMeta: [META] });
  const graph = { tasks };

  const code_nodes = {};
  for (let i = 0; i < N_CODE; i++) {
    code_nodes[`code:sym${i}`] = { name: `function sym${i}`, signature: `function sym${i}(a, b) {}`, file: `lib/file${i % 50}.js`, start_line: (i % 100) + 1, end_line: (i % 100) + 8, exported: i % 3 === 0, vec: rndVec(), vecMeta: META };
  }
  const overlay = { knowledge: {}, edges: [], entity_nodes: {}, code_nodes, embeddingConfig: { provider: 'minilm', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 } };

  const QVEC = rndVec();
  const ctx = {
    buildGraph: () => graph,
    overlayFor: () => overlay,
    isTruthy: (v) => v != null && v !== '' && v !== '0' && v !== 'false' && v !== 'no',
    embed: async () => QVEC,
    embeddingMeta: (ov) => embedProviders.embeddingMeta(embedProviders.normalizeEmbeddingConfig(ov || {})),
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: (item) => typeof item === 'string' ? item : String((item && (item.value || item.text || item.summary)) || ''),
    noteCurrentAsOf: () => true,
    gateTask: async () => ({ decision: 'abstain', reason: 'test', via: 'semantic', top1: 0, margin: 0, gap: 0, locality: 0, topType: null }),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'minilm',
    cosine: embeddingStore.maxCosine,
  };

  // Event-loop "health probe": fire every 25ms and record the worst gap. If the search-context loop
  // blocks the event loop synchronously, the probe starves and maxLag spikes — the wedge signature.
  let maxLag = 0;
  let last = Date.now();
  const probe = setInterval(() => { const now = Date.now(); const lag = now - last - 25; if (lag > maxLag) maxLag = lag; last = now; }, 25);

  try {
    last = Date.now();
    for (let call = 1; call <= N_CALLS; call++) {
      const res = await defaultSubconsciousStore.searchContext(ctx, {
        workspace,
        agent_id: `probe-${call}`,
        task_key: 'bench/anchor',
        intent: 'retrieve code context for the current question',
        situation: `find the function that handles request number ${call}`,
        query: `find the function that handles request number ${call}`,
        k: 10,
        max_rounds: 4,
      }, { socket: { remoteAddress: '127.0.0.1' } });
      ok(`part2: search-context call ${call}/${N_CALLS} returned ok`, res && res.ok === true);
      // Yield so the probe interval can fire between calls.
      await new Promise((r) => setTimeout(r, 5));
    }

    // Threshold: a single synchronous round over 1200 code_nodes is tens of ms; we allow generous head
    // room for a loaded CI box, but a true wedge (the bug) starves the probe for hundreds-to-thousands
    // of ms. 750ms cleanly separates "healthy under load" from "wedged".
    ok(`part2: event loop stayed responsive across ${N_CALLS} rapid calls (maxLag=${maxLag}ms < 750ms)`, maxLag < 750);
  } finally {
    clearInterval(probe);
    if (prevRerank === undefined) delete process.env.ORCH_RERANK; else process.env.ORCH_RERANK = prevRerank;
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  await part1();
  await part2();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
