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
 *   - API provider (kind 'api'): isAuthed env-gated; the call seam THROWS a clear "not implemented".
 */

const { test } = require('node:test');
const assert = require('node:assert');

const backend = require('../lib/llm-backend');

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

test('api provider: callApi throws a clear "not implemented" error', () => {
  assert.throws(() => backend.openRouterProvider.callApi(), /not implemented/i);
});

test('api provider: runJudgeLoop throws a clear "not implemented" error', () => {
  assert.throws(() => backend.openRouterProvider.runJudgeLoop(), /not implemented/i);
});
