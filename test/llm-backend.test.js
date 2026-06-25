'use strict';
/**
 * llm-backend.test.js — unit tests for the pluggable LLM-backend seam (lib/llm-backend.js).
 *
 * Run: node --test test/llm-backend.test.js
 *
 * Covers (the seam's contract for THIS foundational task):
 *   - registry: register/lookup/list, kind validation, shape validation, replace-by-id.
 *   - Claude provider (kind 'agentic-cli'): resolveBin, isAuthed (env-gated), buildInvocation argv.
 *   - getActiveBackend: defaults to Claude when overlay.config.backend is unset/unknown; honors a
 *     valid override; carries model through.
 *   - API provider (kind 'api'): isAuthed env-gated; callApi does an IN-PROCESS HTTPS call (mocked
 *     http layer, NO child_process.spawn) returning { text, usage }, throwing a typed ApiBackendError
 *     (with .throttle) on non-200; runJudgeLoop walks /judge/next → callApi → /judge/verdict
 *     in-process and returns a drain-result shape — all with NO child process spawned.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const child_process = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const pathMod = require('node:path');

const backend = require('../lib/llm-backend');
const EMPTY_BACKEND_DATA_DIR = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'zonoid-empty-backend-env-'));

// ---- in-process mock helpers (api-backend path) ------------------------------------------------

/**
 * A fake https/http module whose `request(opts, cb)` returns a writable-ish request stub and drives a
 * fake IncomingMessage on the next tick. Records every request (opts + written body) so a test can
 * assert what was sent. `responder(opts, bodyText)` returns { status, body } for that request.
 * NEVER touches the network and NEVER uses child_process — proving the api path is pure in-process I/O.
 */
function makeFakeHttp(responder) {
  const requests = [];
  return {
    requests,
    request(opts, cb) {
      const rec = { opts, body: '' };
      requests.push(rec);
      const req = new EventEmitter();
      req.write = (chunk) => { rec.body += chunk; };
      req.setTimeout = () => {};
      req.destroy = (err) => { req.emit('error', err || new Error('destroyed')); };
      req.end = () => {
        setImmediate(() => {
          let r;
          try { r = responder(opts, rec.body); } catch (e) { req.emit('error', e); return; }
          const res = new EventEmitter();
          res.statusCode = r.status;
          res.setEncoding = () => {};
          cb(res);
          const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
          if (payload) res.emit('data', payload);
          res.emit('end');
        });
      };
      return req;
    },
  };
}

/** Run `fn` while child_process.spawn/spawnSync/exec/execSync are tripwires; assert none fired. */
async function assertNoChildProcess(fn) {
  const saved = {};
  let tripped = null;
  for (const m of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    saved[m] = child_process[m];
    child_process[m] = (...a) => { tripped = m; throw new Error(`child_process.${m} must NOT be called on the api path`); };
  }
  try {
    return await fn();
  } finally {
    for (const m of Object.keys(saved)) child_process[m] = saved[m];
    assert.equal(tripped, null, `api path spawned a child via child_process.${tripped}`);
  }
}

// Save/restore the env vars isAuthed() reads, so these tests are deterministic regardless of the
// runner's ambient environment. Returns a restore() that puts the originals back.
function withEnv(overrides) {
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY',
    'ZAI_API_KEY', 'GLM_API_KEY', 'ZHIPUAI_API_KEY', 'BIGMODEL_API_KEY',
    'ORCH_DATA', 'ZONOID_DATA', 'CLAUDE_PLUGIN_DATA',
    'ZONOID_CLAUDE_BIN', 'CLAUDE_BIN',
    // Codex/Cursor agentic-cli provider env (bin overrides + auth keys).
    'CODEX_BIN', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME',
    'CURSOR_BIN', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN',
    // Availability tests must not depend on whether the runner has codex/cursor-agent installed.
    'PATH'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(overrides || {})) process.env[k] = v;
  if (!overrides || (!Object.prototype.hasOwnProperty.call(overrides, 'ORCH_DATA')
    && !Object.prototype.hasOwnProperty.call(overrides, 'ZONOID_DATA')
    && !Object.prototype.hasOwnProperty.call(overrides, 'CLAUDE_PLUGIN_DATA'))) {
    process.env.ORCH_DATA = EMPTY_BACKEND_DATA_DIR;
  }
  return function restore() {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// --- registry: lookup of seeded first-party providers ------------------------------------------
test('registry: claude + hosted API providers are seeded and looked up by id', () => {
  const claude = backend.getProvider('claude');
  const openrouter = backend.getProvider('openrouter');
  const zai = backend.getProvider('zai');
  assert.ok(claude, 'claude provider registered');
  assert.equal(claude.id, 'claude');
  assert.equal(claude.kind, 'agentic-cli');
  assert.ok(openrouter, 'openrouter provider registered');
  assert.equal(openrouter.kind, 'api');
  assert.ok(zai, 'standalone Z.AI GLM provider registered');
  assert.equal(zai.kind, 'api');
  assert.equal(zai.defaultModel, 'glm-5.2');
  assert.equal(backend.getProvider('does-not-exist'), null, 'unknown id returns null');
});

test('registry: listProviders includes seeded providers', () => {
  const ids = backend.listProviders().map((p) => p.id);
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('openrouter'));
  assert.ok(ids.includes('zai'));
});

