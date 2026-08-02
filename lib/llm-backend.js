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
 *   callApi({ messages, model, key, ... })
 *                                → IN-PROCESS HTTPS chat-completions call (Node `https`, NO child
 *                                  process). Resolves { text, usage }; throws an ApiBackendError on
 *                                  non-200 / network failure (carrying `.throttle` so the drain's
 *                                  backoff governor treats a 429/529 like the spawn path does).
 *   runJudgeLoop({ daemonUrl, budget, node, model, key, ... })
 *                                → the IN-PROCESS analogue of the spawned agentic judge: it walks the
 *                                  daemon's /judge/next → callApi → /judge/verdict loop itself (Node
 *                                  `http`, NO child process) and resolves a DRAIN-RESULT-shaped object
 *                                  ({ exitCode, stdout, stderr, timedOut, spawnError }) so
 *                                  lib/headless-drain.js consumes it interchangeably with a spawn result.
 *
 * Both kinds share `id`, `displayName`, `kind`, and `isAuthed()`.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const runtimePaths = require('./runtime-paths');

function agenticCliEnv() {
  const pathParts = [
    path.dirname(process.execPath),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    process.env.PATH || '',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].flatMap((part) => String(part || '').split(path.delimiter)).filter(Boolean);
  return {
    ...process.env,
    PATH: Array.from(new Set(pathParts)).join(path.delimiter),
  };
}

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
    return { bin, args, env: agenticCliEnv(), budget };
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
// API provider (kind 'api') — IN-PROCESS OpenRouter backend
// =====================================================================================
// The AV-CLEAN path: this backend drives the model with a Node `https` request IN-PROCESS, spawning
// NO child process (so antivirus has no hidden local-CLI child to intercept). It mirrors the raw-HTTPS
// pattern lib/embed-haiku.js already uses (no SDK dependency). The judge analogue (runJudgeLoop) walks
// the SAME /judge/next → reason → /judge/verdict loop the spawned agentic judge drives over HTTP, but
// in-process: it fetches items via Node `http`, reasons each with callApi, and POSTs verdicts back.

/** OpenRouter chat-completions endpoint (OpenRouter-style hosted API). */
const OPENROUTER_HOST = 'openrouter.ai';
const OPENROUTER_PATH = '/api/v1/chat/completions';
const OPENROUTER_MODELS_PATH = '/api/v1/models';
/** Default model when overlay.config.backend.model is unset (a broadly-available capable model). */
const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
/** Z.AI GLM chat-completions endpoint (OpenAI-compatible hosted API). */
const ZAI_HOST = 'api.z.ai';
const ZAI_PATH = '/api/paas/v4/chat/completions';
/** Default standalone GLM model when overlay.config.backend.model is unset. */
const ZAI_DEFAULT_MODEL = 'glm-5.2';
/** Local Ollama OpenAI-compatible endpoint (http, no key) — for fully-local/offline LLM backends. */
const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
/** Default local model when overlay.config.backend.model is unset; override via ORCH_OLLAMA_MODEL. */
const OLLAMA_DEFAULT_MODEL = process.env.ORCH_OLLAMA_MODEL || 'qwen3.6:35b';

/**
 * Resolve Ollama's OpenAI-compatible base URL. Prefer explicit Zonoid backend env vars, but accept
 * Ollama's native OLLAMA_HOST for local convenience. Defaults to http://127.0.0.1:11434/v1.
 */
function _resolveOllamaEndpoint() {
  const explicit = (process.env.ZONOID_OLLAMA_BASE_URL || process.env.ORCH_OLLAMA_BASE_URL || '').trim();
  const raw = explicit || (process.env.OLLAMA_HOST || '').trim() || OLLAMA_DEFAULT_BASE_URL;
  let base = raw;
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/+$/, '');
  if (!/\/v1(?:\/|$)/.test(new URL(base).pathname)) base += '/v1';
  const url = new URL(`${base}/chat/completions`);
  return {
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: url.pathname + url.search,
  };
}

function _resolveOllamaTagsEndpoint() {
  const explicit = (process.env.ZONOID_OLLAMA_BASE_URL || process.env.ORCH_OLLAMA_BASE_URL || '').trim();
  const raw = explicit || (process.env.OLLAMA_HOST || '').trim() || OLLAMA_DEFAULT_BASE_URL;
  let base = raw;
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  const url = new URL(base.replace(/\/+$/, ''));
  const pathname = url.pathname.replace(/\/v1\/?$/, '') || '';
  return {
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: `${pathname}/api/tags`.replace(/\/+/g, '/'),
  };
}
/** Per-call wall-clock timeout for the in-process HTTPS request (mirrors embed-haiku's bound). */
const API_CALL_TIMEOUT_MS = Number(process.env.ORCH_API_CALL_TIMEOUT_MS) || 60 * 1000;
/** Daemon-global hosted-backend credentials file under the runtime data dir. */
const BACKEND_CREDENTIAL_ENV_FILE = 'backend.env';

/**
 * Typed error for the API call seam. The drain's backoff governor (lib/headless-drain.isThrottled /
 * recordDrainOutcome) keys off 429/529/overload/rate-limit text; carrying `.throttle` + `.status`
 * lets the in-process path feed that governor the SAME way a spawned child's throttle output does.
 */
class ApiBackendError extends Error {
  constructor(message, { status = null, throttle = false, cause = null } = {}) {
    super(message);
    this.name = 'ApiBackendError';
    this.status = status;
    this.throttle = throttle;
    if (cause) this.cause = cause;
  }
}

/** True iff an HTTP status / error body looks rate-limited or overloaded (mirrors drain isThrottled). */
function _statusIsThrottle(status, bodyText) {
  if (status === 429 || status === 503 || status === 529) return true;
  return /\b(429|529)\b|overloaded|rate[ _-]?limit|too many requests|quota/i.test(String(bodyText || ''));
}

function backendCredentialEnvPath() {
  return runtimePaths.runtimePath(BACKEND_CREDENTIAL_ENV_FILE);
}

