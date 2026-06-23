#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  gradeSearchRound,
  createDefaultGraderBackend,
  extractJson,
  coerceResult,
  projectCandidate,
  projectEvidence,
  buildGraderPayload,
} = require('../lib/subconscious/llm-grader');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

// ---- mock backends -----------------------------------------------------------------
// A mock backend is just a function (or {complete}) returning the raw model text. We capture the
// prompt/system it was handed so tests can assert what was serialized into the call.

/** Backend that replies with a fixed string, recording the last call. */
function fixedBackend(replyText) {
  const calls = [];
  const fn = async ({ prompt, system }) => { calls.push({ prompt, system }); return replyText; };
  fn.calls = calls;
  return fn;
}

/** Backend that replies with JSON.stringify(obj). */
function jsonBackend(obj) {
  return fixedBackend(JSON.stringify(obj));
}

function candidates() {
  return [
    { key: 'note:auth-1', title: 'OAuth token refresh', summary: 'how refresh tokens rotate', score: 0.81, tier: 'rag' },
    { key: 'note:auth-2', title: 'Login rate limiting', summary: 'rate limit on login attempts', score: 0.74, tier: 'rag' },
    { key: 'task:cache-9', title: 'Cache warmup job', summary: 'unrelated cache cron', score: 0.69, tier: 'rag' },
  ];
}

// ---- continue vs stop ---------------------------------------------------------------

test('continue=true with a reformulated nextQuery is honored', async () => {
  const backend = jsonBackend({
    continue: true,
    nextQuery: 'oauth refresh token rotation window',
    kept: ['note:auth-1'],
    abstain: false,
    aggregate: 'Found refresh-token rotation context.',
  });
  const out = await gradeSearchRound(
    { intent: 'how does token refresh work', originalQuery: 'token refresh', candidates: candidates(), round: 1, maxRounds: 4 },
    { backend }
  );
  assert.equal(out.continue, true);
  assert.equal(out.nextQuery, 'oauth refresh token rotation window');
  assert.deepEqual(out.kept, ['note:auth-1']);
  assert.equal(out.abstain, false);
  assert.equal(out.parsed, true);
});

test('continue=false forces nextQuery to null even if the model returns one', async () => {
  const backend = jsonBackend({
    continue: false,
    nextQuery: 'a query the model should not have emitted on stop',
    kept: ['note:auth-1', 'note:auth-2'],
    abstain: false,
    aggregate: 'Two relevant notes; enough context.',
  });
  const out = await gradeSearchRound(
    { intent: 'auth context', originalQuery: 'auth', candidates: candidates(), round: 2, maxRounds: 4 },
    { backend }
  );
  assert.equal(out.continue, false);
  assert.equal(out.nextQuery, null);
  assert.deepEqual(out.kept, ['note:auth-1', 'note:auth-2']);
});

test('continue=true with a blank nextQuery degrades to stop (cannot search without a query)', async () => {
  const backend = jsonBackend({
    continue: true,
    nextQuery: '   ',
    kept: ['note:auth-1'],
    abstain: false,
    aggregate: 'ok',
  });
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 3 },
    { backend }
  );
  assert.equal(out.continue, false);
  assert.equal(out.nextQuery, null);
});

// ---- keep / drop selection ----------------------------------------------------------