// --- registry: register / replace / validation -------------------------------------------------
test('registry: registerProvider adds a custom provider and replaces by id', () => {
  const fake = {
    id: 'fake-test-provider', displayName: 'Fake', kind: 'agentic-cli',
    isAuthed: () => true, resolveBin: () => 'fake', isAvailable: () => true,
    buildInvocation: () => ({ bin: 'fake', args: [], env: {} }), parseResult: () => ({}),
  };
  backend.registerProvider(fake);
  assert.equal(backend.getProvider('fake-test-provider'), fake);

  // Replacing by the same id swaps the object.
  const replacement = { ...fake, displayName: 'Fake v2' };
  backend.registerProvider(replacement);
  assert.equal(backend.getProvider('fake-test-provider').displayName, 'Fake v2');
});

test('registry: registerProvider rejects an invalid kind', () => {
  assert.throws(
    () => backend.registerProvider({ id: 'bad', displayName: 'Bad', kind: 'nonsense', isAuthed: () => false }),
    /kind must be one of/,
  );
});

test('registry: registerProvider rejects an agentic-cli provider missing required methods', () => {
  assert.throws(
    () => backend.registerProvider({ id: 'bad2', displayName: 'Bad2', kind: 'agentic-cli', isAuthed: () => false }),
    /agentic-cli provider must implement/,
  );
});

test('registry: registerProvider rejects a provider with no id', () => {
  assert.throws(
    () => backend.registerProvider({ displayName: 'NoId', kind: 'api', isAuthed: () => false }),
    /id must be a non-empty string/,
  );
});

// --- Claude provider: resolveBin ----------------------------------------------------------------
test('claude provider: resolveBin honors the ZONOID_CLAUDE_BIN override', () => {
  const restore = withEnv({ ZONOID_CLAUDE_BIN: '/custom/path/claude' });
  try {
    assert.equal(backend.claudeProvider.resolveBin(), '/custom/path/claude');
  } finally {
    restore();
  }
});

test('claude provider: resolveBin returns a non-empty string with no override', () => {
  const restore = withEnv({});
  try {
    const bin = backend.claudeProvider.resolveBin();
    assert.equal(typeof bin, 'string');
    assert.ok(bin.length > 0);
  } finally {
    restore();
  }
});

// --- Claude provider: isAuthed ------------------------------------------------------------------
test('claude provider: isAuthed reflects ANTHROPIC_API_KEY / OAuth token presence', () => {
  let restore = withEnv({});
  try {
    assert.equal(backend.claudeProvider.isAuthed(), false, 'no creds -> not authed');
  } finally { restore(); }

  restore = withEnv({ ANTHROPIC_API_KEY: 'sk-test' });
  try {
    assert.equal(backend.claudeProvider.isAuthed(), true, 'API key -> authed');
  } finally { restore(); }

  restore = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' });
  try {
    assert.equal(backend.claudeProvider.isAuthed(), true, 'OAuth token -> authed');
  } finally { restore(); }
});

// --- Claude provider: buildInvocation argv shape -----------------------------------------------
test('claude provider: buildInvocation produces the expected claude -p argv', () => {
  const restore = withEnv({ ZONOID_CLAUDE_BIN: '/bin/claude' });
  try {
    const inv = backend.claudeProvider.buildInvocation({
      prompt: 'do the thing', model: 'sonnet',
      mcpConfig: '/ws/.mcp.json', addDir: '/ws', budget: 5,
    });
    assert.equal(inv.bin, '/bin/claude');
    assert.ok(Array.isArray(inv.args));
    // headless flag set
    assert.equal(inv.args[0], '-p');
    assert.equal(inv.args[1], 'do the thing');
    assert.ok(inv.args.includes('--model'));
    assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'sonnet');
    assert.ok(inv.args.includes('--output-format'));
    assert.equal(inv.args[inv.args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(inv.args.includes('--verbose'));
    assert.ok(inv.args.includes('--dangerously-skip-permissions'));
    // mcp config wiring
    assert.ok(inv.args.includes('--mcp-config'));
    assert.equal(inv.args[inv.args.indexOf('--mcp-config') + 1], '/ws/.mcp.json');
    assert.ok(inv.args.includes('--strict-mcp-config'));
    // add-dir wiring
    assert.ok(inv.args.includes('--add-dir'));
    assert.equal(inv.args[inv.args.indexOf('--add-dir') + 1], '/ws');
    // budget carried through (not a CLI flag)
    assert.equal(inv.budget, 5);
    assert.ok(!inv.args.includes('--budget'), 'budget is not emitted as a CLI flag');
  } finally {
    restore();
  }
});

test('claude provider: buildInvocation defaults model to opus and omits optional flags', () => {
  const inv = backend.claudeProvider.buildInvocation({ prompt: 'hi' });
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'opus');
  assert.ok(!inv.args.includes('--mcp-config'), 'no mcpConfig -> no --mcp-config');
  assert.ok(!inv.args.includes('--add-dir'), 'no addDir -> no --add-dir');
});

test('claude provider: buildInvocation supports multiple add-dirs', () => {
  const inv = backend.claudeProvider.buildInvocation({ prompt: 'hi', addDir: ['/a', '/b'] });
  const addDirCount = inv.args.filter((a) => a === '--add-dir').length;
  assert.equal(addDirCount, 2);
  assert.ok(inv.args.includes('/a'));
  assert.ok(inv.args.includes('/b'));
});

