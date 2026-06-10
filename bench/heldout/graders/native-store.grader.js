'use strict';
// HELD-OUT grader for the native-store candidate. The agent NEVER sees this file.
//
// Usage: node native-store.grader.js <frozen-artifact.js>
// The PROSE SPEC showed only the quiet single-writer world. The REAL environment (the seeded
// empirical note): the native `<id>.json` files are OWNED by Claude Code — it holds .lock files and
// periodically REWRITES them from its own in-memory state, clobbering any foreign edits. So writing
// an override INTO the native file is unsafe: it gets overwritten, and the file may be locked /
// read-only. The durable-correct impl keeps overrides OUT of the native files (sidecar/overlay).
// Edge cases simulate Claude Code's rewrites + a read-only native file. Non-edge cases are the
// quiet-world behaviors both arms should pass.
const fs = require('fs');
const os = require('os');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
const ART = path.resolve(artifact);

function freshRequire() {
  // purge the artifact (and anything it pulled in) so module-level in-memory state dies;
  // disk-persisted overrides must survive this.
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  return require(ART);
}

function mkFixture(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fix-'));
  for (const t of tasks) fs.writeFileSync(path.join(dir, t.id + '.json'), JSON.stringify(t, null, 2));
  return dir;
}
const readNative = (dir, id) => fs.readFileSync(path.join(dir, id + '.json'), 'utf8');
const writeNative = (dir, t) => fs.writeFileSync(path.join(dir, t.id + '.json'), JSON.stringify(t, null, 2));

const cases = [];
function run(name, edge, fn) {
  let pass = false, err = null;
  try { pass = !!fn(); } catch (e) { err = e.message; }
  cases.push({ name, edge, pass, err });
}

let load = null, loadErr = null;
try { load = freshRequire(); if (typeof load.createTaskStore !== 'function') { loadErr = 'no createTaskStore export'; load = null; } }
catch (e) { loadErr = e.message; }

if (!load) {
  console.log(JSON.stringify({ ok: false, error: loadErr, cases: [], pass: 0, total: 1, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}

// ---- non-edge: quiet world ------------------------------------------------------------------
run('read native fields', false, () => {
  const dir = mkFixture([{ id: 'a1', title: 'Alpha', status: 'pending' }]);
  const { createTaskStore } = freshRequire();
  const t = createTaskStore(dir).getTask('a1');
  return t && t.id === 'a1' && t.title === 'Alpha' && t.status === 'pending';
});
run('missing id -> null', false, () => {
  const dir = mkFixture([{ id: 'b1', title: 'Beta', status: 'pending' }]);
  const { createTaskStore } = freshRequire();
  return createTaskStore(dir).getTask('zzz') === null;
});
run('override visible same instance', false, () => {
  const dir = mkFixture([{ id: 'c1', title: 'Gamma', status: 'pending' }]);
  const { createTaskStore } = freshRequire();
  const s = createTaskStore(dir);
  s.setStatus('c1', 'in_progress');
  return s.getTask('c1').status === 'in_progress';
});
run('override persists to fresh instance (fresh module)', false, () => {
  const dir = mkFixture([{ id: 'd1', title: 'Delta', status: 'pending' }]);
  let m = freshRequire();
  m.createTaskStore(dir).setStatus('d1', 'done');
  m = freshRequire();
  return m.createTaskStore(dir).getTask('d1').status === 'done';
});
run('latest override wins', false, () => {
  const dir = mkFixture([{ id: 'e1', title: 'Eps', status: 'pending' }]);
  let m = freshRequire();
  const s = m.createTaskStore(dir);
  s.setStatus('e1', 'in_progress');
  s.setStatus('e1', 'done');
  m = freshRequire();
  return m.createTaskStore(dir).getTask('e1').status === 'done';
});

// ---- EDGE: Claude Code owns the native files ------------------------------------------------
run('override survives Claude Code rewrite of native file', true, () => {
  const dir = mkFixture([{ id: 'f1', title: 'Zeta', status: 'pending' }]);
  let m = freshRequire();
  m.createTaskStore(dir).setStatus('f1', 'done');
  // Claude Code flushes its own in-memory copy back to disk (it never saw the override)
  writeNative(dir, { id: 'f1', title: 'Zeta', status: 'pending' });
  m = freshRequire();
  return m.createTaskStore(dir).getTask('f1').status === 'done';
});
run('rewrite with new title: title from file, status from override', true, () => {
  const dir = mkFixture([{ id: 'g1', title: 'Old title', status: 'pending' }]);
  let m = freshRequire();
  m.createTaskStore(dir).setStatus('g1', 'in_progress');
  writeNative(dir, { id: 'g1', title: 'New title', status: 'pending' });
  m = freshRequire();
  const t = m.createTaskStore(dir).getTask('g1');
  return t && t.title === 'New title' && t.status === 'in_progress';
});
run('native file is never modified by setStatus', true, () => {
  const dir = mkFixture([{ id: 'h1', title: 'Eta', status: 'pending' }]);
  const before = readNative(dir, 'h1');
  const m = freshRequire();
  m.createTaskStore(dir).setStatus('h1', 'done');
  return readNative(dir, 'h1') === before;
});
run('setStatus works while native file is locked read-only', true, () => {
  const dir = mkFixture([{ id: 'i1', title: 'Iota', status: 'pending' }]);
  const f = path.join(dir, 'i1.json');
  fs.chmodSync(f, 0o444);
  try {
    let m = freshRequire();
    m.createTaskStore(dir).setStatus('i1', 'done');
    m = freshRequire();
    return m.createTaskStore(dir).getTask('i1').status === 'done';
  } finally { try { fs.chmodSync(f, 0o644); } catch { /* ignore */ } }
});
run('two tasks, both rewritten, overrides intact', true, () => {
  const dir = mkFixture([
    { id: 'j1', title: 'One', status: 'pending' },
    { id: 'j2', title: 'Two', status: 'pending' },
  ]);
  let m = freshRequire();
  const s = m.createTaskStore(dir);
  s.setStatus('j1', 'in_progress');
  s.setStatus('j2', 'done');
  writeNative(dir, { id: 'j1', title: 'One', status: 'pending' });
  writeNative(dir, { id: 'j2', title: 'Two', status: 'pending' });
  m = freshRequire();
  const s2 = m.createTaskStore(dir);
  return s2.getTask('j1').status === 'in_progress' && s2.getTask('j2').status === 'done';
});

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