function readBackendCredentialEnv() {
  let text;
  try { text = fs.readFileSync(backendCredentialEnvPath(), 'utf8'); }
  catch { return {}; }
  try { return require('./load-env').parseEnv(text); }
  catch { return {}; }
}

/**
 * WRITE-ONLY: set (or remove) a single API-key env var in the daemon-global backend.env. Never reads
 * process.env — only the on-disk file. A falsy/empty value REMOVES the key. Serializes KEY=VALUE
 * lines (sorted by key for stability), wrapping a value in double quotes when it contains '#',
 * whitespace, or a double-quote — this round-trips through lib/load-env.parseEnv, which strips ONE
 * pair of matching surrounding quotes and otherwise keeps the value verbatim. Writes ATOMICALLY:
 * tmp file (0o600) → rename. Returns { ok, env, set }.
 */
function writeBackendCredentialKey(envName, value) {
  const filePath = backendCredentialEnvPath();
  const obj = readBackendCredentialEnv();
  if (value) {
    obj[envName] = String(value);
  } else {
    delete obj[envName];
  }
  const lines = Object.keys(obj).sort().map((k) => {
    const v = String(obj[k]);
    const quoted = /[#\s"]/.test(v);
    return `${k}=${quoted ? '"' + v + '"' : v}`;
  });
  const text = lines.join('\n') + (lines.length ? '\n' : '');
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  return { ok: true, env: envName, set: Boolean(value) };
}

function _resolveNamedApiKey(names, opts = {}) {
  if (opts.key) return opts.key;
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  const globalEnv = readBackendCredentialEnv();
  for (const name of names) {
    if (globalEnv[name]) return globalEnv[name];
  }
  return '';
}

/**
 * Resolve the OpenRouter API key. Order: explicit opts.key (a caller may pass overlay.config.backend.key
 * when present) > process env > daemon-global backend.env. Returns '' when none — callers treat '' as unauthed.
 */
function _resolveApiKey(opts = {}) {
  return _resolveNamedApiKey(['OPENROUTER_API_KEY', 'OPENROUTER_KEY'], opts);
}

/**
 * Resolve the standalone Z.AI / GLM API key. Official docs use ZAI_API_KEY; the GLM/Zhipu aliases
 * are accepted for local convenience without persisting secrets in overlay config.
 */
function _resolveZaiApiKey(opts = {}) {
  return _resolveNamedApiKey(['ZAI_API_KEY', 'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'BIGMODEL_API_KEY'], opts);
}

function _callChatCompletions(opts, cfg) {
  // scheme:'http' (e.g. local Ollama) uses the http module; default stays https. opts.httpsModule
  // injection still wins (tests). allowNoKey:true skips the key requirement + omits Authorization.
  const httpsMod = opts.httpsModule || (cfg.scheme === 'http' ? http : https);
  const key = cfg.resolveKey ? cfg.resolveKey(opts) : '';
  if (!key && !cfg.allowNoKey) {
    return Promise.reject(new ApiBackendError(cfg.missingKeyMessage));
  }
  const messages = opts.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Promise.reject(new ApiBackendError(`${cfg.functionName}: opts.messages must be a non-empty array`));
  }
  const body = JSON.stringify({
    model: opts.model || cfg.defaultModel,
    max_tokens: opts.maxTokens || 1024,
    ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
    messages,
  });
  const timeoutMs = opts.timeoutMs || API_CALL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = httpsMod.request(
        {
          hostname: cfg.host,
          ...(cfg.port ? { port: cfg.port } : {}),
          path: cfg.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
            ...(cfg.headers || {}),
          },
        },
        (res) => {
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { s += d; });
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new ApiBackendError(
                `${cfg.providerName} API returned HTTP ${status}: ${String(s).slice(0, 500)}`,
                { status, throttle: _statusIsThrottle(status, s) }
              ));
              return;
            }
            let parsed;
            try { parsed = JSON.parse(s); }
            catch (e) { reject(new ApiBackendError(`${cfg.providerName} API returned non-JSON body`, { status, cause: e })); return; }
            // OpenAI-compatible chat-completions shape: choices[0].message.content + usage.
            const text = (parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
              && typeof parsed.choices[0].message.content === 'string')
              ? parsed.choices[0].message.content
              : '';
            resolve({ text, usage: (parsed && parsed.usage) || null, raw: parsed });
          });
        }
      );
    } catch (e) {
      reject(new ApiBackendError(`${cfg.providerName} API request failed to start: ${e && e.message ? e.message : e}`, { cause: e }));
      return;
    }
    req.on('error', (e) => reject(new ApiBackendError(`${cfg.providerName} API network error: ${e && e.message ? e.message : e}`, { cause: e })));
    req.setTimeout(timeoutMs, () => req.destroy(new ApiBackendError(`${cfg.providerName} API request timed out`, { throttle: true })));
    req.write(body);
    req.end();
  });
}

/**
 * IN-PROCESS chat-completions call over Node `https` (NO child process, NO SDK). Mirrors the raw-HTTPS
 * shape of lib/embed-haiku.callClaude.
 *
 * @param {object} opts
 *   @param {Array}  opts.messages — chat messages [{ role, content }, ...] (required, non-empty).
 *   @param {string} [opts.model]  — model id (default OPENROUTER_DEFAULT_MODEL).
 *   @param {string} [opts.key]    — API key override; falls back to OPENROUTER_API_KEY / OPENROUTER_KEY.
 *   @param {number} [opts.maxTokens] — max_tokens for the completion (default 1024).
 *   @param {number} [opts.timeoutMs] — request timeout (default API_CALL_TIMEOUT_MS).
 *   @param {object} [opts.httpsModule] — injectable https module for tests (default Node `https`).
 * @returns {Promise<{ text: string, usage: (object|null), raw: object }>}
 * @throws {ApiBackendError} on a missing key, non-200 status, or a network/timeout/parse failure.
 */
