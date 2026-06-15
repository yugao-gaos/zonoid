#!/usr/bin/env node
// edge-clf-featurize.test.js — unit tests for the edge-clf-featurize.js featurizer.
// Run: node test/edge-clf-featurize.test.js
'use strict';

const { nodeTypeFromKey, sessionPrefix, readJsonl } = require('../scripts/edge-clf-featurize');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// ── nodeTypeFromKey ───────────────────────────────────────────────────────────
ok('note: prefix → note', nodeTypeFromKey('note:note-mq123abc') === 'note');
ok('followup/ prefix → followup', nodeTypeFromKey('followup/harness-judge-drain') === 'followup');
ok('bench/ prefix → bench', nodeTypeFromKey('bench/context-inject') === 'bench');
ok('local/ prefix → local', nodeTypeFromKey('local/ready-flag-fix') === 'local');
ok('UUID/N pattern → task', nodeTypeFromKey('091a4bf1-b671-4ff9-854d-993775faa5ee/7') === 'task');
ok('bare UUID → task', nodeTypeFromKey('091a4bf1-b671-4ff9-854d-993775faa5ee') === 'task');
ok('null → other', nodeTypeFromKey(null) === 'other');
ok('unknown key → other', nodeTypeFromKey('random-key') === 'other');

// ── sessionPrefix ─────────────────────────────────────────────────────────────
ok('UUID/N extracts UUID prefix', sessionPrefix('091a4bf1-b671-4ff9-854d-993775faa5ee/7') === '091a4bf1-b671-4ff9-854d-993775faa5ee');
ok('bare UUID extracts itself', sessionPrefix('091a4bf1-b671-4ff9-854d-993775faa5ee') === '091a4bf1-b671-4ff9-854d-993775faa5ee');
ok('note: key → null (no session)', sessionPrefix('note:note-mq123') === null);
ok('followup/ key → null', sessionPrefix('followup/foo') === null);
ok('null → null', sessionPrefix(null) === null);

// ── readJsonl ─────────────────────────────────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clf-featurize-test-'));
  const file = path.join(tmp, 'test.jsonl');

  // Write 3 lines: 2 valid, 1 corrupt
  fs.writeFileSync(file,
    JSON.stringify({ verdict: 'keep', cosine: 0.5 }) + '\n' +
    'not-json-garbage\n' +
    JSON.stringify({ verdict: 'prune', cosine: 0.3 }) + '\n',
    'utf8'
  );

  const rows = readJsonl(file);
  ok('readJsonl reads 2 valid rows (skips corrupt)', rows.length === 2);
  ok('readJsonl returns first row correctly', rows[0].verdict === 'keep' && rows[0].cosine === 0.5);

  const missing = readJsonl(path.join(tmp, 'nonexistent.jsonl'));
  ok('readJsonl on missing file returns []', Array.isArray(missing) && missing.length === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── structural feature derivation (simulated inline) ─────────────────────────
// Replicate the same_session / both_notes / note_to_task / task_to_task logic.
{
  const isTaskLike = (t) => t === 'task' || t === 'followup' || t === 'bench' || t === 'local';

  const checkRow = (from, to) => {
    const src = nodeTypeFromKey(from);
    const tgt = nodeTypeFromKey(to);
    const sp = sessionPrefix(from);
    const tp = sessionPrefix(to);
    return {
      same_session: !!(sp && tp && sp === tp),
      both_notes: src === 'note' && tgt === 'note',
      note_to_task: src === 'note' && isTaskLike(tgt),
      task_to_task: isTaskLike(src) && isTaskLike(tgt),
    };
  };

  const noteTotask = checkRow('note:note-mq123', '091a4bf1-b671-4ff9-854d-993775faa5ee/5');
  ok('note→task: note_to_task=true', noteTotask.note_to_task === true);
  ok('note→task: both_notes=false', noteTotask.both_notes === false);
  ok('note→task: task_to_task=false', noteTotask.task_to_task === false);

  const noteToNote = checkRow('note:note-aaa', 'note:note-bbb');
  ok('note→note: both_notes=true', noteToNote.both_notes === true);
  ok('note→note: note_to_task=false', noteToNote.note_to_task === false);

  const sameSession = checkRow(
    '091a4bf1-b671-4ff9-854d-993775faa5ee/2',
    '091a4bf1-b671-4ff9-854d-993775faa5ee/7'
  );
  ok('same UUID prefix → same_session=true', sameSession.same_session === true);

  const diffSession = checkRow(
    '091a4bf1-b671-4ff9-854d-993775faa5ee/2',
    'd08e0c33-36f1-49a6-b946-dff7dff71c5c/1'
  );
  ok('different UUID prefix → same_session=false', diffSession.same_session === false);

  const followupToTask = checkRow('followup/harness-judge-drain', '091a4bf1-b671-4ff9-854d-993775faa5ee/3');
  ok('followup→task: task_to_task=true', followupToTask.task_to_task === true);
  ok('followup→task: note_to_task=false', followupToTask.note_to_task === false);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
