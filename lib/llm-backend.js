'use strict';
/**
 * llm-backend.js — pluggable LLM-engine adapter seam.
 *
 * WHY THIS EXISTS
 * ---------------
 * The orchestrator drives an LLM in two structurally different ways:
 *   - AGENTIC-CLI: spawn a self-driving local CLI agent (Claude Code / Codex / Cursor) as a child
 *     process — `claude -p …`. This is the historical path (lib/claude-cli.js + lib/headless-drain.js).
 *   - API: the daemon calls a hosted API (Anthropic / OpenRouter) IN-PROCESS, NO child process.
 *     This path is first-class because antivirus heuristics flag hidden local-CLI spawns, so an
 *     AV-clean deployment needs to drive the model without forking a binary.
 *
 * This module is the seam that lets a single dashboard-selected backend stand in for either kind.
 * It defines:
 *   - the PROVIDER ADAPTER interface (what every backend must implement, per `kind`),
 *   - a small in-process REGISTRY (registerProvider / getProvider / listProviders),
 *   - the CLAUDE provider (kind 'agentic-cli'), which owns the binary resolver, .env loader, and
 *     shell-shim detection that used to live in lib/claude-cli.js (now re-exported from there),
 *   - an API provider STUB (kind 'api') whose call seam THROWS "not implemented" — the real
 *     in-process API path is a SEPARATE downstream task; this keeps the registry shape honest now,
 *   - getActiveBackend(overlay), which reads overlay.config.backend = { provider, model } and
 *     returns the matching provider, DEFAULTING to the Claude provider when unset.
 *
 * SCOPE (this task is the FOUNDATIONAL seam only):
 *   Drain-routing (lib/headless-drain.js + scripts/onboard-learn.js still call the re-exports from
 *   lib/claude-cli.js, UNCHANGED), config/hard-block, the dashboard selector, the real API backend,
 *   and the Codex/Cursor providers are all SEPARATE downstream tasks. Do not build them here.
 *
 * ----------------------------------------------------------------------------------------------
 * PROVIDER ADAPTER INTERFACE
 * ----------------------------------------------------------------------------------------------
 * Every provider object declares:
 *   id          {string}  — stable machine id (e.g. 'claude', 'openrouter'). Registry key.
 *   displayName {string}  — human label for the dashboard selector.
 *   kind        {string}  — 'agentic-cli' | 'api'. Determines which method set is meaningful.
 *
 * AGENTIC-CLI providers (kind 'agentic-cli') implement:
 *   resolveBin()                 → {string}  absolute path (or bare name) of the CLI binary.
 *   isAvailable()                → {boolean} true iff the resolved binary looks usable on this host.
 *   isAuthed()                   → {boolean} true iff credentials for a headless run are present.
 *   buildInvocation({ prompt, model, mcpConfig, addDir, budget })
 *                                → { bin, args, env }  — a ready-to-spawn argv (NOT spawned here).
 *   parseResult(out)             → parsed result object from the child's stdout (best-effort).
 *
 * API providers (kind 'api') implement:
 *   isAuthed()                   → {boolean} true iff the API key/credentials are present.
 *   callApi(...)   / runJudgeLoop(...)
 *                                → the IN-PROCESS call seam. STUBBED here: THROWS a clear
 *                                  "not implemented" error (built in the API-backend task).
 *
 * Both kinds share `id`, `displayName`, `kind`, and `isAuthed()`.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// =====================================================================================
// Provider registry
// =====================================================================================

/**
 * Allowed provider kinds. 'agentic-cli' spawns a self-driving local CLI; 'api' calls a hosted
 * API in-process (no child). getActiveBackend / the dashboard branch on this.
 */
const PROVIDER_KINDS = Object.freeze(['agentic-cli', 'api']);

/** The id every getActiveBackend call falls back to when overlay.config.backend is unset. */
const DEFAULT_PROVIDER_ID = 'claude';

