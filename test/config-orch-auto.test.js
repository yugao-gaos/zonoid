#!/usr/bin/env node
// POST /config "orch auto" contract (routes/session.js). No port binding — drives the real session
// route handler with a fake ctx (in-memory overlay), same pattern as guidance-seam-gate.test.js.
//
// Covers:
//   (1) headless_driver is accepted as an individual /config field (mirrors self_plan)
//   (2) { auto:true } atomically sets self_plan + automode + headless_driver and reports config
//   (3) { auto:false } atomically clears all three (on/off round-trip)
//   (4) individual flags remain independently settable → honest partial state
//   (5) auto overwrites conflicting individual fields in the same body (no half-enabled state)
//   (6) { auto } without a resolved workspace → 400
//   (7) enabling auto/headless_driver promptly ensures managed graph loops (ctx hook)
//
// Run: node test/config-orch-auto.test.js
'use strict';
const overlayStore = require('../lib/overlay');
const sessionRoute = require('../routes/session');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const WS = '/tmp/orch-auto-ws';

function makeCtx({ ws = WS } = {}) {
  const ov = overlayStore.EMPTY();
  let lastSend = null;
  let saves = 0;
  let ensured = 0;
  const ctx = {
    state: {},
    loops: new Map(),
    saveLoops: () => {},
    notifyChange: () => {},
    send: (res, code, body) => { lastSend = { code, body }; },
    readBody: async (req) => req._body,
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ws, ov, save: () => { saves++; } }),
    ensureManagedGraphLoops: () => { ensured++; },
    // unused-by-/config ctx fields the destructure pulls — harmless stubs:
    resolveRepo: () => ws, now: () => Date.now(),
    stopSignalFor: () => null, agentsArr: () => [],
    ESCALATION_DEFAULTS: () => ({}), OPTIMIZE_DEFAULTS: () => ({}),
  };
  return { ctx, ov, getLast: () => lastSend, getSaves: () => saves, getEnsured: () => ensured };
}

const res = {};
const u = new URL('http://localhost/config');
const post = (route, body) => route('/config', 'POST', { _body: body, method: 'POST' }, res, u);

(async () => {
  // ---- (1) headless_driver accepted as an individual field --------------------------------------
  {
    const { ctx, ov, getLast } = makeCtx();
    const route = sessionRoute(ctx);
    await post(route, { headless_driver: true });
    const r = getLast();
    ok('1.1: headless_driver accepted (200)', r && r.code === 200 && r.body.ok === true);
    ok('1.2: headless_driver persisted to overlay config', ov.config.headless_driver === true);
    ok('1.3: response reports resulting config', r.body.config && r.body.config.headless_driver === true);
    ok('1.4: response reports workspace', r.body.workspace === WS);
    await post(route, { headless_driver: false });
    ok('1.5: headless_driver clears', ov.config.headless_driver === false);
  }

  // ---- (2)+(3) atomic auto on/off round-trip -----------------------------------------------------
  {
    const { ctx, ov, getLast, getSaves } = makeCtx();
    const route = sessionRoute(ctx);
    await post(route, { auto: true });
    let r = getLast();
    ok('2.1: auto:true → self_plan on', ov.config.self_plan === true);
    ok('2.2: auto:true → automode on', ov.config.automode === true);
    ok('2.3: auto:true → headless_driver on', ov.config.headless_driver === true);
    ok('2.4: response config carries all three flags',
      r.body.config.self_plan === true && r.body.config.automode === true && r.body.config.headless_driver === true);
    ok('2.5: overlay saved', getSaves() === 1);
    await post(route, { auto: false });
    r = getLast();
    ok('3.1: auto:false → all three off',
      ov.config.self_plan === false && ov.config.automode === false && ov.config.headless_driver === false);
    ok('3.2: off response reports cleared config',
      r.body.config.self_plan === false && r.body.config.automode === false && r.body.config.headless_driver === false);
  }

  // ---- (4) individual flags stay independently settable → honest partial state ------------------
  {
    const { ctx, ov, getLast } = makeCtx();
    const route = sessionRoute(ctx);
    await post(route, { self_plan: true });
    const r = getLast();
    ok('4.1: lone self_plan set', ov.config.self_plan === true);
    ok('4.2: partial state honest — automode/headless_driver NOT set',
      ov.config.automode === undefined && ov.config.headless_driver === undefined);
    const c = r.body.config;
    ok('4.3: response exposes the mixed state (dashboard partial hint reads this)',
      c.self_plan === true && !c.automode && !c.headless_driver);
  }

  // ---- (5) auto wins over conflicting individual fields in the same body -------------------------
  {
    const { ctx, ov } = makeCtx();
    const route = sessionRoute(ctx);
    await post(route, { auto: true, automode: false, self_plan: false });
    ok('5.1: auto:true overrides same-body individual false flags (no half-enabled state)',
      ov.config.self_plan === true && ov.config.automode === true && ov.config.headless_driver === true);
  }

  // ---- (6) auto with no resolved workspace → 400 --------------------------------------------------
  {
    const { ctx, getLast } = makeCtx({ ws: null });
    const route = sessionRoute(ctx);
    await post(route, { auto: true });
    const r = getLast();
    ok('6.1: auto without workspace → 400', r && r.code === 400 && r.body.ok === false);
  }

  // ---- (7) enabling promptly ensures managed graph loops ------------------------------------------
  {
    const { ctx, getEnsured } = makeCtx();
    const route = sessionRoute(ctx);
    await post(route, { auto: true });
    ok('7.1: auto:true ensures managed loops promptly', getEnsured() === 1);
    await post(route, { headless_driver: true });
    ok('7.2: headless_driver:true ensures managed loops promptly', getEnsured() === 2);
    await post(route, { auto: false });
    ok('7.3: auto:false does NOT ensure (nothing to start)', getEnsured() === 2);
    await post(route, { require_review: true });
    ok('7.4: unrelated config write does NOT ensure', getEnsured() === 2);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