test('claude provider: buildInvocation throws without a prompt', () => {
  assert.throws(() => backend.claudeProvider.buildInvocation({}), /prompt is required/);
});

// --- Claude provider: parseResult ---------------------------------------------------------------
test('claude provider: parseResult extracts the terminal result event', () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{}}',
    '{"type":"result","result":"final answer","usage":{"input_tokens":10,"output_tokens":3}}',
  ].join('\n');
  const parsed = backend.claudeProvider.parseResult(stream);
  assert.equal(parsed.result, 'final answer');
  assert.deepEqual(parsed.usage, { input_tokens: 10, output_tokens: 3 });
});

test('claude provider: parseResult tolerates malformed/empty output without throwing', () => {
  const parsed = backend.claudeProvider.parseResult('not json\n{bad}\n');
  assert.equal(parsed.result, null);
  assert.equal(parsed.usage, null);
});

// --- getActiveBackend ---------------------------------------------------------------------------
test('getActiveBackend: defaults to the Claude provider when overlay.config.backend is unset', () => {
  const r1 = backend.getActiveBackend(undefined);
  assert.equal(r1.providerId, 'claude');
  assert.equal(r1.provider.kind, 'agentic-cli');

  const r2 = backend.getActiveBackend({ config: {} });
  assert.equal(r2.providerId, 'claude');

  const r3 = backend.getActiveBackend({ config: { backend: {} } });
  assert.equal(r3.providerId, 'claude');
});

test('getActiveBackend: honors a valid provider override and carries the model through', () => {
  const r = backend.getActiveBackend({ config: { backend: { provider: 'openrouter', model: 'anthropic/claude-3.5' } } });
  assert.equal(r.providerId, 'openrouter');
  assert.equal(r.provider.kind, 'api');
  assert.equal(r.model, 'anthropic/claude-3.5');
});

test('getActiveBackend: selects standalone Z.AI GLM when configured', () => {
  const r = backend.getActiveBackend({ config: { backend: { provider: 'zai', model: 'glm-5.2' } } });
  assert.equal(r.providerId, 'zai');
  assert.equal(r.provider.kind, 'api');
  assert.equal(r.provider.defaultModel, backend.ZAI_DEFAULT_MODEL);
  assert.equal(r.model, 'glm-5.2');
});

test('getActiveBackend: unknown provider id falls back to Claude (soft fallback, no throw)', () => {
  const r = backend.getActiveBackend({ config: { backend: { provider: 'totally-unregistered' } } });
  assert.equal(r.providerId, 'claude');
  assert.equal(r.provider.id, 'claude');
});

// --- API provider stub --------------------------------------------------------------------------
test('api provider: isAuthed reflects OPENROUTER_API_KEY presence', () => {
  let restore = withEnv({});
  try {
    assert.equal(backend.openRouterProvider.isAuthed(), false);
  } finally { restore(); }

  restore = withEnv({ OPENROUTER_API_KEY: 'or-test' });
  try {
    assert.equal(backend.openRouterProvider.isAuthed(), true);
  } finally { restore(); }
});

test('api provider: Z.AI isAuthed reflects ZAI_API_KEY and GLM aliases', () => {
  let restore = withEnv({});
  try {
    assert.equal(backend.zaiProvider.isAuthed(), false);
  } finally { restore(); }

  restore = withEnv({ ZAI_API_KEY: 'zai-test' });
  try {
    assert.equal(backend.zaiProvider.isAuthed(), true, 'ZAI_API_KEY -> authed');
  } finally { restore(); }

  restore = withEnv({ GLM_API_KEY: 'glm-test' });
  try {
    assert.equal(backend.zaiProvider.isAuthed(), true, 'GLM_API_KEY alias -> authed');
  } finally { restore(); }
});

test('api provider: hosted API keys can come from daemon-global backend.env', async () => {
  const dataDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'zonoid-backend-env-'));
  fs.writeFileSync(pathMod.join(dataDir, backend.BACKEND_CREDENTIAL_ENV_FILE), [
    'OPENROUTER_API_KEY=global-openrouter',
    'ZAI_API_KEY=global-zai',
    '',
  ].join('\n'));
  const restore = withEnv({ ORCH_DATA: dataDir });
  try {
    assert.equal(backend.backendCredentialEnvPath(), pathMod.join(dataDir, 'backend.env'));
    assert.equal(backend.openRouterProvider.isAuthed(), true, 'OpenRouter key resolves from global backend.env');
    assert.equal(backend.zaiProvider.isAuthed(), true, 'Z.AI key resolves from global backend.env');

    const fake = makeFakeHttp((opts) => {
      assert.equal(opts.hostname, 'api.z.ai');
      assert.equal(opts.headers.Authorization, 'Bearer global-zai');
      return { status: 200, body: { choices: [{ message: { content: 'from global key' } }] } };
    });
    const out = await backend.callZaiApi({ messages: [{ role: 'user', content: 'hi' }], httpsModule: fake });
    assert.equal(out.text, 'from global key');
  } finally {
    restore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- API provider: callApi (IN-PROCESS HTTPS, no child process) --------------------------------
test('api provider: callApi does an IN-PROCESS HTTPS call and returns { text, usage } (no spawn)', async () => {
  const restore = withEnv({ OPENROUTER_API_KEY: 'or-key' });
  const fake = makeFakeHttp((opts, body) => {
    // Assert the request targets the OpenRouter chat-completions endpoint with bearer auth + model.
    assert.equal(opts.hostname, 'openrouter.ai');
    assert.equal(opts.path, '/api/v1/chat/completions');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers.Authorization, 'Bearer or-key');
    const sent = JSON.parse(body);
    assert.equal(sent.model, 'gpt-test');
    assert.ok(Array.isArray(sent.messages) && sent.messages.length >= 1);
    return { status: 200, body: { choices: [{ message: { content: 'hello world' } }], usage: { total_tokens: 12 } } };
  });
  try {
    const out = await assertNoChildProcess(() => backend.callApi({
      messages: [{ role: 'user', content: 'hi' }], model: 'gpt-test', httpsModule: fake,
    }));
    assert.equal(out.text, 'hello world', 'parses choices[0].message.content');
    assert.deepEqual(out.usage, { total_tokens: 12 }, 'carries usage through');
    assert.equal(fake.requests.length, 1, 'exactly one HTTPS request was made (in-process)');
  } finally { restore(); }
});

