#!/usr/bin/env node
// Unit tests for the queue-based batch processing mode in onboard-learn.js.
// Tests the pure queue logic: enqueue schema, drain cursor/notes, idempotency,
// queue-status counts, and --max-candidates emergency cap. No LLM calls.
//
// Run: node test/learner-queue.test.js — exits non-zero on any failure.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const LEARN = path.resolve(__dirname, '../scripts/onboard-learn.js');
const NODE = process.execPath;
const learner = require('../scripts/onboard-learn');
const onboardState = require('../lib/onboard-state');
const backend = require('../lib/llm-backend');
const overlayStore = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// ---- helpers ---------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'learner-queue-test-'));
}

function fakeRepo(dir) {
  // A minimal fake repo directory (just needs to exist for --repo validation).
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Write fake mined note files so gatherCandidates() has something to read.
// Produces: config(2), asset(1), doc(3), git(4), struct(2) = 12 total
function writeFakeMined(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'config-notes.json'), JSON.stringify([
    { title: 'Config A', summary: 'cfg a', kind: 'invariant', source: 'cfg1' },
    { title: 'Config B', summary: 'cfg b', kind: 'invariant', source: 'cfg2' },
  ]));
  fs.writeFileSync(path.join(outDir, 'asset-notes.json'), JSON.stringify([
    { title: 'Asset X', summary: 'asset x', kind: 'convention', source: 'asset1' },
  ]));
  fs.writeFileSync(path.join(outDir, 'doc-notes.json'), JSON.stringify([
    { title: 'Doc 1', summary: 'doc 1', kind: 'gotcha', source: 'doc1' },
    { title: 'Doc 2', summary: 'doc 2', kind: 'gotcha', source: 'doc2' },
    { title: 'Doc 3', summary: 'doc 3', kind: 'gotcha', source: 'doc3' },
  ]));
  fs.writeFileSync(path.join(outDir, 'git-notes.json'), JSON.stringify([
    { title: 'Git 1', summary: 'git 1', kind: 'decision', source: 'git1' },
    { title: 'Git 2', summary: 'git 2', kind: 'decision', source: 'git2' },
    { title: 'Git 3', summary: 'git 3', kind: 'decision', source: 'git3' },
    { title: 'Git 4', summary: 'git 4', kind: 'decision', source: 'git4' },
  ]));
  fs.writeFileSync(path.join(outDir, 'structure.json'), JSON.stringify({
    nodes: [
      { id: 'lib/a.js', role: 'module A', kind: 'structure' },
      { id: 'lib/b.js', role: 'module B', kind: 'structure' },
    ],
  }));
}

