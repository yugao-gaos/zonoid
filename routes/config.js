'use strict';
/**
 * routes/config.js — daemon route for the SELECTABLE LLM BACKEND (pluggable-backend feature).
 *
 * Exposes GET/POST /config/backend so the dashboard can read per-provider readiness and select the
 * active backend. The selection persists under overlay.config.backend = { provider, model } (see
 * lib/overlay.js setBackendConfig/getBackendConfig) and is resolved at drain time by
 * getActiveBackend(overlay) in lib/llm-backend.js.
 *
 *   GET  /config/backend → { ok, active: { provider, model }, providers: [ { id, displayName, kind,
 *                            isAvailable, isAuthed }, ... ] }. The active backend is the resolved
 *                          provider id + model (defaults to Claude when unset). EACH provider is
 *                          annotated with detected isAvailable + isAuthed so the dashboard can show
 *                          readiness per provider. isAvailable is meaningful only for agentic-cli
 *                          providers (api providers spawn no binary) — reported as null for 'api'.
 *   POST /config/backend → body { provider, model? } → validates the provider id exists in the
 *                          registry (400 on unknown), sets overlay.config.backend, persists, and
 *                          returns the new active backend. A falsy provider clears the selection
 *                          (reverts to the Claude default).
 *
 * Mirrors the route-module shape of routes/judge.js / routes/label.js: `(ctx) => async (...)`,
 * driven by ctx.targetOverlay/send/readBody/notifyChange. Wired into daemon.js's routeModules.
 */
const overlayStore = require('../lib/overlay');
const llmBackend = require('../lib/llm-backend');
const embed = require('../lib/embed');

const NO_WORKSPACE_ERROR = 'no workspace resolved — pass workspace (body or ?workspace=)';

function requireWorkspace(T, send, res) {
  if (T.ws) return true;
  send(res, 400, { ok: false, error: NO_WORKSPACE_ERROR });
  return false;
}

// Annotate one registry provider with its detected readiness for the dashboard. isAvailable applies
// only to agentic-cli providers (they resolve a local binary); api providers spawn nothing, so it is
// null there. Both kinds answer isAuthed(). Each probe is wrapped so one provider's throw can't break
// the whole listing (a misbehaving adapter degrades to false/null, not a 500).
function annotateProvider(prov) {
  const safe = (fn) => { try { return !!fn(); } catch { return false; } };
  return {
    id: prov.id,
    displayName: prov.displayName,
    kind: prov.kind,
    // agentic-cli providers expose isAvailable (binary on disk); api providers do not (null).
    isAvailable: prov.kind === 'agentic-cli' && typeof prov.isAvailable === 'function'
      ? safe(prov.isAvailable.bind(prov))
      : null,
    isAuthed: typeof prov.isAuthed === 'function' ? safe(prov.isAuthed.bind(prov)) : false,
  };
}

const makeRoute = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, targetOverlay } = ctx;

  if (p === '/config/backend' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!requireWorkspace(T, send, res)) return true;
    // Resolve the ACTIVE backend the same way the drains will (defaults to Claude when unset).
    const active = llmBackend.getActiveBackend(T.ov);
    const providers = llmBackend.listProviders().map(annotateProvider);
    send(res, 200, {
      ok: true,
      active: { provider: active.providerId, model: active.model || null },
      providers,
    });
    return true;
  }

  if (p === '/config/backend' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!requireWorkspace(T, send, res)) return true;
    const provider = b && b.provider;
    const model = b && b.model;
    // A falsy provider CLEARS the selection (revert to the Claude default) — explicit, not an error.
    if (!provider) {
      overlayStore.setBackendConfig(T.ov, {});
      T.save();
      notifyChange();
      const active = llmBackend.getActiveBackend(T.ov);
      send(res, 200, { ok: true, active: { provider: active.providerId, model: active.model || null } });
      return true;
    }
    // Validate the provider id exists in the registry — reject unknown ids (the dashboard should
    // only ever POST a listed id, but a bad client must get a clean 400, not a silent bad write).
    if (!llmBackend.getProvider(String(provider))) {
      const known = llmBackend.listProviders().map((x) => x.id);
      send(res, 400, { ok: false, error: `unknown backend provider '${provider}' (known: ${known.join(', ')})` });
      return true;
    }
    overlayStore.setBackendConfig(T.ov, { provider, model });
    T.save();
    notifyChange();
    const active = llmBackend.getActiveBackend(T.ov);
    send(res, 200, { ok: true, active: { provider: active.providerId, model: active.model || null } });
    return true;
  }

  if (p === '/config/embedding' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!requireWorkspace(T, send, res)) return true;
    const active = embed.normalizeEmbeddingConfig(T.ov);
    const providers = embed.listEmbeddingProviders().map(embed.annotateEmbeddingProvider);
    send(res, 200, { ok: true, active, providers });
    return true;
  }

  if (p === '/config/embedding' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!requireWorkspace(T, send, res)) return true;
    const provider = b && b.provider;
    if (!provider) {
      overlayStore.setEmbeddingConfig(T.ov, {});
      T.save();
      notifyChange();
      send(res, 200, { ok: true, active: embed.normalizeEmbeddingConfig(T.ov) });
      return true;
    }
    const valid = embed.validateEmbeddingConfig(b);
    if (!valid.ok) {
      send(res, 400, valid);
      return true;
    }
    overlayStore.setEmbeddingConfig(T.ov, valid.config);
    T.save();
    notifyChange();
    send(res, 200, { ok: true, active: embed.normalizeEmbeddingConfig(T.ov) });
    return true;
  }

  return false;
};

module.exports = makeRoute;
