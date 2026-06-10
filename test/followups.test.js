#!/usr/bin/env node
// Plain Node test for lib/followups.js — structural follow-ups on complete_task (no framework;
// matches test/guidance-resolve.test.js style). Run: node test/followups.test.js.
//
// Properties:
//   - validate: rejects non-arrays, missing title/prompt, bad `when`, non-boolean disruptive;
//     accepts asap/ISO/disruptive items.
//   - apply (asap): snapshot-backed task node (key 'followup/<slug>-*', description = prompt,
//     status 'pending') + context edge parent → follow-up, NO status override (derives ready),
//     and aggregateWorkspace serves the node with no native file.
//   - apply (timed): not_ready override so the loop can't fire it early; routing 'scheduled'.
//   - apply (disruptive): severity-'review' guidance with action {kind:'follow-up', task_key};
//     task held not_ready; resolveGate approve → override dropped; reject → canceled + flag.
//   - writeScheduledTask: SKILL.md written under <claudeDir>/scheduled-tasks/<id>/ and an armed
//     { fireAt, enabled } entry appended to the central registry (existing entries preserved);
//     missing registry ⇒ armed:false but the SKILL.md still lands. Exercised against TEMP dirs —
//     never touches the real ~/.claude or app support.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const fu = require('../lib/followups');
const nt = require('../lib/native-tasks');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- validate ----------------------------------------------------------------------------------
{
  ok('validate rejects non-array', fu.validate({}) != null);
  ok('validate rejects missing title', fu.validate([{ prompt: 'p' }]) != null);
  ok('validate rejects missing prompt', fu.validate([{ title: 't' }]) != null);
  ok('validate rejects bad when', fu.validate([{ title: 't', prompt: 'p', when: 'tomorrow-ish' }]) != null);
  ok('validate rejects non-boolean disruptive', fu.validate([{ title: 't', prompt: 'p', disruptive: 'yes' }]) != null);
  ok('validate accepts minimal item', fu.validate([{ title: 't', prompt: 'p' }]) === null);
  ok('validate accepts asap + ISO + disruptive', fu.validate([
    { title: 'a', prompt: 'p', when: 'asap' },
    { title: 'b', prompt: 'p', when: '2027-01-01T01:30:00Z' },
    { title: 'c', prompt: 'p', disruptive: true },
  ]) === null);
}

// --- apply: asap → ready node + context edge ---------------------------------------------------
{
  const o = ov.EMPTY();
  const parent = 'sess1/42';
  const res = fu.apply(o, parent, [{ title: 'Restart the daemon', prompt: 'Restart it. Self-contained.' }]);
  ok('asap result routing is ready', res.length === 1 && res[0].routing === 'ready');
  const key = res[0].key;
  ok('key uses the followup pseudo-session + slug', /^followup\/restart-the-daemon-[a-z0-9]+$/.test(key));
  const snap = o.snapshots[key];
  ok('snapshot node carries title + prompt', snap && snap.subject === 'Restart the daemon' && snap.description === 'Restart it. Self-contained.');
  ok('snapshot status is pending (derives ready downstream)', snap.status === 'pending');
  ok('snapshot records parent provenance', snap.metadata && snap.metadata.follow_up_of === parent);
  ok('context edge parent → follow-up', o.edges.some((e) => e.from === parent && e.to === key && e.kind === 'context'));
  ok('asap leaves NO status override', o.status[key] === undefined);
  // The snapshot substrate serves the node as a real task with no native file present.
  const agg = nt.aggregateWorkspace('/tmp/orch-followups-no-such-workspace', o.snapshots);
  const node = agg.find((t) => t.key === key);
  ok('aggregateWorkspace serves the follow-up node', !!node && node.label === 'Restart the daemon' && node.native_status === 'pending');
}

// --- apply: timed → not_ready + routing scheduled ----------------------------------------------
{
  const o = ov.EMPTY();
  const when = new Date(Date.now() + 3600_000).toISOString();
  const res = fu.apply(o, 's/1', [{ title: 'Nightly check', prompt: 'Check things.', when }]);
  ok('timed routing is scheduled with fireAt', res[0].routing === 'scheduled' && res[0].fireAt === Date.parse(when));
  ok('timed task held not_ready (loop must not fire it early)', o.status[res[0].key] === 'not_ready');
  // A PAST timestamp degrades to immediate.
  const past = fu.apply(o, 's/1', [{ title: 'Late', prompt: 'p', when: '2020-01-01T00:00:00Z' }]);
  ok('past `when` degrades to ready', past[0].routing === 'ready' && o.status[past[0].key] === undefined);
}