function callApi(opts = {}) {
  return _callChatCompletions(opts, {
    functionName: 'callApi',
    providerName: 'OpenRouter',
    host: OPENROUTER_HOST,
    path: OPENROUTER_PATH,
    defaultModel: OPENROUTER_DEFAULT_MODEL,
    resolveKey: _resolveApiKey,
    missingKeyMessage: 'OpenRouter API key not set (OPENROUTER_API_KEY)',
  });
}

/**
 * IN-PROCESS standalone Z.AI GLM chat-completions call (NO OpenRouter, NO child process).
 *
 * @param {object} opts
 *   @param {Array}  opts.messages — chat messages [{ role, content }, ...] (required, non-empty).
 *   @param {string} [opts.model]  — model id (default ZAI_DEFAULT_MODEL).
 *   @param {string} [opts.key]    — API key override; falls back to ZAI_API_KEY / GLM aliases.
 *   @param {number} [opts.maxTokens] — max_tokens for the completion (default 1024).
 *   @param {number} [opts.timeoutMs] — request timeout (default API_CALL_TIMEOUT_MS).
 *   @param {object} [opts.httpsModule] — injectable https module for tests (default Node `https`).
 * @returns {Promise<{ text: string, usage: (object|null), raw: object }>}
 */
function callZaiApi(opts = {}) {
  return _callChatCompletions(opts, {
    functionName: 'callZaiApi',
    providerName: 'Z.AI',
    host: ZAI_HOST,
    path: ZAI_PATH,
    defaultModel: ZAI_DEFAULT_MODEL,
    resolveKey: _resolveZaiApiKey,
    missingKeyMessage: 'Z.AI API key not set (ZAI_API_KEY)',
    headers: { 'Accept-Language': 'en-US,en' },
  });
}

/**
 * IN-PROCESS chat-completions call to a LOCAL Ollama server (http, OpenAI-compatible, NO key).
 *
 * For fully-local/offline LLM backends (e.g. an offline Kaggle kernel): the same local model that
 * drives the agent also serves the subconscious grader + judge/drain. Host/port from OLLAMA_HOST
 * (default 127.0.0.1:11434); model from overlay.config.backend.model (default OLLAMA_DEFAULT_MODEL).
 */
function callOllamaApi(opts = {}) {
  const endpoint = _resolveOllamaEndpoint();
  return _callChatCompletions(opts, {
    functionName: 'callOllamaApi',
    providerName: 'Ollama',
    ...endpoint,
    defaultModel: OLLAMA_DEFAULT_MODEL,
    allowNoKey: true,
  });
}

function listOllamaModels(opts = {}) {
  const endpoint = _resolveOllamaTagsEndpoint();
  const httpMod = opts.httpModule || opts.httpsModule || (endpoint.scheme === 'http' ? http : https);
  const timeoutMs = opts.timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = httpMod.request(
        {
          hostname: endpoint.host,
          ...(endpoint.port ? { port: endpoint.port } : {}),
          path: endpoint.path,
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
        (res) => {
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { s += d; });
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new ApiBackendError(`Ollama tags returned HTTP ${status}: ${String(s).slice(0, 500)}`, { status }));
              return;
            }
            let parsed;
            try { parsed = JSON.parse(s); }
            catch (e) { reject(new ApiBackendError('Ollama tags returned non-JSON body', { status, cause: e })); return; }
            const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
            resolve(models
              .map((m) => ({
                id: String((m && (m.name || m.model)) || '').trim(),
                size: m && typeof m.size === 'number' ? m.size : undefined,
                modifiedAt: m && (m.modified_at || m.modifiedAt) ? String(m.modified_at || m.modifiedAt) : undefined,
              }))
              .filter((m) => m.id));
          });
        }
      );
    } catch (e) {
      reject(new ApiBackendError(`Ollama tags request failed to start: ${e && e.message ? e.message : e}`, { cause: e }));
      return;
    }
    req.on('error', (e) => reject(new ApiBackendError(`Ollama tags network error: ${e && e.message ? e.message : e}`, { cause: e })));
    req.setTimeout(timeoutMs, () => req.destroy(new ApiBackendError('Ollama tags request timed out')));
    req.end();
  });
}

function listOpenRouterModels(opts = {}) {
  const httpsMod = opts.httpsModule || https;
  const timeoutMs = opts.timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = httpsMod.request(
        {
          hostname: OPENROUTER_HOST,
          path: OPENROUTER_MODELS_PATH,
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
        (res) => {
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { s += d; });
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new ApiBackendError(`OpenRouter models returned HTTP ${status}: ${String(s).slice(0, 500)}`, { status }));
              return;
            }
            let parsed;
            try { parsed = JSON.parse(s); }
            catch (e) { reject(new ApiBackendError('OpenRouter models returned non-JSON body', { status, cause: e })); return; }
            const models = Array.isArray(parsed && parsed.data) ? parsed.data : [];
            resolve(models
              .map((m) => ({
                id: String((m && m.id) || '').trim(),
                name: m && m.name ? String(m.name) : undefined,
                contextLength: m && typeof m.context_length === 'number' ? m.context_length : undefined,
              }))
              .filter((m) => m.id));
          });
        }
      );
    } catch (e) {
      reject(new ApiBackendError(`OpenRouter models request failed to start: ${e && e.message ? e.message : e}`, { cause: e }));
      return;
    }
    req.on('error', (e) => reject(new ApiBackendError(`OpenRouter models network error: ${e && e.message ? e.message : e}`, { cause: e })));
    req.setTimeout(timeoutMs, () => req.destroy(new ApiBackendError('OpenRouter models request timed out')));
    req.end();
  });
}

async function runOllamaJudgeLoop(args = {}) {
  return _runHostedApiJudgeLoop(args, { callApiFn: callOllamaApi, defaultModel: OLLAMA_DEFAULT_MODEL });
}

// ---- in-process judge loop helpers ---------------------------------------------------

