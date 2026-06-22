#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  skillIdentity,
  sameSkillIdentity,
  loadManifest,
  readVersionRecords,
  recordGeneratedSkillVersion,
  listSkillVersions,
  setActiveSkillVersion,
  getActiveSkillVersion,
} = require('../lib/skill-versions');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-skill-versions-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function skillMd(name, body) {
  return `---\nname: ${name}\ndescription: generated skill\n---\n\n# ${name}\n\n${body}\n`;
}

test('skill identity normalizes path and name aliases deterministically', () => {
  assert.deepEqual(skillIdentity({ skill_path: '/repo/skills/Sub Conscious/SKILL.md' }), {
    skill_id: 'skill:sub-conscious',
    slug: 'sub-conscious',
    source: 'path',
    value: 'Sub Conscious',
  });
  assert.equal(sameSkillIdentity(
    { skill_path: '/repo/skills/Sub Conscious/SKILL.md' },
    { name: 'sub conscious' }
  ), true);
  assert.equal(skillIdentity({ skill_markdown: skillMd('Agent Planner', 'body') }).skill_id, 'skill:agent-planner');
});

test('generated versions are immutable rows with provenance and content dedup', () => {
  const ws = makeWorkspace();
  const first = recordGeneratedSkillVersion(ws, {
    target_path: '/repo/skills/agent-planner/SKILL.md',
    skill_markdown: skillMd('Agent Planner', 'prefer measured alternatives'),
    agent_id: 'worker-a',
    task_key: 'task/skill',
    source: 'subconscious',
    now: '2026-06-21T12:00:00.000Z',
  });
  const duplicate = recordGeneratedSkillVersion(ws, {
    target_path: '/repo/skills/agent-planner/SKILL.md',
    skill_markdown: skillMd('Agent Planner', 'prefer measured alternatives'),
    agent_id: 'worker-b',
    task_key: 'task/other',
    now: '2026-06-21T12:01:00.000Z',
  });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.record.version_id, duplicate.record.version_id);
  assert.equal(first.record.skill_id, 'skill:agent-planner');
  assert.equal(first.record.provenance.generated_by, 'worker-a');
  assert.equal(first.record.provenance.task_key, 'task/skill');
  assert.equal(readVersionRecords(ws).length, 1);
});

test('overlapping generated candidates become versions of one skill', () => {
  const ws = makeWorkspace();
  const v1 = recordGeneratedSkillVersion(ws, {
    target_path: '/repo/skills/context-planner/SKILL.md',
    skill_markdown: skillMd('Context Planner', 'first candidate'),
    agent_id: 'worker-a',
  });
  const v2 = recordGeneratedSkillVersion(ws, {
    target_path: '/repo/skills/context-planner/SKILL.md',
    skill_markdown: skillMd('Context Planner Experimental', 'second candidate'),
    agent_id: 'worker-b',
  });

  assert.notEqual(v1.record.version_id, v2.record.version_id);
  assert.equal(v1.record.skill_id, v2.record.skill_id);
  assert.deepEqual(listSkillVersions(ws, { name: 'context planner' }).map((r) => r.version_id), [
    v1.record.version_id,
    v2.record.version_id,
  ]);

  const manifest = loadManifest(ws);
  assert.deepEqual(manifest.skills['skill:context-planner'].version_ids, [
    v1.record.version_id,
    v2.record.version_id,
  ]);
  assert.equal(manifest.skills['skill:context-planner'].active_version_id, null);
});

test('active manifest pointer selects a version without deleting older versions or writing SKILL.md', () => {
  const ws = makeWorkspace();
  const activeSkill = path.join(ws, 'skills', 'context-planner', 'SKILL.md');
  fs.mkdirSync(path.dirname(activeSkill), { recursive: true });
  fs.writeFileSync(activeSkill, 'original active skill\n');

  const v1 = recordGeneratedSkillVersion(ws, {
    target_path: activeSkill,
    skill_markdown: skillMd('Context Planner', 'candidate one'),
    agent_id: 'worker-a',
  });
  const v2 = recordGeneratedSkillVersion(ws, {
    target_path: activeSkill,
    skill_markdown: skillMd('Context Planner', 'candidate two'),
    agent_id: 'worker-b',
  });

  const selected = setActiveSkillVersion(ws, {
    target_path: activeSkill,
    version_id: v2.record.version_id,
    activated_by: 'judge',
    task_key: 'task/judge',
    reason: 'measured winner',
    now: '2026-06-21T12:05:00.000Z',
  });
  const active = getActiveSkillVersion(ws, { target_path: activeSkill });
  const manifest = loadManifest(ws);

  assert.equal(selected.active_version.version_id, v2.record.version_id);
  assert.equal(active.version_id, v2.record.version_id);
  assert.equal(manifest.skills['skill:context-planner'].active_version_id, v2.record.version_id);
  assert.equal(manifest.skills['skill:context-planner'].activation_history.length, 1);
  assert.deepEqual(listSkillVersions(ws, { target_path: activeSkill }).map((r) => r.version_id), [
    v1.record.version_id,
    v2.record.version_id,
  ]);
  assert.equal(fs.readFileSync(activeSkill, 'utf8'), 'original active skill\n');
});

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