// --- apply: disruptive → review guidance + gate; resolveGate approve/reject --------------------
{
  const o = ov.EMPTY();
  const res = fu.apply(o, 's/1', [{ title: 'Restart prod daemon', prompt: 'Kill + relaunch.', when: '2027-06-11T01:30:00Z', disruptive: true }]);
  const r = res[0];
  ok('disruptive routing is gated with a guidance id', r.routing === 'gated' && !!r.guidance_id);
  ok('disruptive task held not_ready', o.status[r.key] === 'not_ready');
  const g = o.guidance.find((x) => x.id === r.guidance_id);
  ok('guidance is severity review (queues without pausing)', g && g.severity === 'review');
  ok('guidance question = title, context carries prompt + timing', g.question === 'Restart prod daemon' && g.context.includes('Kill + relaunch.') && g.context.includes('2027-06-11'));
  ok('guidance action targets the task', g.action && g.action.kind === 'follow-up' && g.action.task_key === r.key);
  // approve → override dropped (re-derives ready)
  const ap = fu.resolveGate(o, g.action, 'approve');
  ok('approve releases the task (override dropped)', ap && ap.released === r.key && o.status[r.key] === undefined);
  // reject → canceled + cooperative cancel flag
  const res2 = fu.apply(o, 's/1', [{ title: 'Wipe cache', prompt: 'rm it', disruptive: true }]);
  const g2 = o.guidance.find((x) => x.id === res2[0].guidance_id);
  const rj = fu.resolveGate(o, g2.action, 'reject');
  ok('reject cancels the task', rj && rj.canceled === res2[0].key && o.status[res2[0].key] === 'canceled');
  ok('reject raises the cooperative cancel flag', !!o.cancel_requested[res2[0].key]);
  // any other answer leaves the gate closed
  const res3 = fu.apply(o, 's/1', [{ title: 'Maybe', prompt: 'p', disruptive: true }]);
  const g3 = o.guidance.find((x) => x.id === res3[0].guidance_id);
  ok('non-approve/reject answer keeps the task gated', fu.resolveGate(o, g3.action, 'let me think') === null && o.status[res3[0].key] === 'not_ready');
}

// --- writeScheduledTask against TEMP roots ------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-test-'));
  try {
    const claudeDir = path.join(tmp, '.claude');
    const appSupportDir = path.join(tmp, 'AppSupport');
    const regDir = path.join(appSupportDir, 'Claude', 'claude-code-sessions', 'u-1111', 's-2222');
    fs.mkdirSync(regDir, { recursive: true });
    const regPath = path.join(regDir, 'scheduled-tasks.json');
    fs.writeFileSync(regPath, JSON.stringify({ scheduledTasks: [{ id: 'pre-existing', cronExpression: '0 2 * * *', enabled: true, filePath: '/x/SKILL.md', createdAt: 1, cwd: '/x' }], recordedSkips: {} }, null, 2));

    const fireAt = Date.parse('2027-06-11T01:30:00Z');
    const w = fu.writeScheduledTask({ id: 'nightly-check-ab12', title: 'Nightly check', prompt: 'Check the things.\nThen report.', taskKey: 'followup/nightly-check-ab12', when: '2027-06-11T01:30:00Z', fireAt, cwd: '/Users/x/proj', claudeDir, appSupportDir });
    ok('writer reports ok + armed', w.ok === true && w.armed === true && w.registryPath === regPath);
    const skill = fs.readFileSync(path.join(claudeDir, 'scheduled-tasks', 'nightly-check-ab12', 'SKILL.md'), 'utf8');
    ok('SKILL.md has name/description frontmatter', /^---\nname: nightly-check-ab12\ndescription: .+\n---\n/.test(skill));
    ok('SKILL.md instructs claim → prompt → complete', skill.includes('start_task') && skill.includes('Check the things.') && skill.includes('complete_task') && skill.includes('followup/nightly-check-ab12'));
    ok('SKILL.md documents the no-stored-approvals limitation', skill.includes('no stored tool approvals'));
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    ok('registry keeps the pre-existing entry', reg.scheduledTasks.some((t) => t.id === 'pre-existing'));
    const mine = reg.scheduledTasks.find((t) => t.id === 'nightly-check-ab12');
    ok('registry entry matches the observed shape', !!mine && mine.fireAt === fireAt && mine.enabled === true && mine.filePath === w.skillPath && mine.cwd === '/Users/x/proj' && typeof mine.createdAt === 'number');
    ok('no tmp residue beside SKILL.md', fs.readdirSync(path.dirname(w.skillPath)).every((f) => !f.includes('.tmp')));
    ok('no tmp residue beside the registry', fs.readdirSync(regDir).every((f) => !f.includes('.tmp')));

    // Missing registry ⇒ SKILL.md still written, armed:false with a note.
    const w2 = fu.writeScheduledTask({ id: 'orphan-cd34', title: 'Orphan', prompt: 'p', taskKey: 'followup/orphan-cd34', when: '2027-01-01T00:00:00Z', fireAt: Date.parse('2027-01-01T00:00:00Z'), cwd: '/x', claudeDir, appSupportDir: path.join(tmp, 'NoAppSupport') });
    ok('missing registry ⇒ armed:false + note, skill still written', w2.ok === true && w2.armed === false && !!w2.note && fs.existsSync(path.join(claudeDir, 'scheduled-tasks', 'orphan-cd34', 'SKILL.md')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