test('api provider: callZaiApi targets Z.AI directly with glm-5.2 default (no OpenRouter, no spawn)', async () => {
  const restore = withEnv({ ZAI_API_KEY: 'zai-key' });
  const fake = makeFakeHttp((opts, body) => {
    assert.equal(opts.hostname, 'api.z.ai');
    assert.equal(opts.path, '/api/paas/v4/chat/completions');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers.Authorization, 'Bearer zai-key');
    assert.equal(opts.headers['Accept-Language'], 'en-US,en');
    const sent = JSON.parse(body);
    assert.equal(sent.model, 'glm-5.2');
    assert.ok(Array.isArray(sent.messages) && sent.messages.length >= 1);
    return { status: 200, body: { choices: [{ message: { content: 'glm direct' } }], usage: { total_tokens: 9 } } };
  });
  try {
    const out = await assertNoChildProcess(() => backend.callZaiApi({
      messages: [{ role: 'user', content: 'hi' }], httpsModule: fake,
    }));
    assert.equal(out.text, 'glm direct');
    assert.deepEqual(out.usage, { total_tokens: 9 });
    assert.equal(fake.requests.length, 1, 'exactly one direct Z.AI HTTPS request was made');
  } finally { restore(); }
});

test('api provider: callApi rejects with ApiBackendError on a missing key (no spawn, no request)', async () => {
  const restore = withEnv({}); // no OPENROUTER_API_KEY
  const fake = makeFakeHttp(() => ({ status: 200, body: {} }));
  try {
    await assertNoChildProcess(async () => {
      await assert.rejects(
        () => backend.callApi({ messages: [{ role: 'user', content: 'hi' }], httpsModule: fake }),
        (e) => e instanceof backend.ApiBackendError && /api key/i.test(e.message),
      );
    });
    assert.equal(fake.requests.length, 0, 'no request attempted without a key');
  } finally { restore(); }
});

test('api provider: callApi maps a 429 to a typed ApiBackendError with throttle:true', async () => {
  const restore = withEnv({ OPENROUTER_API_KEY: 'or-key' });
  const fake = makeFakeHttp(() => ({ status: 429, body: { error: 'rate limited' } }));
  try {
    await assert.rejects(
      () => backend.callApi({ messages: [{ role: 'user', content: 'hi' }], httpsModule: fake }),
      (e) => e instanceof backend.ApiBackendError && e.status === 429 && e.throttle === true,
    );
  } finally { restore(); }
});

test('api provider: openRouterProvider.callApi delegates to the in-process callApi', async () => {
  const restore = withEnv({ OPENROUTER_API_KEY: 'or-key' });
  const fake = makeFakeHttp(() => ({ status: 200, body: { choices: [{ message: { content: 'via-provider' } }] } }));
  try {
    const out = await backend.openRouterProvider.callApi({ messages: [{ role: 'user', content: 'x' }], httpsModule: fake });
    assert.equal(out.text, 'via-provider');
  } finally { restore(); }
});

test('api provider: zaiProvider.callApi delegates to the direct Z.AI call', async () => {
  const restore = withEnv({ ZAI_API_KEY: 'zai-key' });
  const fake = makeFakeHttp(() => ({ status: 200, body: { choices: [{ message: { content: 'via-zai-provider' } }] } }));
  try {
    const out = await backend.zaiProvider.callApi({ messages: [{ role: 'user', content: 'x' }], httpsModule: fake });
    assert.equal(out.text, 'via-zai-provider');
    assert.equal(fake.requests[0].opts.hostname, 'api.z.ai');
  } finally { restore(); }
});