// Module-private registry: id -> provider object. Seeded below with the first-party providers.
const _registry = new Map();

/**
 * Register (or replace) a provider in the registry. Validates the minimal adapter shape so a
 * malformed provider fails loudly at registration time rather than at spawn/call time.
 *
 * @param {object} provider — must carry { id, displayName, kind } and the methods for its kind.
 * @returns {object} the registered provider (for chaining/testing).
 */
function registerProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('registerProvider: provider must be an object');
  }
  const { id, displayName, kind } = provider;
  if (!id || typeof id !== 'string') {
    throw new Error('registerProvider: provider.id must be a non-empty string');
  }
  if (!displayName || typeof displayName !== 'string') {
    throw new Error(`registerProvider(${id}): provider.displayName must be a non-empty string`);
  }
  if (!PROVIDER_KINDS.includes(kind)) {
    throw new Error(`registerProvider(${id}): provider.kind must be one of ${PROVIDER_KINDS.join(' | ')} (got ${JSON.stringify(kind)})`);
  }
  // isAuthed() is the one method BOTH kinds must answer (the dashboard needs it to show readiness).
  if (typeof provider.isAuthed !== 'function') {
    throw new Error(`registerProvider(${id}): provider.isAuthed must be a function`);
  }
  if (kind === 'agentic-cli') {
    for (const m of ['resolveBin', 'isAvailable', 'buildInvocation', 'parseResult']) {
      if (typeof provider[m] !== 'function') {
        throw new Error(`registerProvider(${id}): agentic-cli provider must implement ${m}()`);
      }
    }
  }
  _registry.set(id, provider);
  return provider;
}

/** Look up a provider by id. Returns the provider object, or null if not registered. */
function getProvider(id) {
  return _registry.get(id) || null;
}

/** List all registered providers (array of provider objects), in insertion order. */
function listProviders() {
  return Array.from(_registry.values());
}

/**
 * Resolve the ACTIVE backend from overlay config.
 *
 * Reads overlay.config.backend = { provider, model }:
 *   - provider absent/unknown ⇒ fall back to the Claude provider (DEFAULT_PROVIDER_ID).
 *   - model is carried through on the returned object as `.model` (may be undefined) so callers
 *     building an invocation have the dashboard-selected model without re-reading the overlay.
 *
 * @param {object} [overlay] — the workspace overlay ({ config: { backend: { provider, model } } }).
 * @returns {{ provider: object, providerId: string, model: (string|undefined), config: object }}
 *          `provider` is the resolved provider object; never null (defaults to Claude).
 */
function getActiveBackend(overlay) {
  const cfg = (overlay && overlay.config && overlay.config.backend) || {};
  const requestedId = cfg.provider;
  let provider = requestedId ? getProvider(requestedId) : null;
  let providerId = requestedId;
  if (!provider) {
    // Unset OR an unknown id ⇒ default to Claude (the historical, always-present backend). An
    // unknown id is a soft fallback, not a throw: the dashboard may name a provider this build
    // doesn't register yet, and a hard throw here would brick every drain.
    provider = getProvider(DEFAULT_PROVIDER_ID);
    providerId = DEFAULT_PROVIDER_ID;
  }
  return { provider, providerId, model: cfg.model, config: cfg };
}

// =====================================================================================
// CLAUDE provider (kind 'agentic-cli')
// =====================================================================================
// Owns the binary resolver, .env loader, and shell-shim detection that historically lived in
// lib/claude-cli.js. That module now RE-EXPORTS these so existing callers (lib/headless-drain.js,
// scripts/onboard-learn.js) keep working unchanged in this task.

/**
 * Resolve the `claude` CLI binary, cross-platform.
 *
 * Resolution order:
 *   1. ZONOID_CLAUDE_BIN or CLAUDE_BIN env override.
 *   2. Well-known absolute install paths (Unix: /opt/homebrew, /usr/local, /usr).
 *   3. Windows: %APPDATA%\Claude\claude-code\<version>\claude.exe (newest build first).
 *      The desktop app does NOT add itself to PATH on Windows, so we probe the directory.
 *   4. PATH lookup via `where` (Windows) / `which` (Unix).
 *   5. Bare 'claude' fallback — OS resolves at spawn time.
 */
