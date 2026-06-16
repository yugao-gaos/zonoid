#!/usr/bin/env node
// Unit test for lib/backend-ui.js — the PURE presentation logic behind the dashboard backend
// selector (pluggable-backend feature). No daemon/HTTP needed: these are pure functions.
//
// Covers the two decisions the dashboard makes when rendering GET /config/backend:
//   1. shouldShowAvNotice(kind) — the EXPLICIT user requirement: the antivirus-awareness notice
//      shows for agentic-cli (spawns a hidden `claude -p` child) and NOT for api (in-process,
//      spawns nothing). Unknown/missing kinds fail closed (no notice).
//   2. providerReadiness(provider) — maps { kind, isAvailable, isAuthed } from GET /config/backend
//      to the selector's badge { label, ok, detail } across all states, including api's null
//      isAvailable ("hosted, no install").
//
// Run: node test/backend-ui.test.js
'use strict';
const bk = require('../lib/backend-ui');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// 1. AV-notice predicate — the core gated requirement.
ok('AV notice SHOWS for agentic-cli kind', bk.shouldShowAvNotice('agentic-cli') === true);
ok('AV notice HIDDEN for api kind', bk.shouldShowAvNotice('api') === false);
ok('AV notice HIDDEN for unknown kind', bk.shouldShowAvNotice('something-else') === false);
ok('AV notice HIDDEN for undefined kind', bk.shouldShowAvNotice(undefined) === false);
ok('AV notice HIDDEN for null kind', bk.shouldShowAvNotice(null) === false);

// 2. AV-notice copy carries the key guidance (so the message can't silently regress to empty/wrong).
const txt = bk.avNoticeText();
ok('AV text mentions hidden background processes', /hidden background processes/i.test(txt));
ok('AV text names the claude -p spawn example', /claude -p/.test(txt));
ok('AV text mentions antivirus + an exclusion remedy', /antivirus/i.test(txt) && /exclusion/i.test(txt));
ok('AV text offers the API (in-process, no child) alternative', /in-process/i.test(txt) && /no child/i.test(txt));

// 3. providerReadiness — agentic-cli, all three states.
const cliReady = bk.providerReadiness({ kind: 'agentic-cli', isAvailable: true, isAuthed: true });
ok('agentic-cli installed+authed ⇒ ready/ok', cliReady.label === 'ready' && cliReady.ok === true);

const cliNoAuth = bk.providerReadiness({ kind: 'agentic-cli', isAvailable: true, isAuthed: false });
ok('agentic-cli installed+unauthed ⇒ not authed / not ok', cliNoAuth.label === 'not authed' && cliNoAuth.ok === false);

const cliNoBin = bk.providerReadiness({ kind: 'agentic-cli', isAvailable: false, isAuthed: true });
ok('agentic-cli not-installed ⇒ not installed / not ok (regardless of auth)', cliNoBin.label === 'not installed' && cliNoBin.ok === false);

// 4. providerReadiness — api kind: isAvailable is null (hosted, nothing installed); readiness is auth-only.
const apiReady = bk.providerReadiness({ kind: 'api', isAvailable: null, isAuthed: true });
ok('api authed ⇒ ready/ok', apiReady.label === 'ready' && apiReady.ok === true);
ok('api ready detail says hosted, no install', /hosted, no install/i.test(apiReady.detail));

const apiNoAuth = bk.providerReadiness({ kind: 'api', isAvailable: null, isAuthed: false });
ok('api unauthed ⇒ not authed / not ok', apiNoAuth.label === 'not authed' && apiNoAuth.ok === false);
ok('api unauthed detail still says hosted, no install', /hosted, no install/i.test(apiNoAuth.detail));

// 5. Defensive: a missing provider object must not throw (degrade to a non-ready badge).
let threw = false;
let nullRes = null;
try { nullRes = bk.providerReadiness(undefined); } catch { threw = true; }
ok('providerReadiness(undefined) does not throw', threw === false);
ok('providerReadiness(undefined) ⇒ not ok', nullRes && nullRes.ok === false);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