// --- API provider: runJudgeLoop (IN-PROCESS judge loop, no child process) ----------------------
test('api provider: runJudgeLoop walks /judge/next → callApi → /judge/verdict in-process (no spawn)', async () => {
  // Fake the daemon http: GET /judge/next returns one edge item; POST /judge/verdict acks applied.
  const fakeHttp = makeFakeHttp((opts) => {
    if (opts.method === 'GET' && /\/judge\/next/.test(opts.path)) {
      return { status: 200, body: { idle: false, items: [{ kind: 'edge', id: 'e1', from: { key: 'note:a' }, to: { key: 't1' } }] } };
    }
    if (opts.method === 'POST' && /\/judge\/verdict/.test(opts.path)) {
      return { status: 200, body: { ok: true, applied: { pruned: 1 } } };
    }
    return { status: 404, body: {} };
  });
  // Inject a callApi that returns a verdicts JSON (so we don't hit the real https path here).
  const callApiCalls = [];
  const fakeCallApi = async (o) => { callApiCalls.push(o); return { text: '{"verdicts":[{"pruneEdge":{"from":"note:a","to":"t1"}}]}', usage: null }; };

  const result = await assertNoChildProcess(() => backend.runJudgeLoop({
    daemonUrl: 'http://localhost:8787', budget: 6, httpModule: fakeHttp, callApiFn: fakeCallApi,
  }));
  // Drain-result shape (consumed interchangeably with a spawn result by headless-drain).
  assert.equal(result.exitCode, 0, 'clean run exits 0');
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, null);
  assert.match(result.stdout, /adjudicated 1 item/);
  // It actually walked the loop: a GET, a callApi, and a POST.
  assert.equal(callApiCalls.length, 1, 'callApi invoked once to reason the items');
  const methods = fakeHttp.requests.map((r) => `${r.opts.method} ${r.opts.path}`);
  assert.ok(methods.some((m) => /^GET \/judge\/next/.test(m)), 'GET /judge/next happened');
  assert.ok(methods.some((m) => /^POST \/judge\/verdict/.test(m)), 'POST /judge/verdict happened');
  // The verdicts parsed from the model reply were forwarded to the daemon.
  const postReq = fakeHttp.requests.find((r) => r.opts.method === 'POST');
  assert.deepEqual(JSON.parse(postReq.body).verdicts, [{ pruneEdge: { from: 'note:a', to: 't1' } }]);
});

