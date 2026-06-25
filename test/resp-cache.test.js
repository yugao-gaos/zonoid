#!/usr/bin/env node
// Tests for the /state-//costflow response cache (respCacheGet/respCachePut: TTL + overlay-file
// mtime stamp, invalidated by notifyChange) and the compaction guard isPrimaryCheckout
// (.git dir = primary, .git file = worktree). Plain Node, no framework.
// Run: node test/resp-cache.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const daemon = require('../daemon');
const overlayStore = require('../lib/overlay');
const { respCacheGet, respCachePut, notifyChange, RESP_TTL, isPrimaryCheckout } = daemon;

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// Fake workspaces: no overlay file on disk => overlayStamp is a stable 0, so TTL governs.
const WS = '/tmp/resp-cache-test-ws-a';
const WS2 = '/tmp/resp-cache-test-ws-b';

// --- response cache: hit within TTL ---
const payload = { workspace: WS, tasks: [{ id: '1' }] };
ok('put returns the payload', respCachePut(WS, `state|${WS}|||`, payload) === payload);
ok('get within TTL returns the same payload object', respCacheGet(WS, `state|${WS}|||`) === payload);
ok('get on an unknown key returns undefined', respCacheGet(WS2, `state|${WS2}|||`) === undefined);

// distinct keys (same ws, different query params) are independent entries
const compactPayload = { workspace: WS, compact: true };
respCachePut(WS, `state|${WS}||1|`, compactPayload);
ok('per-param keys are independent', respCacheGet(WS, `state|${WS}|||`) === payload && respCacheGet(WS, `state|${WS}||1|`) === compactPayload);

// --- expiry after TTL (advance the clock past RESP_TTL) ---
const realNow = Date.now;
try {
  const t0 = realNow();
  Date.now = () => t0 + RESP_TTL + 1;
  ok('get after TTL expiry returns undefined', respCacheGet(WS, `state|${WS}|||`) === undefined);
} finally {
  Date.now = realNow;
}

// --- invalidation: notifyChange (the in-process mutation choke point) clears everything ---
respCachePut(WS, `costflow|${WS}|`, { totals: { total: 1 } });
respCachePut(WS, `state|${WS}|||`, payload);
ok('entries present before notifyChange', respCacheGet(WS, `costflow|${WS}|`) !== undefined);
notifyChange();   // no SSE clients registered in test — clears the cache, writes to nobody
ok('notifyChange invalidates costflow entries', respCacheGet(WS, `costflow|${WS}|`) === undefined);
ok('notifyChange invalidates state entries', respCacheGet(WS, `state|${WS}|||`) === undefined);

// --- invalidation: an OUT-OF-PROCESS overlay write (mtime stamp mismatch) busts the hit ---
// Simulates another process calling overlayStore.save (no notifyChange in the daemon): the
// cached entry carries the overlay file's mtime at put time; touching the file invalidates.
const ovFile = overlayStore.fileFor(WS);
try {
  fs.mkdirSync(path.dirname(ovFile), { recursive: true });
  fs.writeFileSync(ovFile, '{}');
  respCachePut(WS, `state|${WS}|||`, payload);
  ok('hit while overlay file unchanged', respCacheGet(WS, `state|${WS}|||`) === payload);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(ovFile, future, future);   // out-of-band write = mtime change
  ok('overlay file mtime change invalidates the entry', respCacheGet(WS, `state|${WS}|||`) === undefined);
} finally {
  try { fs.unlinkSync(ovFile); } catch { /* already gone */ }
}

// --- isPrimaryCheckout: .git DIRECTORY = primary checkout ---
const primDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prim-')));
fs.mkdirSync(path.join(primDir, '.git'));
ok('.git directory => primary checkout (true)', isPrimaryCheckout(primDir) === true);

// --- isPrimaryCheckout: .git FILE (worktree gitdir pointer) = NOT primary ---
const wtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-')));
fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /some/repo/.git/worktrees/attempt-1\n');
ok('.git file (worktree pointer) => not primary (false)', isPrimaryCheckout(wtDir) === false);

// --- isPrimaryCheckout: no .git at all = primary (nothing to merge-conflict with) ---
const bareDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bare-')));
ok('missing .git => primary (true)', isPrimaryCheckout(bareDir) === true);

// --- isPrimaryCheckout: default root is the daemon source dir ---
ok('default root resolves without throwing', typeof isPrimaryCheckout() === 'boolean');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
