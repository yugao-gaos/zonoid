#!/usr/bin/env node
// P2b: maintenance sweeps + loop tick enumerate the REAL set of REGISTERED workspaces
// (workspaces.json), NOT the single daemon-global state.workspace pointer.
// Run: node test/registered-workspace-sweeps.test.js — exits non-zero on any failed assertion.
//
// (a) registeredWorkspaces() reads workspaces.json and UNIONs active-loop workspaces; it does NOT
//     depend on state.workspace (state.workspace is only included if it is ALSO registered).
// (b) decideAll() sweeps stale verdicts across MULTIPLE registered workspaces — a stale verdict in
//     a registered workspace that is NEITHER state.workspace NOR backed by an active loop is still
//     reset. This is the core P2b behavior: sweeps no longer key off the global pointer.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// BASE/WORKSPACES_FILE are computed at daemon module-load from CLAUDE_PLUGIN_DATA — set it FIRST.
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-regws-base-')));
process.env.CLAUDE_PLUGIN_DATA = BASE;
const WORKSPACES_FILE = path.join(BASE, 'workspaces.json');

const ov = require('../lib/overlay');
const {
  registeredWorkspaces, decideAll,
  __setOverlayForTest, __setWorkspaceForTest, __setAgentsForTest,
  __setLoopsForTest, __clearLoopsForTest, __clearOverlayCacheForTest,
} = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const NOW = Date.now();
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();
const STALE_MS = 20 * 60000;   // past the 10m default stale_minutes

// Three real workspace dirs (need to exist on disk for overlay load/save to behave).
const WS_PRIMARY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-regws-primary-')));
const WS_REG_A   = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-regws-a-')));
const WS_REG_B   = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-regws-b-')));
const WS_LOOP    = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-regws-loop-')));

// ─── (a) registeredWorkspaces enumerates the registry + active loops, not state.workspace ────
{
  // Registry lists A and B. state.workspace is PRIMARY (NOT in the registry). A loop is pinned to
  // WS_LOOP (also not in the registry). registeredWorkspaces() must return {A, B, WS_LOOP} and must
  // NOT include PRIMARY (it is the global pointer but not registered).
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify([WS_REG_A, WS_REG_B]));
  __setWorkspaceForTest(WS_PRIMARY);
  __setOverlayForTest(ov.EMPTY());
  __setAgentsForTest({});
  __setLoopsForTest([['loop-1', { id: 'loop-1', active: true, workspace: WS_LOOP, config: {} }]]);

  const set = registeredWorkspaces();
  ok('(a) registry workspace A enumerated', set.has(WS_REG_A));
  ok('(a) registry workspace B enumerated', set.has(WS_REG_B));
  ok('(a) active-loop workspace unioned in', set.has(WS_LOOP));
  ok('(a) state.workspace NOT enumerated when unregistered', !set.has(WS_PRIMARY));

  // Inactive loops do not contribute.
  __setLoopsForTest([['loop-1', { id: 'loop-1', active: false, workspace: WS_LOOP, config: {} }]]);
  ok('(a) inactive-loop workspace NOT enumerated', !registeredWorkspaces().has(WS_LOOP));

  // Missing/garbage registry → falls back to active-loop set, never throws.
  fs.writeFileSync(WORKSPACES_FILE, 'not json');
  __setLoopsForTest([['loop-1', { id: 'loop-1', active: true, workspace: WS_LOOP, config: {} }]]);
  const set2 = registeredWorkspaces();
  ok('(a) garbage registry → active-loop set only (no throw)', set2.has(WS_LOOP) && !set2.has(WS_REG_A));
}

// ─── (b) decideAll sweeps stale verdicts across MULTIPLE registered workspaces ────────────────
{
  __clearOverlayCacheForTest();
  // state.workspace = PRIMARY (unregistered). Registry = [A, B]. NO active loops. A stale verdict
  // sits in BOTH A and B. decideAll must reset BOTH (proving it iterates the REGISTERED set, not
  // just state.workspace — which isn't even registered here).
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify([WS_REG_A, WS_REG_B]));
  __setWorkspaceForTest(WS_PRIMARY);
  __setOverlayForTest(ov.EMPTY());
  __setAgentsForTest({
    'dead-judge': { agent_id: 'dead-judge', state: 'unknown', startedAt: ISO(STALE_MS), lastSeen: ISO(STALE_MS) },
  });
  __clearLoopsForTest();

  const mkStaleVerdict = (wsPath, key) => {
    const o = ov.EMPTY();
    o.status[key] = 'tested';
    o.assignee[key] = 'dead-judge';
    o.timestamps[key] = { firstSeen: ISO(STALE_MS), lastChanged: ISO(STALE_MS), lastStatus: 'tested' };
    ov.save(wsPath, o);
  };
  mkStaleVerdict(WS_REG_A, 'a/1');
  mkStaleVerdict(WS_REG_B, 'b/1');
  __clearOverlayCacheForTest();   // force decideAll's overlayFor to load the freshly-saved overlays

  decideAll();

  const afterA = ov.load(WS_REG_A);
  const afterB = ov.load(WS_REG_B);
  ok('(b) stale verdict in registered ws A reset by decideAll', !afterA.status['a/1']);
  ok('(b) stale verdict in registered ws B reset by decideAll', !afterB.status['b/1']);

  // PRIMARY (state.workspace, NOT registered) must be untouched — there's nothing in it, but more
  // importantly the sweep set is the registry, so a verdict placed in PRIMARY would NOT be swept.
  const mkPrimaryStale = ov.EMPTY();
  mkPrimaryStale.status['p/1'] = 'tested';
  mkPrimaryStale.assignee['p/1'] = 'dead-judge';
  mkPrimaryStale.timestamps['p/1'] = { firstSeen: ISO(STALE_MS), lastChanged: ISO(STALE_MS), lastStatus: 'tested' };
  __setOverlayForTest(mkPrimaryStale);   // PRIMARY is current ws → overlayFor returns this object
  __clearOverlayCacheForTest();
  decideAll();
  ok('(b) unregistered state.workspace verdict NOT swept (sweep set = registry)', mkPrimaryStale.status['p/1'] === 'tested');
}

// ─── (c) dashboard HTML carries the explicit-workspace gate (no silent global default) ─────────
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  ok('(c) dashboard defines WS_RESOLVED gate', html.includes('WS_RESOLVED'));
  ok('(c) dashboard resolves an explicit workspace before fetching', html.includes('resolveExplicitWorkspace'));
  ok('(c) dashboard shows a picker prompt when ambiguous', html.includes('showWorkspaceGate'));
  ok('(c) dashboard tick gates on WS_RESOLVED', /if\s*\(\s*!WS_RESOLVED\s*\)/.test(html));
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