test('keeps only intent-relevant candidates; drops high-cosine-but-off-topic', async () => {
  // The cache task has a real score but is off-topic for an auth intent — the model drops it.
  const backend = jsonBackend({
    continue: false,
    nextQuery: null,
    kept: ['note:auth-1', 'note:auth-2'],
    abstain: false,
    aggregate: 'Kept the two auth notes; dropped the unrelated cache task.',
  });
  const out = await gradeSearchRound(
    { intent: 'authentication flow', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.deepEqual(out.kept.sort(), ['note:auth-1', 'note:auth-2']);
  assert.ok(!out.kept.includes('task:cache-9'), 'off-topic cache task must be dropped');
});

test('invented candidate keys are filtered out (model cannot keep a key it was not given)', async () => {
  const backend = jsonBackend({
    continue: false,
    nextQuery: null,
    kept: ['note:auth-1', 'note:HALLUCINATED', 'task:does-not-exist'],
    abstain: false,
    aggregate: 'one real key plus invented ones',
  });
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.deepEqual(out.kept, ['note:auth-1']);
});

test('duplicate kept keys are deduped', async () => {
  const backend = jsonBackend({
    continue: false, nextQuery: null,
    kept: ['note:auth-1', 'note:auth-1', 'note:auth-2'],
    abstain: false, aggregate: 'dupes',
  });
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.deepEqual(out.kept, ['note:auth-1', 'note:auth-2']);
});

// ---- abstain ------------------------------------------------------------------------

test('abstain=true empties kept and is reported', async () => {
  const backend = jsonBackend({
    continue: false, nextQuery: null,
    kept: ['note:auth-1'],       // even though the model listed one, abstain wins → empty
    abstain: true,
    aggregate: 'Nothing cleared the relevance bar for this intent.',
  });
  const out = await gradeSearchRound(
    { intent: 'something none of the candidates address', originalQuery: 'xyz', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.equal(out.abstain, true);
  assert.deepEqual(out.kept, []);
});

test('empty kept implies abstain even when the model says abstain=false', async () => {
  const backend = jsonBackend({
    continue: false, nextQuery: null,
    kept: [],
    abstain: false,
    aggregate: 'nothing relevant',
  });
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.equal(out.abstain, true);
  assert.deepEqual(out.kept, []);
});

// ---- aggregate ----------------------------------------------------------------------

test('aggregate is passed through', async () => {
  const agg = 'Synthesized: refresh tokens rotate on a 30-day window; login is rate-limited at 5/min.';
  const backend = jsonBackend({
    continue: false, nextQuery: null,
    kept: ['note:auth-1', 'note:auth-2'], abstain: false,
    aggregate: agg,
  });
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.equal(out.aggregate, agg);
});

test('aggregate is truncated to the hard cap', () => {
  const huge = 'x'.repeat(5000);
  const out = coerceResult({ continue: false, nextQuery: null, kept: [], abstain: true, aggregate: huge }, new Set());
  assert.ok(out.aggregate.length <= 2000, `aggregate length ${out.aggregate.length} should be <= 2000`);
});

// ---- parse-failure fallback ---------------------------------------------------------

test('non-JSON reply falls back to conservative defaults (stop, abstain, keep nothing)', async () => {
  const backend = fixedBackend('I think the first note looks relevant but I am not sure. No JSON here.');
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 4 },
    { backend }
  );
  assert.equal(out.parsed, false);
  assert.equal(out.continue, false);
  assert.equal(out.nextQuery, null);
  assert.deepEqual(out.kept, []);
  assert.equal(out.abstain, true);
  assert.equal(out.aggregate, '');
  assert.equal(out.fallback_reason, 'parse_failure');
});

test('a backend that throws falls back without throwing', async () => {
  const backend = async () => { throw new Error('network down'); };
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 4 },
    { backend }
  );
  assert.equal(out.parsed, false);
  assert.equal(out.continue, false);
  assert.deepEqual(out.kept, []);
  assert.equal(out.abstain, true);
  assert.ok(/backend_error/.test(out.fallback_reason), 'fallback_reason should record the backend error');
});

test('JSON wrapped in a ```json code fence + prose is still parsed', async () => {
  const fenced = 'Here is my verdict:\n```json\n' +
    JSON.stringify({ continue: true, nextQuery: 'reformulated', kept: ['note:auth-2'], abstain: false, aggregate: 'ok' }) +
    '\n```\nThat is my decision.';
  const backend = fixedBackend(fenced);
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 4 },
    { backend }
  );
  assert.equal(out.parsed, true);
  assert.equal(out.continue, true);
  assert.equal(out.nextQuery, 'reformulated');
  assert.deepEqual(out.kept, ['note:auth-2']);
});

// ---- prompt construction (what the backend actually receives) -----------------------

test('the system prompt and a JSON payload with intent + candidates are handed to the backend', async () => {
  const backend = jsonBackend({ continue: false, nextQuery: null, kept: [], abstain: true, aggregate: '' });
  await gradeSearchRound(
    { intent: 'how does token refresh work', originalQuery: 'token refresh', candidates: candidates(), round: 2, maxRounds: 5 },
    { backend }
  );
  assert.equal(backend.calls.length, 1);
  const { prompt, system } = backend.calls[0];
  assert.ok(/grader/i.test(system), 'system prompt identifies the grader role');
  assert.ok(/STRICT JSON/i.test(system), 'system prompt demands strict JSON');
  assert.ok(prompt.includes('how does token refresh work'), 'payload carries the intent');
  assert.ok(prompt.includes('note:auth-1'), 'payload carries candidate keys');
  // round/budget surfaced for the model.
  const payloadObj = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(payloadObj.round, 2);
  assert.equal(payloadObj.max_rounds, 5);
  assert.equal(payloadObj.rounds_remaining, 3);
});