/** Minimal in-process JSON GET/POST over Node `http` (the daemon is plain http on localhost). */
function _httpJson(httpMod, method, urlStr, bodyObj, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const headers = { Accept: 'application/json' };
    if (payload != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = httpMod.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          const status = res.statusCode || 0;
          let parsed = null;
          try { parsed = s ? JSON.parse(s) : {}; } catch { parsed = { _raw: s }; }
          resolve({ status, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('judge HTTP request timed out')));
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** Build the judge reasoning prompt for a slice of /judge/next items (mirrors the skill's contract). */
function _buildJudgeMessages(items) {
  const system =
    'You are using the self-learn skill edge-judge mode to adjudicate an orchestrator note graph. CONSERVATIVE by ' +
    'default: similarity is necessary but NOT sufficient — the default edge verdict is NO edge, and ' +
    'two notes must be the SAME fact (not merely related) to consolidate. For each item decide a ' +
    'verdict. Reply with JSON ONLY, no prose, of the exact shape: ' +
    '{"verdicts":[ <verdict>, ... ]} where each <verdict> is one of: ' +
    '{"keepEdge":{"from":"<key>","to":"<key>","kind":"blocking"?}} | ' +
    '{"pruneEdge":{"from":"<key>","to":"<key>"}} | ' +
    '{"createEdge":{"from":"note:<id>","to":"<key>","weight":0.6}} | ' +
    '{"supersedeTask":{"old":"<key>","new":"<key>","reason":"..."}} | ' +
    '{"repairTask":{"task_key":"<key>","action":"remove_dependency|release_hold|cancel_task|escalate","dependency":"<key>?","reason":"..."}} | ' +
    '{"followupTriage":{"task_key":"<key>","action":"approve|reject|escalate","guidance_id":"<id>?","reason":"..."}} | ' +
    '{"taskDecision":{"task_key":"<key>","action":"approve|kick_back|merge|discard|cancel|escalate","reason":"..."}} | ' +
    '{"consolidate":{"keep":"note:<id>","supersede":["note:<id>"...],"why":"..."}} | ' +
    '{"surfaceCluster":{"keys":["note:<id>"...],"why":"..."}} | ' +
    '{"markJudged":"note:<id>"}. ' +
    'For readiness-repair items, use repairTask and choose one of the item allowed_actions. ' +
    'Every orphan item you resolve (even a NO-edge outcome) MUST carry a markJudged for its note key.';
  const user = 'Adjudicate these items and return the verdicts JSON:\n' + JSON.stringify(items, null, 2);
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Extract the verdicts[] array from the model's text reply (tolerant of code-fence / prose wrap). */
function _parseVerdicts(text) {
  const s = String(text || '');
  const parseOne = (raw) => {
    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.verdicts)) return obj.verdicts;
    return (obj.keepEdge || obj.pruneEdge || obj.createEdge || obj.supersedeTask
      || obj.repairTask || obj.followupTriage || obj.taskDecision
      || obj.consolidate || obj.surfaceCluster || obj.markJudged) ? [obj] : null;
  };
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = parseOne(fenced[1].trim());
    if (parsed) return parsed;
  }
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        candidates.push(s.slice(i, j + 1));
        break;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = parseOne(candidates[i]);
    if (parsed) return parsed;
  }
  return [];
}

function _normalizeJudgeVerdicts(verdicts, items) {
  const byId = new Map((Array.isArray(items) ? items : []).map((it) => [it && it.id, it]));
  return (Array.isArray(verdicts) ? verdicts : []).map((v) => {
    if (!v || typeof v !== 'object') return v;
    if (v.taskDecision && v.taskDecision.task_key && !v.taskDecision.source_action) {
      const item = (Array.isArray(items) ? items : []).find((it) => it
        && it.kind === 'task-decision'
        && (it.task_key === v.taskDecision.task_key || (it.task && it.task.key === v.taskDecision.task_key)));
      if (item && item.action) {
        return { ...v, taskDecision: { ...v.taskDecision, source_action: item.action } };
      }
    }
    if (!v.verdict || v.repairTask) return v;
    const item = byId.get(v.id);
    if (!item) return v;
    if (item.kind === 'task-decision') {
      const action = v.verdict.action || v.verdict.verdict;
      if (!action) return v;
      return {
        taskDecision: {
          task_key: item.task && item.task.key || item.task_key,
          action,
          source_action: item.action || null,
          reason: v.verdict.reason || v.verdict.why || 'task decision verdict',
        },
      };
    }
    if (item.kind !== 'readiness-repair') return v;
    const action = v.verdict.action || v.verdict.verdict;
    if (!action) return v;
    return {
      repairTask: {
        task_key: item.task && item.task.key || item.task_key,
        action,
        dependency: v.verdict.dependency || item.dependency_key || null,
        reason: v.verdict.reason || v.verdict.why || 'readiness repair verdict',
      },
    };
  });
}

/**
 * IN-PROCESS judge loop — the API analogue of the spawned agentic judge drain. Walks the daemon's
 * judge loop ITSELF (Node `http`, NO child process): GET /judge/next → reason each item via callApi →
 * POST /judge/verdict. Resolves a DRAIN-RESULT-shaped object so lib/headless-drain.js consumes it
 * interchangeably with a spawn result ({ exitCode, stdout, stderr, timedOut, spawnError }); a throttle
 * surfaces in stderr (+ exitCode != 0) so recordDrainOutcome folds it into the backoff governor.
 *
 * @param {object} args
 *   @param {string} args.daemonUrl  — daemon base URL (e.g. http://localhost:8787) (required).
 *   @param {number} [args.budget]   — max items this run adjudicates (the /judge/next budget).
 *   @param {string} [args.node]     — eager node key; omit for the periodic cursor-walked path.
 *   @param {string} [args.model]    — model id passed to callApi (default OPENROUTER_DEFAULT_MODEL).
 *   @param {string} [args.key]      — API key override (else env).
 *   @param {object} [args.httpModule]  — injectable http module for tests (default Node `http`).
 *   @param {object} [args.httpsModule] — injectable https module forwarded to callApi (tests).
 *   @param {Function} [args.callApiFn] — injectable callApi for tests (default this module's callApi).
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, spawnError: null }>}
 */
