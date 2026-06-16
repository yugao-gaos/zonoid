#!/usr/bin/env node
/**
 * test/config-backend.test.js
 *
 * Unit tests for the SELECTABLE LLM BACKEND config surface (pluggable-backend task /16):
 *   (a) overlay.config.backend read/write round-trips through lib/overlay (setBackendConfig /
 *       getBackendConfig), persisted with the rest of overlay.config (save → load).
 *   (b) GET /config/backend reports the active backend + per-provider isAvailable/isAuthed status;
 *       POST /config/backend sets the selection and REJECTS an unknown provider id with 400.
 *
 * The route is exercised by calling routes/config.js directly with a synthetic ctx (no full daemon
 * spin-up): a real sandboxed overlay backs targetOverlay, a capturing `send`, and an injectable
 * backend registry. Run: node --test test/config-backend.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox CLAUDE_PLUGIN_DATA BEFORE requiring lib/overlay (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-backend-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlayStore = require('../lib/overlay');
const makeConfigRoute = require('../routes/config');

// A fresh sandboxed workspace per call so tests don't leak overlay state into each other.
function freshWorkspace() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-backend-ws-')));
}

// ---------------------------------------------------------------------------
// (a) overlay.config.backend read/write round-trip
// ---------------------------------------------------------------------------

test('overlay: setBackendConfig writes config.backend; getBackendConfig reads it back', () => {
  const ov = overlayStore.EMPTY();
  assert.equal(overlayStore.getBackendConfig(ov), null, 'unset ⇒ null (= Claude default)');
  overlayStore.setBackendConfig(ov, { provider: 'openrouter', model: 'anthropic/claude-3.5' });
  assert.deepEqual(ov.config.backend, { provider: 'openrouter', model: 'anthropic/claude-3.5' });
  assert.deepEqual(overlayStore.getBackendConfig(ov), { provider: 'openrouter', model: 'anthropic/claude-3.5' });
});

test('overlay: setBackendConfig with no model stores provider only', () => {
  const ov = overlayStore.EMPTY();
  overlayStore.setBackendConfig(ov, { provider: 'claude' });
  assert.deepEqual(ov.config.backend, { provider: 'claude' });
  assert.equal(ov.config.backend.model, undefined, 'no model key when none supplied');
});

test('overlay: setBackendConfig with a falsy provider CLEARS the selection (revert to default)', () => {
  const ov = overlayStore.EMPTY();
  overlayStore.setBackendConfig(ov, { provider: 'openrouter', model: 'm' });
  overlayStore.setBackendConfig(ov, {}); // clear
  assert.equal(ov.config.backend, undefined, 'cleared ⇒ no backend key');
  assert.equal(overlayStore.getBackendConfig(ov), null);
});

test('overlay: config.backend persists across save → load (round-trip on disk)', () => {
  const ws = freshWorkspace();
  const ov = overlayStore.load(ws);
  overlayStore.setBackendConfig(ov, { provider: 'openrouter', model: 'x/y' });
  overlayStore.save(ws, ov);
  const reloaded = overlayStore.load(ws);
  assert.deepEqual(overlayStore.getBackendConfig(reloaded), { provider: 'openrouter', model: 'x/y' },
    'config.backend survives the save/load round-trip (config is in LOCAL_FIELDS)');
});

// ---------------------------------------------------------------------------
// Route harness: a synthetic ctx that backs targetOverlay with a real sandboxed overlay,
// captures send(), and injects a backend registry into routes/config.js via lib/llm-backend.
// (The route require()s ../lib/llm-backend directly; we use the REAL one — its first-party Claude
// + OpenRouter providers give a stable, deterministic registry to assert against.)
// ---------------------------------------------------------------------------

function makeCtx(ws) {
  const captured = {};
  const ctx = {
    send: (res, code, body) => { captured.code = code; captured.body = body; return true; },
    readBody: async (req) => (req && req.__body) || {},
    notifyChange: () => { captured.notified = (captured.notified || 0) + 1; },
    targetOverlay: () => {
      const ov = overlayStore.load(ws);
      return { ws, ov, save: () => overlayStore.save(ws, ov) };
    },
  };
  return { route: makeConfigRoute(ctx), captured };
}

// Minimal URL stand-in (the route only reads u.searchParams via targetOverlay, which ignores it here).
const U = new URL('http://localhost:8787/config/backend');

// ---------------------------------------------------------------------------
// (b) GET /config/backend → active backend + per-provider readiness
// ---------------------------------------------------------------------------

test('GET /config/backend: defaults to claude when unset, lists providers with readiness flags', async () => {
  const ws = freshWorkspace();
  const { route, captured } = makeCtx(ws);
  const handled = await route('/config/backend', 'GET', {}, {}, U, null);
  assert.equal(handled, true, 'route handled the GET');
  assert.equal(captured.code, 200);
  assert.equal(captured.body.ok, true);
  // Unset selection ⇒ active provider defaults to 'claude'.
  assert.equal(captured.body.active.provider, 'claude', 'active defaults to claude when unset');
  assert.equal(captured.body.active.model, null, 'no model when unset');
  // Providers are annotated with readiness.
  const ids = captured.body.providers.map((p) => p.id);
  assert.ok(ids.includes('claude'), 'claude provider listed');
  assert.ok(ids.includes('openrouter'), 'openrouter provider listed');
  const claude = captured.body.providers.find((p) => p.id === 'claude');
  assert.equal(claude.kind, 'agentic-cli');
  assert.equal(typeof claude.isAvailable, 'boolean', 'agentic-cli provider reports isAvailable boolean');
  assert.equal(typeof claude.isAuthed, 'boolean', 'provider reports isAuthed boolean');
  const openrouter = captured.body.providers.find((p) => p.id === 'openrouter');
  assert.equal(openrouter.kind, 'api');
  assert.equal(openrouter.isAvailable, null, 'api providers report isAvailable=null (no local binary)');
  assert.equal(typeof openrouter.isAuthed, 'boolean', 'api provider still reports isAuthed');
});

test('GET /config/backend: reflects a previously-set selection', async () => {
  const ws = freshWorkspace();
  // Pre-set the selection on disk.
  const ov = overlayStore.load(ws);
  overlayStore.setBackendConfig(ov, { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet' });
  overlayStore.save(ws, ov);

  const { route, captured } = makeCtx(ws);
  await route('/config/backend', 'GET', {}, {}, U, null);
  assert.equal(captured.body.active.provider, 'openrouter', 'GET reflects the stored provider');
  assert.equal(captured.body.active.model, 'anthropic/claude-3.5-sonnet', 'GET reflects the stored model');
});

// ---------------------------------------------------------------------------
// (b) POST /config/backend → set selection + validate provider id
// ---------------------------------------------------------------------------

test('POST /config/backend: sets a known provider and persists it', async () => {
  const ws = freshWorkspace();
  const { route, captured } = makeCtx(ws);
  const req = { __body: { provider: 'openrouter', model: 'anthropic/claude-3.5' } };
  const handled = await route('/config/backend', 'POST', req, {}, U, null);
  assert.equal(handled, true, 'route handled the POST');
  assert.equal(captured.code, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.active.provider, 'openrouter');
  assert.equal(captured.body.active.model, 'anthropic/claude-3.5');
  assert.ok(captured.notified >= 1, 'notifyChange called on a successful write');
  // Persisted to the overlay on disk.
  const reloaded = overlayStore.load(ws);
  assert.deepEqual(overlayStore.getBackendConfig(reloaded), { provider: 'openrouter', model: 'anthropic/claude-3.5' });
});

test('POST /config/backend: REJECTS an unknown provider id with 400 (no write)', async () => {
  const ws = freshWorkspace();
  const { route, captured } = makeCtx(ws);
  const req = { __body: { provider: 'no-such-provider-zzz' } };
  await route('/config/backend', 'POST', req, {}, U, null);
  assert.equal(captured.code, 400, 'unknown provider ⇒ 400');
  assert.equal(captured.body.ok, false);
  assert.match(captured.body.error, /unknown backend provider/i, 'error names the rejection');
  // Nothing was written.
  const reloaded = overlayStore.load(ws);
  assert.equal(overlayStore.getBackendConfig(reloaded), null, 'rejected POST must not write the selection');
});

test('POST /config/backend: a falsy provider clears the selection (back to claude default)', async () => {
  const ws = freshWorkspace();
  // Seed a non-default selection first.
  const ov = overlayStore.load(ws);
  overlayStore.setBackendConfig(ov, { provider: 'openrouter', model: 'm' });
  overlayStore.save(ws, ov);

  const { route, captured } = makeCtx(ws);
  const req = { __body: { provider: '' } }; // explicit clear
  await route('/config/backend', 'POST', req, {}, U, null);
  assert.equal(captured.code, 200);
  assert.equal(captured.body.active.provider, 'claude', 'cleared ⇒ active reverts to the claude default');
  const reloaded = overlayStore.load(ws);
  assert.equal(overlayStore.getBackendConfig(reloaded), null, 'selection cleared on disk');
});

test('config route ignores unrelated paths/methods (returns false to fall through)', async () => {
  const ws = freshWorkspace();
  const { route } = makeCtx(ws);
  assert.equal(await route('/config/backend', 'DELETE', {}, {}, U, null), false, 'unsupported method falls through');
  assert.equal(await route('/some/other/path', 'GET', {}, {}, U, null), false, 'unrelated path falls through');
});