test('api provider: runZaiJudgeLoop uses glm-5.2 as the default model', async () => {
  const fakeHttp = makeFakeHttp((opts) => {
    if (opts.method === 'GET' && /\/judge\/next/.test(opts.path)) {
      return { status: 200, body: { idle: false, items: [{ kind: 'edge', id: 'e1' }] } };
    }
    return { status: 404, body: {} };
  });
  const callApiCalls = [];
  const fakeCallApi = async (o) => { callApiCalls.push(o); return { text: '{"verdicts":[]}', usage: null }; };

  const result = await assertNoChildProcess(() => backend.runZaiJudgeLoop({
    daemonUrl: 'http://localhost:8787', httpModule: fakeHttp, callApiFn: fakeCallApi,
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(callApiCalls.length, 1);
  assert.equal(callApiCalls[0].model, 'glm-5.2');
});

test('api provider: runJudgeLoop on an idle queue returns exit 0 without calling callApi or POSTing', async () => {
  const fakeHttp = makeFakeHttp((opts) => {
    if (/\/judge\/next/.test(opts.path)) return { status: 200, body: { idle: true, items: [] } };
    return { status: 500, body: {} };
  });
  let called = false;
  const result = await backend.runJudgeLoop({
    daemonUrl: 'http://localhost:8787', httpModule: fakeHttp, callApiFn: async () => { called = true; return { text: '{}' }; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(called, false, 'idle queue must not call the API');
  assert.equal(fakeHttp.requests.filter((r) => r.opts.method === 'POST').length, 0, 'no verdict POST on idle');
});

test('api provider: runJudgeLoop surfaces a throttle in stderr (so the drain backoff sees it)', async () => {
  const fakeHttp = makeFakeHttp((opts) => {
    if (/\/judge\/next/.test(opts.path)) return { status: 200, body: { idle: false, items: [{ kind: 'edge', id: 'e1' }] } };
    return { status: 404, body: {} };
  });
  // callApi throws a throttling ApiBackendError → runJudgeLoop must NOT throw; it returns a failure
  // result whose stderr matches the drain's isThrottled() regex (429 / rate limit / overloaded).
  const throttled = new backend.ApiBackendError('OpenRouter API returned HTTP 429', { status: 429, throttle: true });
  const result = await backend.runJudgeLoop({
    daemonUrl: 'http://localhost:8787', httpModule: fakeHttp, callApiFn: async () => { throw throttled; },
  });
  assert.equal(result.exitCode, 1, 'a throttle is a non-clean run');
  assert.match(result.stderr, /\b429\b|rate limit|overloaded/i, 'stderr carries a throttle signal for the backoff governor');
  assert.equal(result.spawnError, null, 'no spawnError — this is an in-process failure, not a spawn failure');
});

test('api provider: runJudgeLoop requires a daemonUrl (clean failure result, not a throw)', async () => {
  const result = await backend.runJudgeLoop({ httpModule: makeFakeHttp(() => ({ status: 200, body: {} })) });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /daemonUrl/);
});

// ================================================================================================
// Codex + Cursor providers (kind 'agentic-cli') — task /22
// ================================================================================================
// These two providers mirror the Claude provider's interface exactly. We drive bin resolution via
// the CODEX_BIN / CURSOR_BIN env overrides (which short-circuit the spawnSync PATH lookup), pointing
// them at a real temp file for the "installed" case and clearing them for the "not-installed" case
// (bare-name fallback ⇒ isAvailable false, no throw). withEnv() manages those keys so the runner's
// ambient PATH/creds can't make these flaky.

// A real temp file that exists on disk, so an env-override bin resolves AND fs.existsSync() is true.
const INSTALLED_BIN = pathMod.join(os.tmpdir(), `zonoid-fake-cli-${process.pid}`);
try { fs.writeFileSync(INSTALLED_BIN, '#!/bin/sh\n'); } catch { /* best-effort; existsSync test guards */ }

// --- registry: codex + cursor seeded -----------------------------------------------------------
test('registry: codex + cursor providers are seeded and looked up by id', () => {
  const codex = backend.getProvider('codex');
  const cursor = backend.getProvider('cursor');
  assert.ok(codex, 'codex provider registered');
  assert.equal(codex.id, 'codex');
  assert.equal(codex.kind, 'agentic-cli');
  assert.ok(cursor, 'cursor provider registered');
  assert.equal(cursor.id, 'cursor');
  assert.equal(cursor.kind, 'agentic-cli');
  const ids = backend.listProviders().map((p) => p.id);
  assert.ok(ids.includes('codex') && ids.includes('cursor'), 'both appear in listProviders');
});

// --- Codex provider: resolveBin / isAvailable --------------------------------------------------
test('codex provider: resolveBin honors the CODEX_BIN override', () => {
  const restore = withEnv({ CODEX_BIN: '/custom/codex' });
  try { assert.equal(backend.codexProvider.resolveBin(), '/custom/codex'); } finally { restore(); }
});

test('codex provider: resolveBin unwraps the npm shim to the native vendor binary', { skip: process.platform === 'win32' }, () => {
  const targets = {
    'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
    'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
    'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  };
  const target = targets[`${process.platform}:${process.arch}`];
  if (!target) return;
  const [pkg, triple] = target;
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'zonoid-codex-shim-'));
  const binDir = pathMod.join(root, 'bin');
  const packageRoot = pathMod.join(root, 'lib', 'node_modules', '@openai', 'codex');
  const shim = pathMod.join(packageRoot, 'bin', 'codex.js');
  const native = pathMod.join(packageRoot, 'node_modules', pkg, 'vendor', triple, 'bin', 'codex');
  fs.mkdirSync(pathMod.dirname(shim), { recursive: true });
  fs.mkdirSync(pathMod.dirname(native), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(shim, '#!/usr/bin/env node\n');
  fs.chmodSync(shim, 0o755);
  fs.writeFileSync(native, '#!/bin/sh\n');
  fs.chmodSync(native, 0o755);
  fs.symlinkSync(shim, pathMod.join(binDir, 'codex'));
  const restore = withEnv({ PATH: [binDir, '/usr/bin', '/bin'].join(pathMod.delimiter) });
  try { assert.equal(backend.codexProvider.resolveBin(), fs.realpathSync(native)); } finally { restore(); }
});

test('codex provider: isAvailable true for an existing override bin, false (no throw) when not installed', () => {
  let restore = withEnv({ CODEX_BIN: INSTALLED_BIN });
  try { assert.equal(backend.codexProvider.isAvailable(), true, 'override pointing at a real file ⇒ available'); }
  finally { restore(); }

  // No override + no PATH hit (the bare-name fallback) ⇒ not installed ⇒ false, and MUST NOT throw.
  restore = withEnv({});
  try {
    let val;
    assert.doesNotThrow(() => { val = backend.codexProvider.isAvailable(); });
    // The runner host has no `codex` on PATH (verified at impl time); assert the not-installed contract.
    assert.equal(val, false, 'no override + no PATH hit ⇒ isAvailable false');
  } finally { restore(); }
});

test('codex provider: buildInvocation supplies a launchd-safe PATH with node', () => {
  const restore = withEnv({ CODEX_BIN: INSTALLED_BIN, PATH: '' });
  try {
    const inv = backend.codexProvider.buildInvocation({ prompt: 'judge one item' });
    const parts = String(inv.env.PATH || '').split(pathMod.delimiter);
    assert.ok(parts.includes(pathMod.dirname(process.execPath)), 'PATH includes current node directory');
    assert.ok(parts.includes('/usr/bin'), 'PATH keeps system env lookup available');
  } finally { restore(); }
});

// --- Codex provider: isAuthed ------------------------------------------------------------------
test('codex provider: isAuthed reflects CODEX_API_KEY / OPENAI_API_KEY / auth.json presence', () => {
  // Point CODEX_HOME at an empty temp dir so the no-creds case is deterministic (no auth.json there).
  const emptyHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'zonoid-codex-home-'));
  let restore = withEnv({ CODEX_HOME: emptyHome });
  try { assert.equal(backend.codexProvider.isAuthed(), false, 'no key + no auth.json ⇒ not authed'); }
  finally { restore(); }

  restore = withEnv({ CODEX_API_KEY: 'cx-test' });
  try { assert.equal(backend.codexProvider.isAuthed(), true, 'CODEX_API_KEY ⇒ authed'); } finally { restore(); }

  restore = withEnv({ OPENAI_API_KEY: 'sk-test' });
  try { assert.equal(backend.codexProvider.isAuthed(), true, 'OPENAI_API_KEY ⇒ authed'); } finally { restore(); }

  // auth.json present under CODEX_HOME ⇒ authed even with no env key.
  const authHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'zonoid-codex-auth-'));
  fs.writeFileSync(pathMod.join(authHome, 'auth.json'), '{"tokens":{}}');
  restore = withEnv({ CODEX_HOME: authHome });
  try { assert.equal(backend.codexProvider.isAuthed(), true, '~/.codex/auth.json ⇒ authed'); } finally { restore(); }
});

// --- Codex provider: buildInvocation argv ------------------------------------------------------
test('codex provider: buildInvocation produces the expected `codex exec` argv', () => {
  const restore = withEnv({ CODEX_BIN: '/bin/codex' });
  try {
    const inv = backend.codexProvider.buildInvocation({
      prompt: 'judge the diff', model: 'gpt-5.4-mini',
      mcpConfig: '/ws/.mcp.json', addDir: '/ws', budget: 6,
    });
    assert.equal(inv.bin, '/bin/codex');
    assert.ok(Array.isArray(inv.args));
    assert.equal(inv.args[0], 'exec', 'non-interactive subcommand is `exec`');
    assert.ok(inv.args.includes('--ignore-user-config'), 'drain execs must not inherit interactive MCP config');
    assert.ok(inv.args.includes('--ignore-rules'), 'drain execs must not inherit project/user exec rules');
    assert.ok(inv.args.includes('--ephemeral'), 'drain execs should not persist nested sessions');
    // per-run override keeps drains compatible with installed Codex CLIs that reject newer effort labels
    assert.ok(inv.args.includes('--config'));
    assert.equal(inv.args[inv.args.indexOf('--config') + 1], 'model_reasoning_effort="high"');
    // model selection
    assert.ok(inv.args.includes('--model'));
    assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'gpt-5.4-mini');
    // machine-readable output
    assert.ok(inv.args.includes('--json'));
    // auto-approve analogue of --dangerously-skip-permissions
    assert.ok(inv.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    // working-root wiring
    assert.ok(inv.args.includes('--cd'));
    assert.equal(inv.args[inv.args.indexOf('--cd') + 1], '/ws');
    // prompt is the trailing positional
    assert.equal(inv.args[inv.args.length - 1], 'judge the diff');
    // mcpConfig has NO codex-exec flag — carried through, NOT emitted as an arg.
    assert.equal(inv.mcpConfig, '/ws/.mcp.json');
    assert.ok(!inv.args.includes('--mcp-config'), 'codex exec has no per-run mcp flag');
    assert.ok(!inv.args.includes('--strict-mcp-config'));
    // budget carried through, not a CLI flag
    assert.equal(inv.budget, 6);
    assert.ok(!inv.args.includes('--budget'));
  } finally { restore(); }
});

test('codex provider: buildInvocation defaults model and throws without a prompt', () => {
  const inv = backend.codexProvider.buildInvocation({ prompt: 'hi' });
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'gpt-5.4-mini', 'defaults model');
  assert.ok(!inv.args.includes('--cd'), 'no addDir ⇒ no --cd');
  assert.throws(() => backend.codexProvider.buildInvocation({}), /prompt is required/);
});