async function _runHostedApiJudgeLoop(args = {}, defaults = {}) {
  const httpMod = args.httpModule || http;
  const callApiFn = args.callApiFn || defaults.callApiFn || callApi;
  const defaultModel = defaults.defaultModel || OPENROUTER_DEFAULT_MODEL;
  const daemonUrl = String(args.daemonUrl || '').replace(/\/$/, '');
  if (!daemonUrl) {
    return { exitCode: 1, stdout: '', stderr: 'runJudgeLoop: daemonUrl is required', timedOut: false, spawnError: null };
  }
  const budget = Math.max(1, Math.min(Number.isFinite(Number(args.budget)) ? Number(args.budget) : 6, 50));
  const ws = args.workspace ? `&workspace=${encodeURIComponent(args.workspace)}` : '';
  const nextPath = args.node
    ? `/judge/next?node=${encodeURIComponent(args.node)}&budget=${budget}${ws}`
    : `/judge/next?budget=${budget}${ws}`;
  const debugJudge = String(process.env.HEADLESS_DRAIN_DEBUG_JUDGE || '').trim() === '1';
  const debugSnippet = (value, max = 1200) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

  try {
    // 1) Pull work.
    const httpTimeoutMs = Math.max(1000,
      Number(process.env.HEADLESS_DRAIN_JUDGE_HTTP_TIMEOUT_MS)
      || Number(args.httpTimeoutMs)
      || Number(args.timeoutMs)
      || 10000);
    const next = await _httpJson(httpMod, 'GET', `${daemonUrl}${nextPath}`, null, httpTimeoutMs);
    if (next.status < 200 || next.status >= 300) {
      return { exitCode: 1, stdout: '', stderr: `GET /judge/next HTTP ${next.status}`, timedOut: false, spawnError: null };
    }
    const items = (next.body && Array.isArray(next.body.items)) ? next.body.items : [];
    if (next.body && next.body.idle === true) {
      return { exitCode: 0, stdout: 'judge idle: nothing to adjudicate', stderr: '', timedOut: false, spawnError: null };
    }
    if (items.length === 0) {
      return { exitCode: 0, stdout: 'judge: no items returned', stderr: '', timedOut: false, spawnError: null };
    }

    // 2) Reason each item IN-PROCESS via the hosted API (no child process).
    const apiOut = await callApiFn({
      messages: _buildJudgeMessages(items),
      model: args.model || defaultModel,
      key: args.key,
      httpsModule: args.httpsModule,
      timeoutMs: args.timeoutMs,
    });
    const verdicts = _normalizeJudgeVerdicts(_parseVerdicts(apiOut && apiOut.text), items);
    if (debugJudge || verdicts.length === 0) {
      const prefix = verdicts.length === 0 ? 'JUDGE api zero-verdict' : 'JUDGE api';
      process.stdout.write(`[headless-drain] ${prefix} items=${items.length} verdicts=${verdicts.length} text=${debugSnippet(apiOut && apiOut.text)}\n`);
    }

    // 3) Apply. An empty verdicts array still POSTs nothing harmful — but skip the round-trip.
    let applied = null;
    if (verdicts.length) {
      const verdictPath = args.workspace
        ? `/judge/verdict?workspace=${encodeURIComponent(args.workspace)}`
        : '/judge/verdict';
      const post = await _httpJson(httpMod, 'POST', `${daemonUrl}${verdictPath}`, { verdicts }, httpTimeoutMs);
      if (post.status < 200 || post.status >= 300) {
        return { exitCode: 1, stdout: '', stderr: `POST /judge/verdict HTTP ${post.status}`, timedOut: false, spawnError: null };
      }
      applied = post.body && post.body.applied;
      if (debugJudge) {
        process.stdout.write(`[headless-drain] JUDGE applied=${debugSnippet(JSON.stringify(applied))}\n`);
      }
    }
    return {
      exitCode: 0,
      stdout: `judge: adjudicated ${items.length} item(s), ${verdicts.length} verdict(s)` +
        (applied ? ` applied=${JSON.stringify(applied)}` : ''),
      stderr: '',
      timedOut: false,
      spawnError: null,
    };
  } catch (e) {
    // Surface a throttle in the stderr text so the drain's isThrottled() folds it into the backoff
    // governor (the in-process analogue of a spawned child printing a 429 to stderr).
    const isThrottle = e instanceof ApiBackendError && e.throttle;
    const msg = e && e.message ? e.message : String(e);
    return {
      exitCode: 1,
      stdout: '',
      stderr: isThrottle ? `429 rate limit / overloaded: ${msg}` : msg,
      timedOut: false,
      spawnError: null,
    };
  }
}

async function runJudgeLoop(args = {}) {
  return _runHostedApiJudgeLoop(args, { callApiFn: callApi, defaultModel: OPENROUTER_DEFAULT_MODEL });
}

async function runZaiJudgeLoop(args = {}) {
  return _runHostedApiJudgeLoop(args, { callApiFn: callZaiApi, defaultModel: ZAI_DEFAULT_MODEL });
}

/**
 * The OpenRouter API backend provider (kind 'api') — the IN-PROCESS hosted-API path.
 *
 * isAuthed() reflects OPENROUTER_API_KEY / OPENROUTER_KEY presence (so the dashboard shows readiness
 * and the drain's /16 hard-block covers an unauthed api backend). callApi / runJudgeLoop drive the
 * model with Node `https`/`http` IN-PROCESS — NO child process is ever spawned on this path.
 */
