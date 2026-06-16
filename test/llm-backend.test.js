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

const backend = require('../lib/llm-backend');

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
    'ZONOID_CLAUDE_BIN', 'CLAUDE_BIN'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(overrides || {})) process.env[k] = v;
  return function restore() {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// --- registry: lookup of seeded first-party providers ------------------------------------------
test('registry: claude + openrouter providers are seeded and looked up by id', () => {
  const claude = backend.getProvider('claude');
  const openrouter = backend.getProvider('openrouter');
  assert.ok(claude, 'claude provider registered');
  assert.equal(claude.id, 'claude');
  assert.equal(claude.kind, 'agentic-cli');
  assert.ok(openrouter, 'openrouter provider registered');
  assert.equal(openrouter.kind, 'api');
  assert.equal(backend.getProvider('does-not-exist'), null, 'unknown id returns null');
});

test('registry: listProviders includes both seeded providers', () => {
  const ids = backend.listProviders().map((p) => p.id);
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('openrouter'));
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