// --- Codex provider: parseResult (shape parity with Claude) ------------------------------------
test('codex provider: parseResult extracts final message + usage into the Claude shape', () => {
  const stream = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"text":"intermediate"}}',
    '{"type":"agent_message","message":"final codex answer","usage":{"input_tokens":7,"output_tokens":2}}',
  ].join('\n');
  const parsed = backend.codexProvider.parseResult(stream);
  // Same key shape as claudeProvider.parseResult: { result, usage, raw }.
  assert.deepEqual(Object.keys(parsed).sort(), ['raw', 'result', 'usage']);
  assert.equal(parsed.result, 'final codex answer');
  assert.deepEqual(parsed.usage, { input_tokens: 7, output_tokens: 2 });
  assert.equal(typeof parsed.raw, 'string');
});

test('codex provider: parseResult tolerates malformed/empty output without throwing', () => {
  const parsed = backend.codexProvider.parseResult('not json\n{bad}\n');
  assert.equal(parsed.result, null);
  assert.equal(parsed.usage, null);
});

// --- Cursor provider: resolveBin / isAvailable -------------------------------------------------
test('cursor provider: resolveBin honors the CURSOR_BIN override', () => {
  const restore = withEnv({ CURSOR_BIN: '/custom/cursor-agent' });
  try { assert.equal(backend.cursorProvider.resolveBin(), '/custom/cursor-agent'); } finally { restore(); }
});

test('cursor provider: isAvailable true for an existing override bin, false (no throw) when not installed', () => {
  let restore = withEnv({ CURSOR_BIN: INSTALLED_BIN });
  try { assert.equal(backend.cursorProvider.isAvailable(), true); } finally { restore(); }

  restore = withEnv({});
  try {
    let val;
    assert.doesNotThrow(() => { val = backend.cursorProvider.isAvailable(); });
    assert.equal(val, false, 'no override + no PATH hit ⇒ isAvailable false');
  } finally { restore(); }
});

test('cursor provider: buildInvocation supplies a launchd-safe PATH with node', () => {
  const restore = withEnv({ CURSOR_BIN: INSTALLED_BIN, PATH: '' });
  try {
    const inv = backend.cursorProvider.buildInvocation({ prompt: 'judge one item' });
    const parts = String(inv.env.PATH || '').split(pathMod.delimiter);
    assert.ok(parts.includes(pathMod.dirname(process.execPath)), 'PATH includes current node directory');
    assert.ok(parts.includes('/usr/bin'), 'PATH keeps system env lookup available');
  } finally { restore(); }
});