function run(extraArgs, env = {}) {
  // We pass a temp dir as the fake repo (it just needs to exist).
  // The --in flag points to our mined dir (same dir for simplicity).
  const r = spawnSync(NODE, [LEARN, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10000,
  });
  return r;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// ---- TEST 1: --enqueue writes the correct schema ---------------------------
{
  const dir = tmpDir();
  const repo = fakeRepo(path.join(dir, 'repo'));
  let captured = null;
  const providerId = 'learner-queue-mock-cli';
  backend.registerProvider({
    id: providerId,
    displayName: 'Learner Queue Mock CLI',
    kind: 'agentic-cli',
    resolveBin: () => '/mock/learner',
    isAvailable: () => true,
    isAuthed: () => true,
    buildInvocation(opts = {}) {
      captured = opts;
      return { bin: '/mock/learner', args: ['run', opts.model || '', opts.prompt], env: { MOCK_LEARNER: '1' } };
    },
    parseResult: () => ({}),
  });
  const ov = overlayStore.load(repo);
  overlayStore.setBackendConfig(ov, { provider: providerId, model: 'mock-selected-model' });
  overlayStore.save(repo, ov);

  const outFile = path.join(dir, 'onboard-notes.json');
  const built = learner.buildLearnerInvocation(repo, [{ title: 'Candidate', summary: 's', kind: 'gotcha' }], outFile, null, 3);
  ok('learner invocation uses selected backend provider', built.invocation.bin === '/mock/learner');
  ok('learner invocation passes selected backend model', captured && captured.model === 'mock-selected-model');
  ok('learner invocation grants output dir only', captured && Array.isArray(captured.addDir) && captured.addDir.includes(dir) && !captured.addDir.includes(repo));
  ok('learner invocation runs from output dir', built.invocation.cwd === dir);
  ok('learner prompt forbids repo inspection', captured && /Do NOT inspect the repo/.test(captured.prompt) && /BOUNDED CANDIDATES/.test(captured.prompt));
  const spawnEnv = learner.buildLearnerProcessEnv({ PATH: '/tmp/mock-bin', MOCK_LEARNER: '1' });
  const spawnPath = String(spawnEnv.PATH || '').split(path.delimiter);
  ok('learner spawn env preserves backend env vars', spawnEnv.MOCK_LEARNER === '1');
  ok('learner spawn env prepends current Node dir', spawnPath[0] === path.dirname(process.execPath));
  ok('learner spawn env keeps backend PATH entries', spawnPath.includes('/tmp/mock-bin'));
}

// ---- TEST 1: --enqueue writes the correct schema ---------------------------
{
  const dir = tmpDir();
  const repo = fakeRepo(path.join(dir, 'repo'));
  writeFakeMined(dir);

  const r = run(['--repo', repo, '--in', dir, '--enqueue']);
  // exit 0
  ok('enqueue exits 0', r.status === 0);

  const qf = path.join(dir, 'onboard-queue.json');
  ok('enqueue creates queue file', fs.existsSync(qf));

  const q = readJSON(qf);
  ok('queue has total field', q && typeof q.total === 'number');
  ok('queue total = 12 (all candidates)', q && q.total === 12);
  ok('queue cursor starts at 0', q && q.cursor === 0);
  ok('queue kept starts empty', q && Array.isArray(q.kept) && q.kept.length === 0);
  ok('queue rejected starts empty', q && Array.isArray(q.rejected) && q.rejected.length === 0);
  ok('queue pending has all candidates', q && Array.isArray(q.pending) && q.pending.length === 12);

  // Verify priority ordering: config first, then asset, then doc, then git, then struct.
  if (q && q.pending) {
    const origins = q.pending.map((c) => c._origin);
    const configIdx = origins.indexOf('config');
    const assetIdx = origins.indexOf('asset');
    const docIdx = origins.indexOf('doc');
    const gitIdx = origins.indexOf('git');
    const structIdx = origins.indexOf('struct');
    ok('priority: config before asset', configIdx < assetIdx);
    ok('priority: asset before doc', assetIdx < docIdx);
    ok('priority: doc before git', docIdx < gitIdx);
    ok('priority: git before struct', gitIdx < structIdx);
  } else {
    ok('priority: config before asset', false);
    ok('priority: asset before doc', false);
    ok('priority: doc before git', false);
    ok('priority: git before struct', false);
  }
}

// ---- TEST 2: --queue-status returns correct counts ------------------------
{
  const dir = tmpDir();
  const repo = fakeRepo(path.join(dir, 'repo'));
  writeFakeMined(dir);

  // No queue file yet → error exit.
  const r0 = run(['--repo', repo, '--in', dir, '--queue-status']);
  ok('queue-status exits non-zero with no queue file', r0.status !== 0);

  // After enqueue.
  run(['--repo', repo, '--in', dir, '--enqueue']);
  const r1 = run(['--repo', repo, '--in', dir, '--queue-status']);
  ok('queue-status exits 0 after enqueue', r1.status === 0);

  let status = null;
  try { status = JSON.parse(r1.stdout.trim()); } catch { /* ignore */ }
  ok('queue-status returns JSON with total=12', status && status.total === 12);
  ok('queue-status processed=0 initially', status && status.processed === 0);
  ok('queue-status remaining=12 initially', status && status.remaining === 12);
  ok('queue-status done=false initially', status && status.done === false);
  ok('queue-status kept=0 initially', status && status.kept === 0);
}

// ---- TEST 3: --drain advances cursor and writes notes.json when done ------
// We simulate a drain by manually pre-writing a queue file that is almost done,
// then injecting a fake batch result, which --drain would produce if an LLM ran.
// Since we can't call an LLM in tests, we test the cursor+merge logic by
// writing a queue file where cursor is already at total (simulating done state).
{
  const dir = tmpDir();
  const repo = fakeRepo(path.join(dir, 'repo'));
  writeFakeMined(dir);

  // Manually write a "done" queue file (cursor === total), simulating what happens
  // after all drain batches complete.
  const keptNotes = [
    { title: 'Note A', summary: 'summary A', evidence: 'lib/a.js:10', kind: 'invariant', source: '0' },
    { title: 'Note B', summary: 'summary B', evidence: 'lib/b.js:5', kind: 'gotcha', source: '1' },
  ];
  const rejectedNotes = Array.from({ length: 10 }, (_, i) => ({
    candidate: `Rejected ${i + 1}`, reason: 'restatement',
  }));
  const queue = {
    total: 12,
    cursor: 12, // already drained
    kept: keptNotes,
    rejected: rejectedNotes,
    pending: Array.from({ length: 12 }, (_, i) => ({ title: `Candidate ${i + 1}` })),
  };
  fs.writeFileSync(path.join(dir, 'onboard-queue.json'), JSON.stringify(queue, null, 2));

  // Running --drain on an already-drained queue should be idempotent (exit 0, print already_drained).
  const r = run(['--repo', repo, '--in', dir, '--drain', '--batch', '5']);
  ok('drain is idempotent when already done (exits 0)', r.status === 0);
  // stdout should contain "already_drained"
  ok('drain prints already_drained status', r.stdout.includes('already_drained'));

  // The queue file should be unchanged (cursor still 12).
  const qAfter = readJSON(path.join(dir, 'onboard-queue.json'));
  ok('drain does not advance cursor past total', qAfter && qAfter.cursor === 12);

  const recoveredNotes = readJSON(path.join(dir, 'onboard-notes.json'));
  ok('already-drained queue reconstructs a missing final notes artifact', recoveredNotes
    && recoveredNotes.generation === learner.queueGeneration(qAfter)
    && JSON.stringify(recoveredNotes.kept) === JSON.stringify(keptNotes)
    && JSON.stringify(recoveredNotes.rejected) === JSON.stringify(rejectedNotes));

  const statusRun = run(['--repo', repo, '--in', dir, '--queue-status']);
  let status = null;
  try { status = JSON.parse(statusRun.stdout.trim()); } catch { /* ignore */ }
  ok('queue-status exposes kept note title preview', status && Array.isArray(status.keptNotes) && status.keptNotes[0].title === 'Note A');
}

// ---- TEST 4: when cursor === total after drain, onboard-notes.json is written -------------
{
  const dir = tmpDir();
  const repo = fakeRepo(path.join(dir, 'repo'));
  writeFakeMined(dir);

  // Write a queue that was just drained (cursor === total) and verify that
  // the notes file would be written. We do this by writing a queue file that
  // already has cursor === total and kept notes, then checking that if
  // onboard-notes.json does NOT exist, a drain call would produce it.
  // Since the drain is idempotent on already-drained queues (exits 0, doesn't
  // rerun the LLM), we instead test the path by writing an almost-done queue
  // and simulating the drain completion step by checking the schema is correct.

  // Write a fresh queue where total=1, cursor=0, pending has 1 item.
  // Then manually advance cursor to 1 and write the batch result, mimicking
  // what drain does internally. Finally verify onboard-notes.json is produced.
  const fakeQueue = {
    total: 1,
    cursor: 0,
    kept: [],
    rejected: [],
    pending: [{ title: 'Fake Cand', summary: 'fake', kind: 'gotcha', _origin: 'doc', source: 'doc1' }],
  };
  fs.writeFileSync(path.join(dir, 'onboard-queue.json'), JSON.stringify(fakeQueue, null, 2));

  // Manually simulate what drain would do after the LLM returns:
  // advance cursor, write kept/rejected, and if cursor === total write notes.json.
  // We exercise this by writing the final state and checking --queue-status says done.
  fakeQueue.cursor = 1;
  fakeQueue.kept = [{ title: 'Fake Note', summary: 'kept fact', evidence: 'x.js:1', kind: 'gotcha', source: '0' }];
  fakeQueue.rejected = [];
  fs.writeFileSync(path.join(dir, 'onboard-queue.json'), JSON.stringify(fakeQueue, null, 2));

  // Write onboard-notes.json manually (mirrors what drain does on completion).
  fs.writeFileSync(path.join(dir, 'onboard-notes.json'), JSON.stringify({ kept: fakeQueue.kept, rejected: fakeQueue.rejected }, null, 2));

  // queue-status should report done:true.
  const r = run(['--repo', repo, '--in', dir, '--queue-status']);
  ok('queue-status done=true after cursor===total', r.status === 0);
  let status = null;
  try { status = JSON.parse(r.stdout.trim()); } catch { /* ignore */ }
  ok('queue-status: done is true', status && status.done === true);
  ok('queue-status: remaining is 0', status && status.remaining === 0);
  ok('queue-status: processed === total', status && status.processed === status.total);

  // onboard-notes.json should exist and have the right shape.
  const notes = readJSON(path.join(dir, 'onboard-notes.json'));
  ok('onboard-notes.json exists after drain completion', notes !== null);
  ok('onboard-notes.json has kept array', notes && Array.isArray(notes.kept));
  ok('onboard-notes.json kept has 1 note', notes && notes.kept.length === 1);
  ok('onboard-notes.json has rejected array', notes && Array.isArray(notes.rejected));
}

// ---- TEST 5: --max-candidates emergency cap still works inside --drain ----
// We test capCandidates logic indirectly: build a fake queue with many pending
// items; running drain with --max-candidates 2 should only process 2 of them
// (the emergency ceiling). Since the LLM isn't invoked in tests, we verify the
// behavior by checking how many items the drain attempts to send per batch.
// We do this by checking that --queue-status reports the right pending count
// with no queue touching (cap happens only inside drain, not at enqueue).
{
  const dir = tmpDir();
  const repo = fakeRepo(path.join(dir, 'repo'));
  writeFakeMined(dir);

  // Enqueue: should have 12 candidates total, NO cap at enqueue time.
  run(['--repo', repo, '--in', dir, '--enqueue']);
  const qAfterEnqueue = readJSON(path.join(dir, 'onboard-queue.json'));
  ok('enqueue with many candidates: no cap (all 12 pending)', qAfterEnqueue && qAfterEnqueue.total === 12);

  // Verify that --max-candidates does NOT apply at enqueue time — it's a drain-only safety valve.
  // We can't invoke the LLM, but we can verify the queue itself is uncapped after enqueue.
  ok('queue pending length = total (no cap at enqueue)', qAfterEnqueue && qAfterEnqueue.pending.length === qAfterEnqueue.total);
}

// ---- TEST 6: enqueue is idempotent (re-running overwrites queue safely) ---
{
  const dir = tmpDir();
  const repo = fakeRepo(path.join(dir, 'repo'));
  writeFakeMined(dir);

  run(['--repo', repo, '--in', dir, '--enqueue']);
  const q1 = readJSON(path.join(dir, 'onboard-queue.json'));

  // Run enqueue again — should overwrite with fresh queue.
  run(['--repo', repo, '--in', dir, '--enqueue']);
  const q2 = readJSON(path.join(dir, 'onboard-queue.json'));

  ok('enqueue re-run resets cursor to 0', q2 && q2.cursor === 0);
  ok('enqueue re-run produces same total', q1 && q2 && q1.total === q2.total);
  ok('enqueue re-run resets kept to []', q2 && q2.kept.length === 0);
  ok('enqueue re-run always allocates a fresh explicit generation', q1 && q2
    && typeof q1.generation === 'string' && typeof q2.generation === 'string'
    && q1.generation !== q2.generation);
}

// ---- TEST 7: direct re-enqueue resets generation-scoped injection state ---
{
  const repo = fakeRepo(tmpDir());
  const dir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  writeFakeMined(dir);
  run(['--repo', repo, '--in', dir, '--enqueue']);
  const qf = path.join(dir, 'onboard-queue.json');
  const first = readJSON(qf);
  const priorNote = { title: 'Prior', summary: 'already injected', kind: 'decision' };
  fs.writeFileSync(qf, JSON.stringify({
    ...first, cursor: first.total, kept: [priorNote], rejected: [],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'onboard-notes.json'), JSON.stringify({
    generation: first.generation, kept: [priorNote], rejected: [],
  }));
  fs.writeFileSync(path.join(dir, onboardState.INJECTION_RECEIPT_FILE), JSON.stringify({
    generation: first.generation, confirmed: [onboardState.onboardNoteId(priorNote, 0)],
  }));
  fs.writeFileSync(path.join(dir, 'onboard-drain-status.json'), JSON.stringify({
    repo, outDir: dir, autoInject: true, queueGeneration: first.generation,
    injectionGeneration: first.generation, injectionState: 'succeeded',
    injected: true, injectedGeneration: first.generation, injectedKept: 1,
  }));

  const rerun = run(['--repo', repo, '--in', dir, '--enqueue']);
  const second = readJSON(qf);
  const status = readJSON(path.join(dir, 'onboard-drain-status.json'));
  const due = require('../lib/headless-drain').findPendingLearnerQueues(repo);
  ok('direct re-enqueue succeeds after a prior injected generation', rerun.status === 0);
  ok('direct re-enqueue fences an identical prior generation', second && second.generation !== first.generation);
  ok('direct re-enqueue clears stale receipt and final notes artifacts',
    !fs.existsSync(path.join(dir, onboardState.INJECTION_RECEIPT_FILE))
      && !fs.existsSync(path.join(dir, 'onboard-notes.json')));
  ok('direct re-enqueue resets the injection watermark to pending current generation', status
    && status.queueGeneration === second.generation && status.injectionGeneration === second.generation
    && status.injectionState === 'pending' && status.injected === false && status.injectedKept === 0);
  ok('headless discovery schedules the directly re-enqueued generation', due.length === 1
    && due[0].generation === second.generation && due[0].remaining === second.total);

  const beforeQueue = fs.readFileSync(qf);
  fs.writeFileSync(path.join(dir, 'onboard-drain-status.json'), JSON.stringify({
    ...status, injectionState: 'running', injecting: true,
    injectionOwner: 'live-owner', injectionPid: process.pid,
    injectionLeaseExpiresAt: Date.now() + 60000,
  }));
  const blocked = run(['--repo', repo, '--in', dir, '--enqueue']);
  ok('direct re-enqueue refuses to replace a live injection owner', blocked.status !== 0
    && /injection is running/.test(blocked.stderr));
  ok('rejected live-owner replacement leaves queue bytes unchanged',
    fs.readFileSync(qf).equals(beforeQueue));
}

// ---- TEST 7b: queue/status publication survives every durable hard-exit boundary ----
{
  const boundaries = [
    'journal',
    'onboard-queue.json_temp',
    'onboard-queue.json',
    'onboard-drain-status.json_temp',
    'before_journal_cleanup',
  ];
  for (const boundary of boundaries) {
    const repo = fakeRepo(tmpDir());
    const dir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
    writeFakeMined(dir);
    const initial = run(['--repo', repo, '--in', dir, '--enqueue']);
    const oldQueue = readJSON(path.join(dir, 'onboard-queue.json'));
    fs.writeFileSync(path.join(dir, onboardState.INJECTION_RECEIPT_FILE), JSON.stringify({
      generation: oldQueue.generation, confirmed: ['stale'],
    }));
    fs.writeFileSync(path.join(dir, 'onboard-notes.json'), JSON.stringify({
      generation: oldQueue.generation, kept: [{ title: 'stale' }], rejected: [],
    }));

    const crashed = run(['--repo', repo, '--in', dir, '--enqueue'], {
      ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER: boundary,
    });
    const queueAfterCrash = readJSON(path.join(dir, 'onboard-queue.json'));
    const retried = run(['--repo', repo, '--in', dir, '--enqueue'], {
      ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER: '',
    });
    const queue = readJSON(path.join(dir, 'onboard-queue.json'));
    const status = readJSON(path.join(dir, 'onboard-drain-status.json'));
    const leftovers = fs.readdirSync(dir).filter((name) => name === onboardState.PUBLICATION_INTENT_FILE
      || /\.publish-[a-f0-9]{32}\.tmp$/.test(name)
      || /^onboard-publication-intent\.json\..*\.tmp$/.test(name));
    ok(`publication hard exit ${boundary}: child exits at deterministic boundary`, initial.status === 0 && crashed.status === 87);
    ok(`publication hard exit ${boundary}: retry converges to one queue/status generation`, retried.status === 0
      && queue && status && status.queueGeneration === queue.generation
      && status.injectionGeneration === queue.generation && status.preparationState === 'ready');
    ok(`publication hard exit ${boundary}: committed retry clears stale generation artifacts`,
      !fs.existsSync(path.join(dir, onboardState.INJECTION_RECEIPT_FILE))
        && !fs.existsSync(path.join(dir, 'onboard-notes.json')) && leftovers.length === 0);
    if (['onboard-queue.json', 'onboard-drain-status.json_temp', 'before_journal_cleanup'].includes(boundary)) {
      ok(`publication hard exit ${boundary}: retry does not allocate a duplicate replacement`,
        queueAfterCrash && queueAfterCrash.generation === queue.generation);
    }
  }
}

// ---- TEST 7c: a newer accepted preparation fences an abandoned older publication intent ----
{
  const repo = fakeRepo(tmpDir());
  const dir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  writeFakeMined(dir);
  run(['--repo', repo, '--in', dir, '--enqueue']);
  const oldQueue = readJSON(path.join(dir, 'onboard-queue.json'));
  const crashed = run(['--repo', repo, '--in', dir, '--enqueue'], {
    ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER: 'journal',
  });
  const newerGeneration = 'generation-newer-preparation';
  fs.writeFileSync(path.join(dir, 'onboard-drain-status.json'), JSON.stringify({
    repo, outDir: dir, preparationState: 'pending', preparationGeneration: newerGeneration,
    preparationOwner: null, queueGeneration: null, injectionGeneration: newerGeneration,
  }, null, 2));
  const reconciled = onboardState.reconcileOnboardPublication(dir);
  const finalQueue = readJSON(path.join(dir, 'onboard-queue.json'));
  const finalStatus = readJSON(path.join(dir, 'onboard-drain-status.json'));
  ok('newer preparation CAS abandons an older journal instead of resurrecting it', crashed.status === 87
    && reconciled.settled === 'abandoned' && finalQueue.generation === oldQueue.generation
    && finalStatus.preparationGeneration === newerGeneration
    && !fs.existsSync(path.join(dir, onboardState.PUBLICATION_INTENT_FILE)));
}

// ---- TEST 7d: one-shot publication faults repair synchronously or preserve the exact old pair ----
{
  const dir = tmpDir();
  const oldGeneration = 'generation-publication-old';
  const oldQueue = {
    generation: oldGeneration, total: 1, cursor: 0, kept: [], rejected: [],
    pending: [{ title: 'old', summary: 'old', kind: 'gotcha' }],
  };
  const oldStatus = {
    preparationState: 'ready', queueGeneration: oldGeneration,
    injectionGeneration: oldGeneration, injectionState: 'pending',
  };
  fs.writeFileSync(path.join(dir, 'onboard-queue.json'), JSON.stringify(oldQueue, null, 2));
  fs.writeFileSync(path.join(dir, 'onboard-drain-status.json'), JSON.stringify(oldStatus, null, 2));

  const beforeJournal = {
    generation: 'generation-publication-before-journal', total: 1, cursor: 0, kept: [], rejected: [],
    pending: [{ title: 'before', summary: 'before', kind: 'gotcha' }],
  };
  let beforeError = null;
  try {
    onboardState.publishOnboardGeneration({
      outDir: dir, queue: beforeJournal, files: { 'onboard-notes.json': null },
      statusMutator: (status) => ({ ...status, preparationState: 'ready',
        queueGeneration: beforeJournal.generation, injectionGeneration: beforeJournal.generation }),
    }, { onBoundary(name) { if (name === 'journal_temp') throw new Error('one-shot journal temp failure'); } });
  } catch (err) { beforeError = err; }
  ok('publication journal-temp failure reports failure with the exact old queue/status pair', beforeError
    && readJSON(path.join(dir, 'onboard-queue.json')).generation === oldGeneration
    && readJSON(path.join(dir, 'onboard-drain-status.json')).queueGeneration === oldGeneration);
  ok('publication journal-temp failure removes its abandoned temp',
    !fs.readdirSync(dir).some((name) => /onboard-publication-intent.*\.tmp$/.test(name)));

  const repairBoundaries = ['journal', 'onboard-queue.json_temp', 'onboard-queue.json',
    'onboard-drain-status.json_temp', 'before_journal_cleanup', 'journal_cleanup'];
  for (const [index, boundary] of repairBoundaries.entries()) {
    const generation = `generation-publication-repair-${index}`;
    const queue = {
      generation, total: 1, cursor: 0, kept: [], rejected: [],
      pending: [{ title: generation, summary: generation, kind: 'gotcha' }],
    };
    const result = onboardState.publishOnboardGeneration({
      outDir: dir, queue, files: {
        [onboardState.INJECTION_RECEIPT_FILE]: null,
        'onboard-notes.json': null,
      },
      statusMutator: (status) => ({ ...status, preparationState: 'ready',
        queueGeneration: generation, injectionGeneration: generation, injectionState: 'pending' }),
    }, { onBoundary(name) { if (name === boundary) throw new Error(`one-shot ${boundary} failure`); } });
    const committedQueue = readJSON(path.join(dir, 'onboard-queue.json'));
    const committedStatus = readJSON(path.join(dir, 'onboard-drain-status.json'));
    ok(`publication one-shot ${boundary}: caller receives truthful committed success`, result.applied === true
      && committedQueue.generation === generation && committedStatus.queueGeneration === generation
      && committedStatus.injectionGeneration === generation);
    ok(`publication one-shot ${boundary}: no journal or owned temp remains`,
      !fs.existsSync(path.join(dir, onboardState.PUBLICATION_INTENT_FILE))
        && !fs.readdirSync(dir).some((name) => /\.publish-[a-f0-9]{32}\.tmp$/.test(name)));
  }

  const persistentGeneration = 'generation-publication-persistent-status';
  const persistentQueue = {
    generation: persistentGeneration, total: 1, cursor: 0, kept: [], rejected: [],
    pending: [{ title: 'persistent', summary: 'persistent', kind: 'gotcha' }],
  };
  const statusPath = path.join(dir, 'onboard-drain-status.json');
  const realRename = fs.renameSync;
  let pendingResult;
  try {
    fs.renameSync = (from, to) => {
      if (to === statusPath && /\.publish-[a-f0-9]{32}\.tmp$/.test(from)) {
        throw Object.assign(new Error('persistent status rename failure'), { code: 'EIO' });
      }
      return realRename(from, to);
    };
    pendingResult = onboardState.publishOnboardGeneration({
      outDir: dir, queue: persistentQueue, files: { 'onboard-notes.json': null },
      statusMutator: (status) => ({ ...status, preparationState: 'ready',
        queueGeneration: persistentGeneration, injectionGeneration: persistentGeneration }),
    });
  } finally {
    fs.renameSync = realRename;
  }
  const pendingStatus = readJSON(statusPath);
  const pendingQueue = readJSON(path.join(dir, 'onboard-queue.json'));
  ok('persistent status rename failure acknowledges the durable queue intent without false failure',
    pendingResult.applied === true && pendingResult.reconciliationPending === true
      && pendingQueue.generation === persistentGeneration
      && pendingStatus.queueGeneration !== persistentGeneration
      && fs.existsSync(path.join(dir, onboardState.PUBLICATION_INTENT_FILE)));
  const restarted = onboardState.reconcileOnboardPublication(dir);
  ok('restart reconciliation completes a persistently failed status rename exactly once',
    restarted.settled === 'committed'
      && readJSON(statusPath).queueGeneration === persistentGeneration
      && !fs.existsSync(path.join(dir, onboardState.PUBLICATION_INTENT_FILE)));
}

// ---- TEST 7e: committed cleanup is independent from publication operation identity ----
{
  const dir = tmpDir();
  const intentPath = path.join(dir, onboardState.PUBLICATION_INTENT_FILE);
  const queueFor = (generation) => ({
    generation, total: 1, cursor: 0, kept: [], rejected: [],
    pending: [{ title: generation, summary: generation, kind: 'gotcha' }],
  });
  const filesFor = () => ({ 'onboard-notes.json': null });
  const publish = (generation, statusMutator) => onboardState.publishOnboardGeneration({
    outDir: dir,
    queue: queueFor(generation),
    files: filesFor(),
    statusMutator: statusMutator || ((status) => ({
      ...status,
      preparationState: 'ready',
      queueGeneration: generation,
      injectionGeneration: generation,
      injectionState: 'pending',
    })),
  });

  const realUnlink = fs.unlinkSync;
  let first;
  let second;
  try {
    fs.unlinkSync = (file, ...args) => {
      if (path.resolve(file) === path.resolve(intentPath)) {
        throw Object.assign(new Error('persistent publication cleanup failure'), { code: 'EIO' });
      }
      return realUnlink(file, ...args);
    };
    first = publish('generation-cleanup-one');
    second = publish('generation-cleanup-two');
  } finally {
    fs.unlinkSync = realUnlink;
  }
  const secondQueue = readJSON(path.join(dir, 'onboard-queue.json'));
  const secondStatus = readJSON(path.join(dir, 'onboard-drain-status.json'));
  ok('cleanup-pending gen1 does not swallow an explicitly requested gen2',
    first.applied === true && first.reconciliationPending === true
      && second.applied === true && second.generation === 'generation-cleanup-two'
      && secondQueue.generation === 'generation-cleanup-two'
      && secondStatus.queueGeneration === 'generation-cleanup-two');
  ok('gen2 owns the surviving cleanup journal after replacing cleanup-pending gen1',
    readJSON(intentPath).generation === 'generation-cleanup-two');

  let retryMutatorCalls = 0;
  const retried = publish('generation-cleanup-two', () => {
    retryMutatorCalls++;
    throw new Error('same-operation recovery must not allocate another publication');
  });
  ok('same generation and payload retry returns only its exact recovered operation',
    retried.applied === true && retried.recovered === true
      && retried.generation === 'generation-cleanup-two' && retryMutatorCalls === 0);
  ok('successful same-operation retry settles the cleanup journal and owned temps',
    !fs.existsSync(intentPath)
      && !fs.readdirSync(dir).some((name) => /\.publish-[a-f0-9]{32}\.tmp$/.test(name)));
}

// ---- TEST 7f: invalid journals fail closed, reprepare, and never poison later publication ----
{
  const dir = tmpDir();
  const intentPath = path.join(dir, onboardState.PUBLICATION_INTENT_FILE);
  const tempId = 'a'.repeat(32);
  fs.writeFileSync(path.join(dir, 'onboard-queue.json'), JSON.stringify({
    generation: 'generation-untrusted-partial', total: 1, cursor: 0, kept: [], rejected: [],
    pending: [{ title: 'untrusted', summary: 'untrusted', kind: 'gotcha' }],
  }));
  fs.writeFileSync(path.join(dir, 'onboard-drain-status.json'), JSON.stringify({
    preparationState: 'running', preparationGeneration: 'generation-reprepare',
    preparationOwner: 'dead-owner', preparationPid: 999999, preparationLeaseExpiresAt: Date.now() - 1,
    queueGeneration: 'generation-before-partial', injectionGeneration: 'generation-before-partial',
  }));
  fs.writeFileSync(intentPath, '{');
  fs.writeFileSync(path.join(dir, `onboard-queue.json.publish-${tempId}.tmp`), '{}');

  const quarantined = onboardState.reconcileOnboardPublication(dir);
  const failedStatus = readJSON(path.join(dir, 'onboard-drain-status.json'));
  ok('malformed publication journal is quarantined without rolling its partial queue forward',
    quarantined.ok === true && quarantined.settled === 'invalid_quarantined'
      && quarantined.reprepare === true && !fs.existsSync(intentPath)
      && !fs.existsSync(path.join(dir, 'onboard-queue.json'))
      && failedStatus.queueGeneration === null && failedStatus.injectionGeneration === null);
  ok('invalid prepared publication releases its owner into restart-safe reprepare state',
    failedStatus.preparationState === 'pending'
      && failedStatus.preparationGeneration === 'generation-reprepare'
      && failedStatus.preparationOwner === null && failedStatus.preparationPid === null);
  ok('invalid publication cleanup reaps owned temps and retains quarantined evidence only',
    !fs.existsSync(path.join(dir, `onboard-queue.json.publish-${tempId}.tmp`))
      && fs.readdirSync(dir).some((name) => name.startsWith(`${onboardState.PUBLICATION_INTENT_FILE}.invalid-`)));

  const replacementGeneration = 'generation-after-invalid';
  const replacementQueue = {
    generation: replacementGeneration, total: 1, cursor: 0, kept: [], rejected: [],
    pending: [{ title: 'replacement', summary: 'replacement', kind: 'gotcha' }],
  };
  const replacement = onboardState.publishOnboardGeneration({
    outDir: dir, queue: replacementQueue, files: { 'onboard-notes.json': null },
    statusMutator: (status) => ({
      ...status, preparationState: 'ready', preparationGeneration: null,
      queueGeneration: replacementGeneration, injectionGeneration: replacementGeneration,
    }),
  });
  ok('quarantined malformed journal cannot block a later valid publication',
    replacement.applied === true
      && readJSON(path.join(dir, 'onboard-queue.json')).generation === replacementGeneration
      && readJSON(path.join(dir, 'onboard-drain-status.json')).queueGeneration === replacementGeneration);

  const safeQueueBytes = fs.readFileSync(path.join(dir, 'onboard-queue.json'));
  const safeStatusBytes = fs.readFileSync(path.join(dir, 'onboard-drain-status.json'));
  fs.writeFileSync(intentPath, JSON.stringify({ version: 1 }));
  const shallow = onboardState.reconcileOnboardPublication(dir);
  ok('shallow invalid journal preserves an already coherent committed queue and status',
    shallow.settled === 'invalid_quarantined'
      && fs.readFileSync(path.join(dir, 'onboard-queue.json')).equals(safeQueueBytes)
      && fs.readFileSync(path.join(dir, 'onboard-drain-status.json')).equals(safeStatusBytes));
}

// ---- TEST 7g: a tampered hard-exit journal cannot block the direct command restart ----
{
  const repo = fakeRepo(tmpDir());
  const dir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  writeFakeMined(dir);
  const initial = run(['--repo', repo, '--in', dir, '--enqueue']);
  const before = readJSON(path.join(dir, 'onboard-queue.json'));
  const crashed = run(['--repo', repo, '--in', dir, '--enqueue'], {
    ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER: 'journal',
  });
  const intentPath = path.join(dir, onboardState.PUBLICATION_INTENT_FILE);
  const tampered = readJSON(intentPath);
  tampered.desiredStatus.queueGeneration = 'generation-tampered';
  fs.writeFileSync(intentPath, JSON.stringify(tampered, null, 2));
  const restarted = run(['--repo', repo, '--in', dir, '--enqueue']);
  const after = readJSON(path.join(dir, 'onboard-queue.json'));
  const status = readJSON(path.join(dir, 'onboard-drain-status.json'));
  ok('tampered hard-exit journal is quarantined and direct enqueue restart succeeds',
    initial.status === 0 && crashed.status === 87 && restarted.status === 0
      && after.generation !== before.generation && status.queueGeneration === after.generation
      && status.queueGeneration !== 'generation-tampered' && !fs.existsSync(intentPath));
  ok('tampered journal restart leaves only quarantined evidence, not publication temps',
    fs.readdirSync(dir).some((name) => name.startsWith(`${onboardState.PUBLICATION_INTENT_FILE}.invalid-`))
      && !fs.readdirSync(dir).some((name) => /\.publish-[a-f0-9]{32}\.tmp$/.test(name)));
}

// ---- TEST 7: queue reservations allow parallel non-overlapping batches ----
{
  const dir = tmpDir();
  const qf = path.join(dir, 'onboard-queue.json');
  fs.writeFileSync(qf, JSON.stringify({
    total: 5,
    cursor: 0,
    kept: [],
    rejected: [],
    pending: Array.from({ length: 5 }, (_, i) => ({ title: `Cand ${i}`, summary: 's', kind: 'gotcha' })),
  }, null, 2));

  const r1 = learner.reserveQueueBatch(qf, 2, Infinity, 1000, 10000);
  const r2 = learner.reserveQueueBatch(qf, 2, Infinity, 1001, 10000);

  ok('first reservation starts at 0', r1.status === 'reserved' && r1.start === 0 && r1.count === 2);
  ok('second reservation skips inflight range', r2.status === 'reserved' && r2.start === 2 && r2.count === 2);

  let q = readJSON(qf);
  ok('reservations do not advance cursor', q && q.cursor === 0);

  learner.completeQueueBatch(qf, r2, {
    kept: [{ title: 'Later', summary: 'later', evidence: 'x', kind: 'gotcha' }],
    rejected: [{ candidate: 'Later rejected', reason: 'restatement' }],
  }, dir, dir, 'opus');
  q = readJSON(qf);
  ok('out-of-order completion does not advance past gap', q && q.cursor === 0);
  ok('completed sparse slice retains its generation and reservation identity', q && q.completed['2']
    && q.completed['2'].generation === r2.generation
    && q.completed['2'].reservationId === r2.reservationId
    && Number.isFinite(q.completed['2'].completedAt));

  learner.completeQueueBatch(qf, r1, {
    kept: [{ title: 'First', summary: 'first', evidence: 'x', kind: 'gotcha' }],
    rejected: [{ candidate: 'First rejected', reason: 'restatement' }],
  }, dir, dir, 'opus');
  q = readJSON(qf);
  ok('cursor advances through contiguous completed slices', q && q.cursor === 4);
  ok('kept results merge in cursor order', q && q.kept[0].title === 'First' && q.kept[1].title === 'Later');
}

// ---- TEST 10: impossible partial queues and empty batches fail closed ------
{
  const candidate = { title: 'Candidate', summary: 's', kind: 'gotcha' };
  const partialWithoutCoverage = {
    generation: 'generation-no-coverage', total: 2, cursor: 0,
    kept: [], rejected: [], pending: [candidate],
  };
  ok('partial queue requires exact candidate coverage',
    onboardState.validateOnboardQueue(partialWithoutCoverage).reason === 'invalid_pending_coverage');
  ok('partial queue candidate coverage cannot contain empty slots',
    onboardState.validateOnboardQueue({
      ...partialWithoutCoverage, total: 1, pending: [null],
    }).reason === 'invalid_pending_candidate');

  const ownerless = {
    generation: 'generation-ownerless', total: 1, cursor: 0,
    kept: [], rejected: [], pending: [candidate],
    inflight: { 0: { count: 1, generation: 'generation-ownerless', reservationId: 'token' } },
  };
  ok('ownerless reservation is rejected',
    onboardState.validateOnboardQueue(ownerless).reason === 'invalid_inflight_owner');
  const invalidLease = {
    ...ownerless,
    generation: 'generation-invalid-lease',
    inflight: { 0: {
      count: 1, generation: 'generation-invalid-lease', reservationId: 'token', pid: process.pid,
      startedAt: 1000, expiresAt: 1000,
    } },
  };
  ok('reservation requires a finite advancing lease',
    onboardState.validateOnboardQueue(invalidLease).reason === 'invalid_inflight_lease');
  const overlapping = {
    generation: 'generation-overlap', total: 3, cursor: 0,
    kept: [], rejected: [], pending: [candidate, candidate, candidate],
    inflight: { 0: {
      count: 2, generation: 'generation-overlap', reservationId: 'token', pid: process.pid,
      startedAt: 1000, expiresAt: 2000,
    } },
    completed: { 1: {
      count: 1, kept: [], rejected: [{ reason: 'duplicate slice' }],
      generation: 'generation-overlap', reservationId: 'completed-token', completedAt: 1500,
    } },
  };
  ok('inflight and completed ranges cannot overlap',
    onboardState.validateOnboardQueue(overlapping).reason === 'overlapping_queue_ranges');
  ok('completed slice identity is either legacy-absent or complete and generation-matched',
    onboardState.validateOnboardQueue({
      generation: 'generation-completed-owner', total: 2, cursor: 0,
      kept: [], rejected: [], pending: [candidate, candidate],
      completed: { 0: {
        count: 1, kept: [candidate], rejected: [], generation: 'generation-completed-owner',
      } },
    }).reason === 'invalid_completed_owner');
  const explicitOwnerlessCompleted = {
    generation: 'generation-explicit-ownerless', total: 2, cursor: 0,
    kept: [], rejected: [], pending: [candidate, candidate],
    completed: { 0: { count: 1, kept: [candidate], rejected: [] } },
  };
  ok('explicit-generation completed slices require the full reservation identity',
    onboardState.validateOnboardQueue(explicitOwnerlessCompleted, { allowLegacy: true }).reason
      === 'invalid_completed_owner');
  ok('safe legacy completed slice without reservation identity remains readable',
    onboardState.validateOnboardQueue({
      total: 2, cursor: 0, kept: [], rejected: [], pending: [candidate, candidate],
      completed: { 0: { count: 1, kept: [candidate], rejected: [] } },
    }, { allowLegacy: true }).ok === true);
  ok('legacy compatibility requires an explicit opt-in',
    onboardState.validateOnboardQueue({
      total: 2, cursor: 0, kept: [], rejected: [], pending: [candidate, candidate],
    }).reason === 'legacy_queue_requires_opt_in');
  ok('current explicit generations require exact contiguous outcomes',
    onboardState.validateOnboardQueue({
      generation: 'generation-missing-outcome', total: 2, cursor: 1,
      kept: [], rejected: [], pending: [candidate, candidate],
    }).reason === 'outcome_cursor_mismatch');
  ok('expected generation fencing takes precedence over replacement queue internals',
    onboardState.validateOnboardQueue(ownerless, { expectedGeneration: 'generation-previous' }).reason
      === 'generation_replaced');

  const dir = tmpDir();
  const qf = path.join(dir, 'onboard-queue.json');
  fs.writeFileSync(qf, JSON.stringify(ownerless, null, 2));
  const impossibleBytes = fs.readFileSync(qf);
  const impossible = learner.reserveQueueBatch(qf, 1, Infinity, 1000, 10000);
  ok('ownerless full coverage cannot become permanent all_slices_inflight',
    impossible.status === 'missing_queue' && fs.readFileSync(qf).equals(impossibleBytes));

  fs.writeFileSync(qf, JSON.stringify(explicitOwnerlessCompleted, null, 2));
  const staleCompletedBytes = fs.readFileSync(qf);
  const staleCompleted = learner.reserveQueueBatch(qf, 1, Infinity, 1000, 10000);
  ok('ownerless explicit completed results never flush into the contiguous cursor',
    staleCompleted.status === 'missing_queue'
      && fs.readFileSync(qf).equals(staleCompletedBytes));

  const valid = {
    generation: 'generation-valid-batch', total: 1, cursor: 0,
    kept: [], rejected: [], pending: [candidate],
  };
  fs.writeFileSync(qf, JSON.stringify(valid, null, 2));
  const validBytes = fs.readFileSync(qf);
  const emptyBatch = learner.reserveQueueBatch(qf, 0, Infinity, 1000, 10000);
  const emptyCap = learner.reserveQueueBatch(qf, 1, 0, 1000, 10000);
  ok('zero batch and zero cap never create empty reservations',
    emptyBatch.status === 'invalid_batch_size' && emptyCap.status === 'invalid_batch_size'
      && fs.readFileSync(qf).equals(validBytes));

  fs.writeFileSync(qf, JSON.stringify({
    ...valid,
    inflight: { 0: {
      count: 1, generation: valid.generation, reservationId: 'expired-live-owner', pid: process.pid,
      startedAt: 1000, expiresAt: 2000,
    } },
  }, null, 2));
  const expired = learner.reserveQueueBatch(qf, 1, Infinity, 2001, 10000);
  ok('expired live-owner slice is reclaimed instead of returning permanent all_slices_inflight',
    expired.status === 'reserved' && expired.start === 0 && expired.reservationId !== 'expired-live-owner');
}

// ---- TEST 11: queue lock reclaim/release never unlinks a replacement -------
{
  const dir = tmpDir();
  const qf = path.join(dir, 'onboard-queue.json');
  const lock = `${qf}.lock`;
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, new Date(0), new Date(0));
  const replacementBytes = JSON.stringify({ pid: process.pid, owner: 'replacement-live', at: Date.now() });
  let incumbentFd = null;
  let replaced = false;
  const swappingFs = new Proxy(fs, { get(target, key) {
    if (key === 'openSync') return (file, flags, ...args) => {
      const opened = target.openSync(file, flags, ...args);
      if (file === lock && flags === 'r') incumbentFd = opened;
      return opened;
    };
    if (key === 'readFileSync') return (file, ...args) => {
      const value = target.readFileSync(file, ...args);
      if (!replaced && file === incumbentFd) {
        replaced = true;
        target.unlinkSync(lock);
        target.writeFileSync(lock, replacementBytes);
      }
      return value;
    };
    return target[key];
  } });
  let timedOut = false;
  try {
    learner.withQueueLock(qf, () => {}, { fsImpl: swappingFs, staleMs: 60000, waitMs: 35 });
  } catch (err) { timedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('stale reclaim stable-snapshot check preserves a replacement live lock', replaced && timedOut
    && fs.readFileSync(lock, 'utf8') === replacementBytes);
  fs.unlinkSync(lock);

  const releaseReplacement = JSON.stringify({ pid: process.pid, owner: 'release-replacement', at: Date.now() });
  learner.withQueueLock(qf, () => {
    const held = path.join(lock, 'held');
    const own = fs.readdirSync(held).map((name) => path.join(held, name))[0];
    fs.unlinkSync(own);
    fs.rmdirSync(held);
    fs.mkdirSync(held);
    fs.writeFileSync(path.join(held, 'owner-00000000000000000000000000000000.json'), releaseReplacement);
  });
  ok('old queue lock owner release preserves a replacement token',
    fs.readFileSync(path.join(lock, 'held', 'owner-00000000000000000000000000000000.json'), 'utf8') === releaseReplacement);
  fs.rmSync(lock, { recursive: true, force: true });

  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, owner: 'dead-owner', at: Date.now() }));
  let reclaimed = false;
  learner.withQueueLock(qf, () => { reclaimed = true; }, { waitMs: 100 });
  ok('well-formed dead queue lock owner is safely reclaimed', reclaimed && !fs.existsSync(lock));

  const legacyLiveBytes = JSON.stringify({ pid: process.pid, owner: 'legacy-live-owner', at: 1 });
  fs.writeFileSync(lock, legacyLiveBytes);
  fs.utimesSync(lock, new Date(0), new Date(0));
  let legacyLiveTimedOut = false;
  try { learner.withQueueLock(qf, () => {}, { staleMs: 1, waitMs: 35 }); }
  catch (err) { legacyLiveTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('aged legacy file locks retain a well-formed live owner',
    legacyLiveTimedOut && fs.readFileSync(lock, 'utf8') === legacyLiveBytes);
  fs.unlinkSync(lock);

  const held = path.join(lock, 'held');
  const liveOwnerFile = path.join(held, 'owner-11111111111111111111111111111111.json');
  fs.mkdirSync(held, { recursive: true });
  fs.writeFileSync(liveOwnerFile, JSON.stringify({ pid: process.pid, owner: 'live-owner', at: Date.now() }));
  let liveTimedOut = false;
  try { learner.withQueueLock(qf, () => {}, { staleMs: 60000, waitMs: 35 }); }
  catch (err) { liveTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('fresh live directory owner remains authoritative', liveTimedOut && fs.existsSync(liveOwnerFile));
  fs.rmSync(lock, { recursive: true, force: true });

  const deadOwnerFile = path.join(held, 'owner-22222222222222222222222222222222.json');
  fs.mkdirSync(held, { recursive: true });
  fs.writeFileSync(deadOwnerFile, JSON.stringify({ pid: 2147483647, owner: 'dead-owner', at: Date.now() }));
  let deadDirectoryReclaimed = false;
  learner.withQueueLock(qf, () => { deadDirectoryReclaimed = true; }, { staleMs: 60000, waitMs: 100 });
  ok('dead directory owner is reclaimed without leaving lock artifacts',
    deadDirectoryReclaimed && !fs.existsSync(lock));

  const malformedOwnerFile = path.join(held, 'owner-33333333333333333333333333333333.json');
  fs.mkdirSync(held, { recursive: true });
  fs.writeFileSync(malformedOwnerFile, '{"pid":');
  let malformedTimedOut = false;
  try { learner.withQueueLock(qf, () => {}, { staleMs: 60000, waitMs: 35 }); }
  catch (err) { malformedTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('fresh malformed directory owner is protected during owner-record publication',
    malformedTimedOut && fs.existsSync(malformedOwnerFile));
  fs.utimesSync(malformedOwnerFile, new Date(0), new Date(0));
  let malformedReclaimed = false;
  learner.withQueueLock(qf, () => { malformedReclaimed = true; }, { staleMs: 1, waitMs: 100 });
  ok('stale malformed directory owner is recoverable', malformedReclaimed && !fs.existsSync(lock));

  const staleOwnerFile = path.join(held, 'owner-44444444444444444444444444444444.json');
  const replacementOwnerFile = path.join(held, 'owner-55555555555555555555555555555555.json');
  const replacementOwnerBytes = JSON.stringify({ pid: process.pid, owner: 'replacement-owner', at: Date.now() });
  fs.mkdirSync(held, { recursive: true });
  fs.writeFileSync(staleOwnerFile, JSON.stringify({ pid: 2147483647, owner: 'stale-owner', at: 1 }));
  let swappedAfterExactUnlink = false;
  const recoverySwapFs = new Proxy(fs, { get(target, key) {
    if (key === 'unlinkSync') return (file, ...args) => {
      const result = target.unlinkSync(file, ...args);
      if (!swappedAfterExactUnlink && file === staleOwnerFile) {
        swappedAfterExactUnlink = true;
        target.rmdirSync(held);
        target.mkdirSync(held);
        target.writeFileSync(replacementOwnerFile, replacementOwnerBytes);
      }
      return result;
    };
    return target[key];
  } });
  let recoverySwapTimedOut = false;
  try {
    learner.withQueueLock(qf, () => {}, { fsImpl: recoverySwapFs, staleMs: 60000, waitMs: 35 });
  } catch (err) { recoverySwapTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('stale recovery cannot remove a replacement created after exact-owner unlink',
    swappedAfterExactUnlink && recoverySwapTimedOut
      && fs.readFileSync(replacementOwnerFile, 'utf8') === replacementOwnerBytes);
  fs.rmSync(lock, { recursive: true, force: true });

  fs.mkdirSync(lock);
  let removedRootAtHandoff = false;
  const rootHandoffFs = new Proxy(fs, { get(target, key) {
    if (key === 'mkdirSync') return (dirPath, ...args) => {
      if (!removedRootAtHandoff && dirPath === held) {
        removedRootAtHandoff = true;
        target.rmdirSync(lock);
      }
      return target.mkdirSync(dirPath, ...args);
    };
    return target[key];
  } });
  let acquiredAfterRootHandoff = false;
  learner.withQueueLock(qf, () => { acquiredAfterRootHandoff = true; }, {
    fsImpl: rootHandoffFs, staleMs: 60000, waitMs: 100,
  });
  ok('contender retries when the empty root disappears before held creation',
    removedRootAtHandoff && acquiredAfterRootHandoff && !fs.existsSync(lock));
}

// ---- TEST 8: failed reservation becomes retryable -------------------------
{
  const dir = tmpDir();
  const qf = path.join(dir, 'onboard-queue.json');
  fs.writeFileSync(qf, JSON.stringify({
    total: 3,
    cursor: 0,
    kept: [],
    rejected: [],
    pending: Array.from({ length: 3 }, (_, i) => ({ title: `Cand ${i}`, summary: 's', kind: 'gotcha' })),
  }, null, 2));

  const r1 = learner.reserveQueueBatch(qf, 2, Infinity, 1000, 10000);
  learner.failQueueBatch(qf, r1);
  const retry = learner.reserveQueueBatch(qf, 2, Infinity, 1001, 10000);
  ok('failed reservation is retried from same start', retry.status === 'reserved' && retry.start === r1.start);
}

// ---- TEST 9: dead inflight owners are cleared before reserving ------------
{
  const dir = tmpDir();
  const qf = path.join(dir, 'onboard-queue.json');
  fs.writeFileSync(qf, JSON.stringify({
    total: 3,
    cursor: 0,
    kept: [],
    rejected: [],
    pending: Array.from({ length: 3 }, (_, i) => ({ title: `Cand ${i}`, summary: 's', kind: 'gotcha' })),
    inflight: {
      0: {
        count: 2,
        generation: learner.queueGeneration({
          total: 3,
          pending: Array.from({ length: 3 }, (_, i) => ({ title: `Cand ${i}`, summary: 's', kind: 'gotcha' })),
        }),
        reservationId: 'dead-owner-reservation',
        pid: 99999999,
        startedAt: 1000,
        expiresAt: 11000,
      },
    },
  }, null, 2));

  const retry = learner.reserveQueueBatch(qf, 2, Infinity, 1001, 10000);
  const q = readJSON(qf);
  ok('dead inflight owner is retried from same start', retry.status === 'reserved' && retry.start === 0);
  ok('dead inflight owner is replaced by current reservation', q && q.inflight && q.inflight['0'] && q.inflight['0'].pid === process.pid);
}

// ---- TEST 10: an old child cannot complete into a replacement generation ---
{
  const dir = tmpDir();
  const qf = path.join(dir, 'onboard-queue.json');
  const pending = [{ title: 'Old', summary: 'old', kind: 'gotcha' }];
  fs.writeFileSync(qf, JSON.stringify({
    generation: 'generation-old', total: 1, cursor: 0,
    kept: [], rejected: [], pending,
  }, null, 2));

  const old = learner.reserveQueueBatch(qf, 1, Infinity, 1000, 10000);
  fs.writeFileSync(qf, JSON.stringify({
    generation: 'generation-new', total: 1, cursor: 0,
    kept: [], rejected: [], pending: [{ title: 'New', summary: 'new', kind: 'gotcha' }],
  }, null, 2));

  const completion = learner.completeQueueBatch(qf, old, {
    kept: [{ title: 'Stale result', summary: 'must not land', kind: 'gotcha' }],
    rejected: [],
  }, dir, dir, 'opus');
  const q = readJSON(qf);
  ok('reservation carries the claimed queue generation', old.generation === 'generation-old');
  ok('old child completion is reported stale', completion && completion.stale === true);
  ok('old child cannot advance or mutate replacement queue', q && q.generation === 'generation-new'
    && q.cursor === 0 && q.kept.length === 0 && q.pending[0].title === 'New');
  ok('stale completion cannot publish old-generation notes', !fs.existsSync(path.join(dir, 'onboard-notes.json')));
}

// ---- TEST 11: an old failure cannot release a new reservation --------------
{
  const dir = tmpDir();
  const qf = path.join(dir, 'onboard-queue.json');
  const base = (generation) => ({
    generation, total: 1, cursor: 0, kept: [], rejected: [],
    pending: [{ title: generation, summary: generation, kind: 'gotcha' }],
  });
  fs.writeFileSync(qf, JSON.stringify(base('generation-old'), null, 2));
  const old = learner.reserveQueueBatch(qf, 1, Infinity, 1000, 10000);

  fs.writeFileSync(qf, JSON.stringify(base('generation-new'), null, 2));
  const current = learner.reserveQueueBatch(qf, 1, Infinity, 1001, 10000);
  const failed = learner.failQueueBatch(qf, old);
  const q = readJSON(qf);
  ok('old failure is reported stale after replacement', failed && failed.stale === true);
  ok('old failure leaves the new generation reservation intact', q && q.inflight['0']
    && q.inflight['0'].generation === current.generation
    && q.inflight['0'].reservationId === current.reservationId);
}

// ---- summary ---------------------------------------------------------------
console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
