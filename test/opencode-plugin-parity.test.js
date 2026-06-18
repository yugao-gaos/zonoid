#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  injectClassifiedContext,
  postWorkspace,
  promptFromParts,
} = require('../packages/opencode-plugin/lib/prompt-context');

test('postWorkspace sends the OpenCode workspace path to /workspace', async () => {
  const calls = [];
  const result = await postWorkspace('/repo/app', async (path, body) => {
    calls.push({ path, body });
    return { ok: true };
  });

  assert.deepEqual(calls, [{ path: '/workspace', body: { path: '/repo/app' } }]);
  assert.deepEqual(result, { ok: true });
});

test('postWorkspace fails open when the daemon is unavailable', async () => {
  await assert.doesNotReject(postWorkspace('/repo/app', async () => {
    throw new Error('offline');
  }));
});

test('promptFromParts extracts only existing text parts', () => {
  const first = { type: 'text', text: 'fix login' };
  const file = { type: 'file', path: 'app.js' };
  const second = { type: 'text', text: 'keep tests focused' };

  assert.equal(promptFromParts([first, file, second]), 'fix login\nkeep tests focused');
});

test('injectClassifiedContext posts classify shape and appends returned context', async () => {
  const first = { type: 'text', text: 'fix login' };
  const file = { type: 'file', path: 'app.js' };
  const second = { type: 'text', text: 'keep tests focused' };
  const output = { message: { id: 'm1' }, parts: [first, file, second] };
  const calls = [];

  const changed = await injectClassifiedContext(
    { sessionID: 'oc-session' },
    output,
    {
      workspace: '/repo/app',
      post: async (path, body) => {
        calls.push({ path, body });
        return { additional_context: '[Graph context] use task opencode/t1' };
      },
    },
  );

  assert.equal(changed, true);
  assert.deepEqual(calls, [{
    path: '/classify',
    body: {
      prompt: 'fix login\nkeep tests focused',
      session_id: 'oc-session',
      workspace: '/repo/app',
    },
  }]);
  assert.strictEqual(output.parts[0], first);
  assert.strictEqual(output.parts[1], file);
  assert.strictEqual(output.parts[2], second);
  assert.deepEqual(output.parts[3], {
    type: 'text',
    text: '[Graph context] use task opencode/t1',
  });
});

test('injectClassifiedContext accepts camel-case classify context', async () => {
  const output = { parts: [{ type: 'text', text: 'audit hooks' }] };

  const changed = await injectClassifiedContext(
    { sessionID: 'oc-session' },
    output,
    { workspace: '/repo/app', post: async () => ({ additionalContext: '[Model routing] main=sonnet' }) },
  );

  assert.equal(changed, true);
  assert.equal(output.parts.at(-1).text, '[Model routing] main=sonnet');
});

test('injectClassifiedContext leaves parts unchanged when classify returns no context', async () => {
  const first = { type: 'text', text: 'hello' };
  const output = { parts: [first] };

  const changed = await injectClassifiedContext(
    { sessionID: 'oc-session' },
    output,
    { workspace: '/repo/app', post: async () => ({ additional_context: '' }) },
  );

  assert.equal(changed, false);
  assert.deepEqual(output.parts, [first]);
});

test('injectClassifiedContext fails open when classify is unavailable', async () => {
  const first = { type: 'text', text: 'hello' };
  const output = { parts: [first] };

  const changed = await injectClassifiedContext(
    { sessionID: 'oc-session' },
    output,
    {
      workspace: '/repo/app',
      post: async () => {
        throw new Error('offline');
      },
    },
  );

  assert.equal(changed, false);
  assert.deepEqual(output.parts, [first]);
});