test('prior evidence is projected into the payload (objects and free-text strings)', () => {
  const { payload } = buildGraderPayload(
    {
      intent: 'i', originalQuery: 'q',
      evidenceSoFar: [
        { key: 'note:prior-1', title: 'Prior finding', summary: 'a thing we already learned' },
        'a free-text observation',
        null,
      ],
      candidates: candidates(),
    },
    { round: 1, maxRounds: 2, maxCandidates: 24, maxEvidence: 12 }
  );
  assert.equal(payload.evidence_so_far.length, 2);
  assert.equal(payload.evidence_so_far[0].key, 'note:prior-1');
  assert.equal(payload.evidence_so_far[1].text, 'a free-text observation');
});

test('candidates without a key are dropped from the serialized payload', () => {
  const { payload, candidateKeys } = buildGraderPayload(
    { intent: 'i', originalQuery: 'q', candidates: [{ title: 'no key here', summary: 's' }, { key: 'note:has-key', title: 't' }] },
    { round: 1, maxRounds: 2, maxCandidates: 24, maxEvidence: 12 }
  );
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].key, 'note:has-key');
  assert.ok(candidateKeys.has('note:has-key'));
});

// ---- backend adapter shapes ---------------------------------------------------------

test('a {complete} backend object is supported', async () => {
  let got = null;
  const backend = { complete: async ({ prompt }) => { got = prompt; return JSON.stringify({ continue: false, nextQuery: null, kept: ['note:auth-1'], abstain: false, aggregate: 'ok' }); } };
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.ok(got && got.includes('note:auth-1'));
  assert.deepEqual(out.kept, ['note:auth-1']);
});

test('a backend returning {result:"..."} (claude/codex provider shape) is unwrapped', async () => {
  const backend = async () => ({ result: JSON.stringify({ continue: false, nextQuery: null, kept: ['note:auth-2'], abstain: false, aggregate: 'r' }) });
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.deepEqual(out.kept, ['note:auth-2']);
});

// ---- default backend over the shared provider seam ----------------------------------

test('createDefaultGraderBackend drives an api-kind provider via callApi', async () => {
  let seenMessages = null;
  const fakeBackendLib = {
    getActiveBackend() {
      return {
        providerId: 'openrouter',
        model: 'test-model',
        config: { key: 'k' },
        provider: {
          kind: 'api',
          async callApi({ messages }) { seenMessages = messages; return { text: JSON.stringify({ continue: false, nextQuery: null, kept: [], abstain: true, aggregate: '' }) }; },
        },
      };
    },
  };
  const backend = createDefaultGraderBackend({ overlay: {}, backendLib: fakeBackendLib });
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.ok(Array.isArray(seenMessages) && seenMessages.length === 2, 'system + user messages were sent');
  assert.equal(seenMessages[0].role, 'system');
  assert.equal(seenMessages[1].role, 'user');
  assert.equal(out.abstain, true);
});

test('createDefaultGraderBackend rejects an agentic-cli active provider', async () => {
  const fakeBackendLib = {
    getActiveBackend() {
      return { providerId: 'claude', model: 'opus', config: {}, provider: { kind: 'agentic-cli' } };
    },
  };
  const backend = createDefaultGraderBackend({ overlay: {}, backendLib: fakeBackendLib });
  // The grader swallows the backend error into a fallback (never throws), recording the reason.
  const out = await gradeSearchRound(
    { intent: 'auth', originalQuery: 'auth', candidates: candidates(), round: 1, maxRounds: 2 },
    { backend }
  );
  assert.equal(out.parsed, false);
  assert.ok(/backend_error/.test(out.fallback_reason));
  assert.ok(/api-kind/.test(out.fallback_reason), 'error explains an api-kind backend is required');
});

// ---- small unit helpers -------------------------------------------------------------

test('extractJson handles bare object, fenced, and prose-wrapped spans; null on garbage', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('prefix {"a":3} suffix'), { a: 3 });
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('projectCandidate keeps known fields and rounds numeric scores', () => {
  const c = projectCandidate({ key: 'note:x', title: 'T', summary: 'S', kind: 'note', tier: 'rag', score: 0.812345, weight: 0.5 });
  assert.equal(c.key, 'note:x');
  assert.equal(c.kind, 'note');
  assert.equal(c.score, 0.812);
  assert.equal(c.weight, 0.5);
});

test('projectEvidence wraps strings and drops empties', () => {
  const ev = projectEvidence(['hello', '', null, { key: 'note:y', summary: 'sum' }]);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].text, 'hello');
  assert.equal(ev[1].key, 'note:y');
});

// ---- runner -------------------------------------------------------------------------

(async () => {
  for (const { label, fn } of tests) {
    try {
      await fn();
      console.log(`PASS  ${label}`);
      pass++;
    } catch (err) {
      console.log(`FAIL  ${label}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