// --- Cursor provider: isAuthed -----------------------------------------------------------------
test('cursor provider: isAuthed reflects CURSOR_API_KEY / CURSOR_AUTH_TOKEN presence', () => {
  let restore = withEnv({ CURSOR_API_KEY: 'cur-test' });
  try { assert.equal(backend.cursorProvider.isAuthed(), true, 'CURSOR_API_KEY ⇒ authed'); } finally { restore(); }

  restore = withEnv({ CURSOR_AUTH_TOKEN: 'tok-test' });
  try { assert.equal(backend.cursorProvider.isAuthed(), true, 'CURSOR_AUTH_TOKEN ⇒ authed'); } finally { restore(); }

  // No env key: result depends only on whether a ~/.cursor dir exists; either way it MUST be a
  // boolean and MUST NOT throw (the not-installed/no-creds contract).
  restore = withEnv({});
  try {
    let val;
    assert.doesNotThrow(() => { val = backend.cursorProvider.isAuthed(); });
    assert.equal(typeof val, 'boolean', 'isAuthed returns a boolean with no env key, no throw');
  } finally { restore(); }
});

// --- Cursor provider: buildInvocation argv -----------------------------------------------------
test('cursor provider: buildInvocation produces the expected `cursor-agent -p` argv', () => {
  const restore = withEnv({ CURSOR_BIN: '/bin/cursor-agent' });
  try {
    const inv = backend.cursorProvider.buildInvocation({
      prompt: 'review attempt', model: 'sonnet-4.5',
      mcpConfig: '/ws/.mcp.json', addDir: '/ws', budget: 6,
    });
    assert.equal(inv.bin, '/bin/cursor-agent');
    // print/non-interactive flag + prompt
    assert.equal(inv.args[0], '-p');
    assert.equal(inv.args[1], 'review attempt');
    // machine-readable output
    assert.ok(inv.args.includes('--output-format'));
    assert.equal(inv.args[inv.args.indexOf('--output-format') + 1], 'json');
    // auto-approve analogue of --dangerously-skip-permissions
    assert.ok(inv.args.includes('--force'));
    // model selection
    assert.ok(inv.args.includes('--model'));
    assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'sonnet-4.5');
    // mcpConfig + addDir have NO cursor-agent headless flag — carried through, NOT emitted as args.
    assert.equal(inv.mcpConfig, '/ws/.mcp.json');
    assert.equal(inv.addDir, '/ws');
    assert.ok(!inv.args.includes('--mcp-config'), 'cursor-agent headless has no mcp flag');
    assert.ok(!inv.args.includes('--add-dir'), 'cursor-agent headless has no add-dir flag');
    assert.equal(inv.budget, 6);
  } finally { restore(); }
});

test('cursor provider: buildInvocation omits --model when unset and throws without a prompt', () => {
  const inv = backend.cursorProvider.buildInvocation({ prompt: 'hi' });
  assert.ok(!inv.args.includes('--model'), 'no model ⇒ no --model (defer to CLI/login default)');
  assert.ok(inv.args.includes('-p') && inv.args.includes('--force'));
  assert.throws(() => backend.cursorProvider.buildInvocation({}), /prompt is required/);
});

// --- Cursor provider: parseResult (shape parity with Claude) -----------------------------------
test('cursor provider: parseResult parses the single-object json shape into the Claude shape', () => {
  const single = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'final cursor answer', session_id: 's1', usage: { total_tokens: 9 },
  });
  const parsed = backend.cursorProvider.parseResult(single);
  assert.deepEqual(Object.keys(parsed).sort(), ['raw', 'result', 'usage']);
  assert.equal(parsed.result, 'final cursor answer');
  assert.deepEqual(parsed.usage, { total_tokens: 9 });
});

test('cursor provider: parseResult also handles a stream-json fallback', () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{}}',
    '{"type":"result","result":"streamed answer"}',
  ].join('\n');
  const parsed = backend.cursorProvider.parseResult(stream);
  assert.equal(parsed.result, 'streamed answer');
});

test('cursor provider: parseResult tolerates malformed/empty output without throwing', () => {
  const parsed = backend.cursorProvider.parseResult('not json\n{bad}\n');
  assert.equal(parsed.result, null);
  assert.equal(parsed.usage, null);
});

// --- parseResult shape parity across all three agentic-cli providers ---------------------------
test('agentic-cli: codex + cursor parseResult return the SAME key shape as claude', () => {
  const claudeKeys = Object.keys(backend.claudeProvider.parseResult('{}')).sort();
  assert.deepEqual(Object.keys(backend.codexProvider.parseResult('{}')).sort(), claudeKeys);
  assert.deepEqual(Object.keys(backend.cursorProvider.parseResult('{}')).sort(), claudeKeys);
});

// --- getActiveBackend selects codex / cursor by overlay provider id ----------------------------
test('getActiveBackend: selects codex when overlay.config.backend.provider is "codex"', () => {
  const r = backend.getActiveBackend({ config: { backend: { provider: 'codex', model: 'gpt-5-codex' } } });
  assert.equal(r.providerId, 'codex');
  assert.equal(r.provider.id, 'codex');
  assert.equal(r.provider.kind, 'agentic-cli');
  assert.equal(r.model, 'gpt-5-codex');
});

test('getActiveBackend: selects cursor when overlay.config.backend.provider is "cursor"', () => {
  const r = backend.getActiveBackend({ config: { backend: { provider: 'cursor', model: 'sonnet-4.5' } } });
  assert.equal(r.providerId, 'cursor');
  assert.equal(r.provider.id, 'cursor');
  assert.equal(r.provider.kind, 'agentic-cli');
  assert.equal(r.model, 'sonnet-4.5');
});