function resolveClaudeBin() {
  const override = process.env.ZONOID_CLAUDE_BIN || process.env.CLAUDE_BIN;
  if (override) return override;

  const isWin = process.platform === 'win32';

  if (!isWin) {
    for (const c of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude']) {
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
  }

  if (isWin) {
    try {
      const base = path.join(process.env.APPDATA || '', 'Claude', 'claude-code');
      const exes = fs.readdirSync(base)
        .map((v) => path.join(base, v, 'claude.exe'))
        .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (exes.length) return exes[0];
    } catch { /* ignore — base dir may not exist */ }
  }

  try {
    const r = spawnSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
    const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (hit) return hit;
  } catch { /* ignore */ }

  return 'claude';
}

/**
 * Load .env.local then .env from rootDir into process.env (no-override — real env wins).
 * Returns the list of keys set. Silently no-ops when lib/load-env is absent.
 */
function loadEnvForClaude(rootDir) {
  try {
    return require('./load-env').loadEnvFiles(rootDir);
  } catch {
    return [];
  }
}

/**
 * Returns true when the resolved binary is a Windows .cmd/.bat shim that spawnSync
 * cannot exec directly — in that case pass shell:true to the spawn call.
 */
function needsShell(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

/**
 * The CLAUDE backend provider (kind 'agentic-cli'). Drives a headless `claude -p` child.
 *
 * buildInvocation mirrors the flag set the existing headless drains already use (see
 * lib/headless-drain.js buildJudgeArgs + scripts/onboard-learn.js): stream-json output, verbose,
 * --dangerously-skip-permissions, optional --mcp-config (+ --strict-mcp-config) and --add-dir. It
 * returns a ready argv WITHOUT spawning — the caller (drain runner) owns the actual spawn, shell
 * decision (via needsShell), cwd, and timeout. `budget` is accepted for interface parity with the
 * API kind but is not a CLI flag, so it is carried through on the returned object as `.budget` for
 * the caller (e.g. baked into the prompt by the drain) rather than dropped silently.
 */
const claudeProvider = {
  id: 'claude',
  displayName: 'Claude Code (local CLI)',
  kind: 'agentic-cli',

  resolveBin() {
    return resolveClaudeBin();
  },

  /**
   * True iff the resolved binary looks usable: an explicit env override or an absolute path that
   * exists on disk, OR the bare 'claude' fallback (OS resolves it at spawn time — we can't cheaply
   * prove a PATH hit here without re-shelling, so we optimistically treat the fallback as available
   * and let the spawn surface ENOENT, matching the existing onboard-learn.js behavior).
   */
  isAvailable() {
    const bin = resolveClaudeBin();
    if (bin === 'claude') return true; // bare fallback — defer to spawn-time resolution
    try { return fs.existsSync(bin); } catch { return false; }
  },

  /**
   * True iff credentials for a headless run are present. The headless `claude -p` path authenticates
   * via ANTHROPIC_API_KEY (loaded from .env.local/.env by loadEnvForClaude before a drain) OR a
   * CLAUDE_CODE_OAUTH_TOKEN from an interactive login. Either satisfies a non-interactive run.
   */
  isAuthed() {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  },

  /**
   * Build a ready-to-spawn `claude -p` invocation. Does NOT spawn.
   * @param {object} opts
   *   @param {string}  opts.prompt    — the -p prompt (required).
   *   @param {string} [opts.model]    — model id (default 'opus').
   *   @param {string} [opts.mcpConfig]— path to a .mcp.json (adds --mcp-config + --strict-mcp-config).
   *   @param {string|string[]} [opts.addDir] — dir(s) to grant read access (each adds --add-dir).
   *   @param {number} [opts.budget]   — advisory item budget (not a CLI flag; carried through).
   * @returns {{ bin: string, args: string[], env: object, budget: (number|undefined) }}
   */
  buildInvocation(opts = {}) {
    const { prompt, model, mcpConfig, addDir, budget } = opts;
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('claudeProvider.buildInvocation: opts.prompt is required');
    }
    const bin = resolveClaudeBin();
    const args = [
      '-p', prompt,
      '--model', model || 'opus',
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (mcpConfig) args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
    if (addDir) {
      for (const d of Array.isArray(addDir) ? addDir : [addDir]) {
        if (d) args.push('--add-dir', d);
      }
    }
    return { bin, args, env: process.env, budget };
  },

  /**
   * Best-effort parse of a headless `claude -p --output-format stream-json` stdout stream.
   * The stream is newline-delimited JSON events; the terminal `type:"result"` event carries the
   * final assistant text + usage. Returns { result, usage, raw } — `result`/`usage` are null when
   * absent (a malformed/partial stream never throws here; callers decide how to treat a null).
   */
  parseResult(out) {
    const text = String(out || '');
    let result = null;
    let usage = null;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      let evt;
      try { evt = JSON.parse(trimmed); } catch { continue; }
      if (evt && evt.type === 'result') {
        if (typeof evt.result === 'string') result = evt.result;
        if (evt.usage) usage = evt.usage;
      }
    }
    return { result, usage, raw: text };
  },
};

// =====================================================================================
// API provider (kind 'api') — STUB
// =====================================================================================
// The IN-PROCESS hosted-API path (Anthropic / OpenRouter), built in a SEPARATE downstream task.
// Registered here as a clean, honest stub so the registry already carries both kinds and
// getActiveBackend can resolve an API provider id — but its call seam THROWS until implemented.

/** Shared "not implemented" guard for the API call seam. Centralized so the message is uniform. */
function _apiNotImplemented(what) {
  throw new Error(
    `llm-backend: API backend '${what}' is not implemented yet — it is built in the API-backend ` +
    `task (kind 'api', in-process Anthropic/OpenRouter call). Use the 'claude' agentic-cli backend for now.`
  );
}

/**
 * The OpenRouter API backend provider (kind 'api') — a CLEAN STUB.
 *
 * Declares isAuthed() (so the dashboard can show readiness against OPENROUTER_API_KEY) and the
 * IN-PROCESS call seam (callApi / runJudgeLoop) that THROWS "not implemented" for now. The real
 * implementation lands in the API-backend task; this preserves the registry's two-kind shape and
 * lets getActiveBackend resolve an 'api' selection without the rest of the system special-casing it.
 */
const openRouterProvider = {
  id: 'openrouter',
  displayName: 'OpenRouter (API, in-process)',
  kind: 'api',

  /** True iff an OpenRouter (or generic) API key is present. No child process is ever spawned. */
  isAuthed() {
    return Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY);
  },

  /** In-process single API call seam — STUB. Built in the API-backend task. */
  callApi() {
    return _apiNotImplemented('callApi');
  },

  /** In-process judge-loop seam (the API analogue of the headless judge drain) — STUB. */
  runJudgeLoop() {
    return _apiNotImplemented('runJudgeLoop');
  },
};

// ---- seed the registry with the first-party providers --------------------------------
registerProvider(claudeProvider);
registerProvider(openRouterProvider);

module.exports = {
  // registry
  PROVIDER_KINDS,
  DEFAULT_PROVIDER_ID,
  registerProvider,
  getProvider,
  listProviders,
  getActiveBackend,
  // providers (exported for direct use + tests)
  claudeProvider,
  openRouterProvider,
  // Claude CLI helpers — re-exported by lib/claude-cli.js to keep existing callers working.
  resolveClaudeBin,
  loadEnvForClaude,
  needsShell,
};