const openRouterProvider = {
  id: 'openrouter',
  displayName: 'OpenRouter (API, in-process)',
  kind: 'api',
  defaultModel: OPENROUTER_DEFAULT_MODEL,
  apiKeyEnv: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],

  /** True iff an OpenRouter (or generic) API key is present. No child process is ever spawned. */
  isAuthed() {
    return Boolean(_resolveApiKey());
  },

  /** IN-PROCESS single chat-completions call (Node `https`, no child). Resolves { text, usage }. */
  callApi(opts) {
    return callApi(opts);
  },

  listModels(opts) {
    return listOpenRouterModels(opts);
  },

  /** IN-PROCESS judge loop (the API analogue of the headless judge drain — no child process). */
  runJudgeLoop(args) {
    return runJudgeLoop(args);
  },
};

/**
 * The standalone Z.AI GLM API backend provider (kind 'api') — direct api.z.ai hosted API path.
 *
 * This is intentionally separate from OpenRouter: it reads ZAI_API_KEY (plus GLM/Zhipu aliases) and
 * POSTs directly to Z.AI's OpenAI-compatible chat-completions endpoint with glm-5.2 as the default.
 */
const zaiProvider = {
  id: 'zai',
  displayName: 'Z.AI GLM (API, in-process)',
  kind: 'api',
  defaultModel: ZAI_DEFAULT_MODEL,
  apiKeyEnv: ['ZAI_API_KEY', 'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'BIGMODEL_API_KEY'],

  isAuthed() {
    return Boolean(_resolveZaiApiKey());
  },

  callApi(opts) {
    return callZaiApi(opts);
  },

  runJudgeLoop(args) {
    return runZaiJudgeLoop(args);
  },
};

/**
 * The LOCAL Ollama backend provider (kind 'api') — fully offline, no key, no child process.
 *
 * Drives a local Ollama server (OpenAI-compatible, http://127.0.0.1:11434 by default) so the
 * subconscious grader + judge/drain run on the SAME local open-weight model as the agent. isAuthed()
 * is always true (no key needed); if the server is down, callApi/runJudgeLoop fail gracefully and the
 * grader degrades to the heuristic loop.
 */
const ollamaProvider = {
  id: 'ollama',
  displayName: 'Ollama (local, in-process)',
  kind: 'api',
  defaultModel: OLLAMA_DEFAULT_MODEL,

  isAuthed() {
    return true;
  },

  callApi(opts) {
    return callOllamaApi(opts);
  },

  listModels(opts) {
    return listOllamaModels(opts);
  },

  runJudgeLoop(args) {
    return runOllamaJudgeLoop(args);
  },
};

// =====================================================================================
// Cross-platform CLI binary resolver (shared by the Codex + Cursor agentic-cli providers)
// =====================================================================================
// Mirrors resolveClaudeBin's PATH-lookup strategy without the Claude-specific desktop-app probe:
// Codex/Cursor are installed as ordinary PATH binaries (npm -g / curl installer), so the
// well-known-absolute-path probe Claude needs does not apply. Resolution order:
//   1. explicit env override (e.g. CODEX_BIN / CURSOR_BIN).
//   2. PATH lookup via `where` (Windows, returns .cmd/.exe shims too) / `which` (POSIX).
//   3. bare name fallback — the OS resolves it at spawn time (and isAvailable stays false until
//      a real hit, so a not-installed CLI never falsely reports available).

/**
 * Resolve a bare CLI command to an absolute path via the OS PATH index, cross-platform.
 * On Windows `where` lists every match (including .cmd/.exe/.bat shims) newline-separated; we take
 * the first. On POSIX `which` returns the single resolved path. Returns '' when nothing resolves
 * (so callers can distinguish a real PATH hit from the bare-name fallback).
 *
 * @param {string} name — the bare command name (e.g. 'codex', 'cursor-agent').
 * @returns {string} absolute path of the first PATH hit, or '' if none.
 */
function resolveCliOnPath(name) {
  const isWin = process.platform === 'win32';
  try {
    const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
    const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (hit) return hit;
  } catch { /* ignore — treat as not found */ }
  return '';
}

/**
 * Resolve an agentic-CLI binary with an env override taking precedence over a PATH lookup.
 * Returns the override, else the first PATH hit, else the bare name (OS resolves at spawn).
 *
 * @param {string} envVar — the override env var name (e.g. 'CODEX_BIN').
 * @param {string} name   — the bare command name (e.g. 'codex').
 * @returns {string} override | absolute PATH hit | bare name.
 */
function resolveAgenticBin(envVar, name) {
  const override = process.env[envVar];
  if (override) return override;
  return resolveCliOnPath(name) || name;
}

// =====================================================================================
// CODEX provider (kind 'agentic-cli') — OpenAI Codex CLI, headless `codex exec`
// =====================================================================================
// Headless contract verified against the OpenAI Codex docs (developers.openai.com/codex):
//   - non-interactive entrypoint is the SUBCOMMAND `codex exec <prompt>` (not a -p flag);
//   - `-m`/`--model` selects the model;
//   - `--json` emits newline-delimited JSONL events on stdout (progress goes to stderr); the
//     terminal event carries the final agent message;
//   - `--dangerously-bypass-approvals-and-sandbox` is the analogue of Claude's
//     --dangerously-skip-permissions (skips approvals + disables the sandbox);
//   - `--cd <dir>` selects the working root.
// There is NO per-invocation MCP-config flag for `codex exec` (MCP is config-file only via
// ~/.codex/config.toml), so buildInvocation OMITS an mcp flag and carries mcpConfig through on the
// returned object (see the /22 record_decision). Auth lives at ~/.codex/auth.json or env
// CODEX_API_KEY/OPENAI_API_KEY. Bin override: CODEX_BIN.

function codexNativeTarget() {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', exe: 'codex' };
    if (process.arch === 'x64') return { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', exe: 'codex' };
  }
  if (process.platform === 'linux' || process.platform === 'android') {
    if (process.arch === 'arm64') return { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', exe: 'codex' };
    if (process.arch === 'x64') return { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', exe: 'codex' };
  }
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', exe: 'codex.exe' };
    return { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', exe: 'codex.exe' };
  }
  return null;
}

function resolveNativeCodexFromShim(bin) {
  const target = codexNativeTarget();
  if (!target || !bin || bin === 'codex') return '';
  let real;
  try { real = fs.realpathSync(bin); } catch { return ''; }
  const candidates = [];
  if (path.basename(real).toLowerCase() === 'codex.js') {
    const packageRoot = path.resolve(path.dirname(real), '..');
    candidates.push(path.join(packageRoot, 'node_modules', target.pkg, 'vendor', target.triple, 'bin', target.exe));
  }
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return '';
}

/** Resolve the `codex` CLI binary (env override CODEX_BIN > native PATH hit > PATH shim > bare 'codex'). */
function resolveCodexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const bin = resolveCliOnPath('codex') || 'codex';
  const native = resolveNativeCodexFromShim(bin);
  if (native) return native;
  if (process.platform === 'win32' && (/\.(cmd|ps1)$/i.test(bin) || path.basename(bin).toLowerCase() === 'codex')) {
    const native = path.join(
      path.dirname(bin),
      'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64',
      'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'
    );
    try { if (fs.existsSync(native)) return native; } catch { /* fall through to shim */ }
  }
  return bin;
}

const codexProvider = {
  id: 'codex',
  displayName: 'OpenAI Codex (local CLI)',
  kind: 'agentic-cli',

  resolveBin() {
    return resolveCodexBin();
  },

  /**
   * True iff the resolved binary looks usable: an explicit CODEX_BIN override, or a PATH hit that
   * exists on disk. A not-installed CLI resolves to the bare 'codex' fallback (no PATH hit) and
   * returns false here — WITHOUT throwing (resolveCliOnPath swallows the spawnSync failure).
   */
  isAvailable() {
    const bin = resolveCodexBin();
    if (bin === 'codex') return false; // bare fallback ⇒ no real PATH hit / override ⇒ not installed
    try { return fs.existsSync(bin); } catch { return false; }
  },

  /**
   * True iff headless creds are present. `codex exec` authenticates via env CODEX_API_KEY (or the
   * generic OPENAI_API_KEY), OR an interactive `codex login` that writes ~/.codex/auth.json
   * ($CODEX_HOME/auth.json when set). Best-effort: env key OR the auth.json file present.
   */
  isAuthed() {
    if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return true;
    try {
      const home = process.env.CODEX_HOME
        || path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex');
      return fs.existsSync(path.join(home, 'auth.json'));
    } catch { return false; }
  },

  /**
   * Build a ready-to-spawn `codex exec` invocation. Does NOT spawn. Mirrors the Claude flag
   * semantics as closely as Codex's headless surface supports.
   * @param {object} opts
   *   @param {string}  opts.prompt    — the exec prompt (required).
   *   @param {string} [opts.model]    — model id (-m/--model; default 'gpt-5.4-mini').
   *   @param {string} [opts.mcpConfig]— carried through on the return (NO codex exec flag for it).
   *   @param {string|string[]} [opts.addDir] — dir(s) to grant; Codex exec supports one working root, so the first becomes --cd.
   *   @param {number} [opts.budget]   — advisory item budget (not a CLI flag; carried through).
   * @returns {{ bin, args, env, budget, mcpConfig }}
   */
  buildInvocation(opts = {}) {
    const { prompt, model, mcpConfig, addDir, budget } = opts;
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('codexProvider.buildInvocation: opts.prompt is required');
    }
    const bin = resolveCodexBin();
    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--config', 'model_reasoning_effort="high"',
      '--model', model || 'gpt-5.4-mini',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    if (addDir) {
      const firstDir = (Array.isArray(addDir) ? addDir : [addDir]).find(Boolean);
      if (firstDir) args.push('--cd', firstDir);
    }
    // The prompt is the trailing positional arg to `codex exec`.
    args.push(prompt);
    // mcpConfig has no codex-exec flag (config-file only) — carry it through, do not drop silently.
    return { bin, args, env: agenticCliEnv(), budget, mcpConfig };
  },

  /**
   * Best-effort parse of a `codex exec --json` stdout stream into the SAME shape
   * claudeProvider.parseResult returns ({ result, usage, raw }). The stream is newline-delimited
   * JSON events; Codex's terminal event is the final agent message. We accept the common event
   * shapes Codex emits without over-fitting: the last event carrying a textual message wins for
   * `result`, and a `usage`/`token_usage` object (wherever it appears) populates `usage`. A
   * malformed/partial stream never throws — absent fields stay null.
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
      if (!evt || typeof evt !== 'object') continue;
      // Final agent message: Codex tags the terminal item variously; accept the documented
      // 'agent_message'/'item.completed' families plus a generic top-level string `message`.
      const msg = (typeof evt.message === 'string' && evt.message)
        || (evt.msg && typeof evt.msg.message === 'string' && evt.msg.message)
        || (evt.item && typeof evt.item.text === 'string' && evt.item.text)
        || (typeof evt.last_agent_message === 'string' && evt.last_agent_message)
        || null;
      if (msg) result = msg;
      if (evt.usage) usage = evt.usage;
      else if (evt.token_usage) usage = evt.token_usage;
      else if (evt.msg && evt.msg.usage) usage = evt.msg.usage;
    }
    return { result, usage, raw: text };
  },
};

// =====================================================================================
// CURSOR provider (kind 'agentic-cli') — Cursor CLI, headless `cursor-agent -p`
// =====================================================================================
// Headless contract verified against the Cursor docs (cursor.com/docs/cli):
//   - non-interactive via `cursor-agent -p <prompt>` (`-p`/`--print`);
//   - `--model <id>` selects the model;
//   - `--output-format json` emits a SINGLE JSON object on completion with fields
//     { type:"result", subtype, is_error, duration_ms, result:"<assistant text>", session_id, ... };
//   - `--force` (a.k.a. --yolo) is the analogue of --dangerously-skip-permissions (applies file
//     changes without confirmation).
// Cursor's headless surface documents NO per-invocation MCP-config flag and NO --add-dir analogue,
// so buildInvocation OMITS both and carries mcpConfig/addDir through on the return (see /22
// record_decision). Auth: env CURSOR_API_KEY (or --api-key / CURSOR_AUTH_TOKEN), or `cursor-agent
// login` whose on-disk creds path is undocumented — isAuthed is best-effort (env key OR ~/.cursor
// present). Bin override: CURSOR_BIN; default command name 'cursor-agent'.

/** Resolve the `cursor-agent` CLI binary (env override CURSOR_BIN > PATH > bare 'cursor-agent'). */
function resolveCursorBin() {
  return resolveAgenticBin('CURSOR_BIN', 'cursor-agent');
}

const cursorProvider = {
  id: 'cursor',
  displayName: 'Cursor (local CLI)',
  kind: 'agentic-cli',

  resolveBin() {
    return resolveCursorBin();
  },

  /**
   * True iff the resolved binary looks usable: an explicit CURSOR_BIN override, or a PATH hit that
   * exists on disk. A not-installed CLI resolves to bare 'cursor-agent' (no PATH hit) ⇒ false,
   * WITHOUT throwing.
   */
  isAvailable() {
    const bin = resolveCursorBin();
    if (bin === 'cursor-agent') return false; // bare fallback ⇒ not installed
    try { return fs.existsSync(bin); } catch { return false; }
  },

  /**
   * True iff headless creds are present. Cursor authenticates via env CURSOR_API_KEY (or the
   * --api-key flag / CURSOR_AUTH_TOKEN), OR an interactive `cursor-agent login` that stores creds
   * locally (the docs do not publish the path). Best-effort: env key OR a ~/.cursor dir present.
   */
  isAuthed() {
    if (process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN) return true;
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      return Boolean(home) && fs.existsSync(path.join(home, '.cursor'));
    } catch { return false; }
  },

  /**
   * Build a ready-to-spawn `cursor-agent -p` invocation. Does NOT spawn.
   * @param {object} opts
   *   @param {string}  opts.prompt    — the print-mode prompt (required).
   *   @param {string} [opts.model]    — model id (--model; omitted when unset → CLI default/login).
   *   @param {string} [opts.mcpConfig]— carried through on the return (NO cursor-agent flag for it).
   *   @param {string|string[]} [opts.addDir] — carried through (NO --add-dir analogue in headless).
   *   @param {number} [opts.budget]   — advisory item budget (not a CLI flag; carried through).
   * @returns {{ bin, args, env, budget, mcpConfig, addDir }}
   */
  buildInvocation(opts = {}) {
    const { prompt, model, mcpConfig, addDir, budget } = opts;
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('cursorProvider.buildInvocation: opts.prompt is required');
    }
    const bin = resolveCursorBin();
    const args = ['-p', prompt, '--output-format', 'json', '--force'];
    // Unlike Claude/Codex, Cursor has no documented default-model alias to fall back on, so we only
    // pass --model when the caller supplies one (else defer to the CLI's logged-in default).
    if (model) args.push('--model', model);
    // mcpConfig + addDir have no cursor-agent headless flags — carry through, don't drop silently.
    return { bin, args, env: agenticCliEnv(), budget, mcpConfig, addDir };
  },

  /**
   * Best-effort parse of a `cursor-agent -p --output-format json` stdout into the SAME shape
   * claudeProvider.parseResult returns ({ result, usage, raw }). `--output-format json` emits a
   * SINGLE JSON object { type:"result", result:"<text>", ... }; we also tolerate a stream-json
   * fallback (newline-delimited events) by scanning for the terminal result event. Never throws.
   */
  parseResult(out) {
    const text = String(out || '');
    let result = null;
    let usage = null;
    // Fast path: the whole stdout is one JSON object (the documented --output-format json shape).
    const trimmedAll = text.trim();
    if (trimmedAll && trimmedAll[0] === '{' && trimmedAll[trimmedAll.length - 1] === '}') {
      try {
        const obj = JSON.parse(trimmedAll);
        if (obj && typeof obj.result === 'string') result = obj.result;
        if (obj && obj.usage) usage = obj.usage;
        if (result !== null || usage !== null) return { result, usage, raw: text };
      } catch { /* fall through to the line scan */ }
    }
    // Fallback: stream-json — newline-delimited events; the terminal type:"result" event wins.
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let evt;
      try { evt = JSON.parse(t); } catch { continue; }
      if (evt && evt.type === 'result') {
        if (typeof evt.result === 'string') result = evt.result;
        if (evt.usage) usage = evt.usage;
      }
    }
    return { result, usage, raw: text };
  },
};

// ---- seed the registry with the first-party providers --------------------------------
registerProvider(claudeProvider);
registerProvider(openRouterProvider);
registerProvider(zaiProvider);
registerProvider(ollamaProvider);
registerProvider(codexProvider);
registerProvider(cursorProvider);

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
  zaiProvider,
  ollamaProvider,
  codexProvider,
  cursorProvider,
  // API backend seam (exported for direct use + tests)
  callApi,
  callZaiApi,
  callOllamaApi,
  listOllamaModels,
  listOpenRouterModels,
  runJudgeLoop,
  runZaiJudgeLoop,
  runOllamaJudgeLoop,
  ApiBackendError,
  OPENROUTER_DEFAULT_MODEL,
  ZAI_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_BASE_URL,
  BACKEND_CREDENTIAL_ENV_FILE,
  backendCredentialEnvPath,
  readBackendCredentialEnv,
  writeBackendCredentialKey,
  // Claude CLI helpers — re-exported by lib/claude-cli.js to keep existing callers working.
  resolveClaudeBin,
  loadEnvForClaude,
  needsShell,
  // Codex/Cursor CLI bin resolvers (exported for tests + parity with resolveClaudeBin).
  resolveCodexBin,
  resolveCursorBin,
  resolveCliOnPath,
};
