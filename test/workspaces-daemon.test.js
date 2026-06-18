#!/usr/bin/env node
// Integration test for GET /workspaces — asserts the union list, current flag, and basename name.
// P3 (deprecate-global-workspace): there is NO daemon-global current pointer. The `current` flag
// reflects the OPTIONAL ?workspace= the caller passes; /state without a workspace 400s; and
// multiple workspaces stay isolated (each ?workspace= read targets exactly that workspace).
//
// U3/U7 SHAPE: GET /workspaces default now returns the GROUPED shape
//   [{ name, repos:[{path,name,current}], current }]  — a workspace is a NAMED group of repos.
// ?flat=1 keeps the LEGACY flat shape [{path,name,current}] for U6 rollout compat. Repos present on
// disk but not registered under a named workspace bucket under a synthetic "(unregistered)" group.
// Assertions below traverse the grouped shape via the `repoEntries()` flattener (collects every
// {path,name,current} across all groups); the (B*)/(C*)/(D*) cases pin the grouped structure, the
// `?flat=1` case pins legacy compat, and the orphan case pins the "(unregistered)" bucket.
// Pattern mirrors adopt-native-daemon.test.js: in-process http against a sandboxed spawned daemon.
// Run: node test/workspaces-daemon.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-list-d-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;

const PORT = 18960 + Math.floor(Math.random() * 100);

// Two distinct temp workspaces: WS1 (primary, set via /workspace) and WS2 (secondary).
// Each gets a .graph sub-dir so the existence+.graph filter in GET /workspaces lets them through.
const WS1 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslist-ws1-')));
fs.mkdirSync(path.join(WS1, '.graph'), { recursive: true });
const WS2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslist-ws2-')));
fs.mkdirSync(path.join(WS2, '.graph'), { recursive: true });

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// Flatten the GROUPED /workspaces body ([{name,repos:[{path,name,current}],current}]) into a flat
// array of every repo entry {path,name,current,group} across all groups — the unit the per-repo
// assertions reason about. (`group` is the owning workspace name, used by the orphan-bucket case.)
const repoEntries = (body) => (body.workspaces || []).flatMap(
  (g) => (g.repos || []).map((r) => ({ ...r, group: g.name })),
);
// Find the group object for a given repo path (or undefined).
const groupOf = (body, repoPath) => (body.workspaces || []).find(
  (g) => (g.repos || []).some((r) => r.path === repoPath),
);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function spawnDaemon() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
}

(async () => {
  let child = spawnDaemon();
  try {
    ok('daemon came up', await waitForPing());

    // (A) Initial state: no workspace set yet → /workspaces returns the GROUPED shape (a possibly
    // empty array of {name, repos:[], current} group objects).
    {
      const r = await req('GET', '/workspaces');
      ok('(A) /workspaces returns ok:true', r.status === 200 && r.body.ok === true);
      ok('(A) workspaces is an array', Array.isArray(r.body.workspaces));
      // Grouped shape: every top-level entry is a group {name, repos:[]} — NOT a bare repo {path}.
      ok('(A) every entry is a grouped {name,repos[]} (not a flat {path})',
        (r.body.workspaces || []).every((w) => typeof w.name === 'string' && Array.isArray(w.repos)));
    }

    // (B) Register WS1. P3: there is NO daemon-global current pointer — the `current` flag on
    // /workspaces reflects the OPTIONAL ?workspace= the CALLER passes, not a server-side default.
    await req('POST', '/workspace', { path: WS1 });

    {
      const r = await req('GET', `/workspaces?workspace=${encodeURIComponent(WS1)}`);
      ok('(B) /workspaces ok after registering WS1', r.status === 200 && r.body.ok === true);
      const entries = repoEntries(r.body);
      const ws1Entry = entries.find((w) => w.path === WS1);
      ok('(B) WS1 repo appears in some group', !!ws1Entry);
      ok('(B) WS1 repo has current:true when ?workspace=WS1', ws1Entry && ws1Entry.current === true);
      ok('(B) WS1 repo name is basename', ws1Entry && ws1Entry.name === path.basename(WS1));
      ok('(B) current field echoes the ?workspace= param (WS1)', r.body.current === WS1);
      // The owning GROUP's current flag propagates from the current repo.
      const ws1Group = groupOf(r.body, WS1);
      ok('(B) WS1 owning group has current:true', ws1Group && ws1Group.current === true);
    }

    {
      // No ?workspace= ⇒ no current (P3: no global default to seed it).
      const r = await req('GET', '/workspaces');
      ok('(B) /workspaces without ?workspace= has current:null', r.body.current === null);
      const ws1Entry = repoEntries(r.body).find((w) => w.path === WS1);
      ok('(B) WS1 still listed but current:false without ?workspace=', ws1Entry && ws1Entry.current === false);
      const ws1Group = groupOf(r.body, WS1);
      ok('(B) WS1 owning group current:false without ?workspace=', ws1Group && ws1Group.current === false);
    }

    // (C) Register WS2 — both appear; `current` follows whichever ?workspace= the caller asks for.
    await req('POST', '/workspace', { path: WS2, force: true });

    {
      const r = await req('GET', `/workspaces?workspace=${encodeURIComponent(WS2)}`);
      ok('(C) /workspaces ok after registering WS2', r.status === 200 && r.body.ok === true);
      const entries = repoEntries(r.body);
      const ws1Entry = entries.find((w) => w.path === WS1);
      const ws2Entry = entries.find((w) => w.path === WS2);
      ok('(C) WS1 still listed', !!ws1Entry);
      ok('(C) WS2 listed', !!ws2Entry);
      ok('(C) WS1 repo current:false when ?workspace=WS2', ws1Entry && ws1Entry.current === false);
      ok('(C) WS2 repo current:true when ?workspace=WS2', ws2Entry && ws2Entry.current === true);
      ok('(C) WS2 repo name is basename', ws2Entry && ws2Entry.name === path.basename(WS2));
      ok('(C) current field echoes ?workspace= (WS2)', r.body.current === WS2);
      // Only the WS2-owning group is current; the WS1-owning group is not.
      const ws2Group = groupOf(r.body, WS2);
      const ws1Group = groupOf(r.body, WS1);
      ok('(C) WS2 owning group current:true', ws2Group && ws2Group.current === true);
      ok('(C) WS1 owning group current:false', ws1Group && ws1Group.current === false);
      // Every group is well-formed; every repo entry has non-empty path and name.
      const groups = r.body.workspaces || [];
      ok('(C) all groups have name + repos array', groups.every((g) => g.name && Array.isArray(g.repos)));
      ok('(C) all repo entries have path and name', entries.every((w) => w.path && w.name));
      // No duplicate repo paths across the whole grouped structure.
      const paths = entries.map((w) => w.path);
      ok('(C) no duplicate repo paths across groups', new Set(paths).size === paths.length);
    }

    // (C-flat) ?flat=1 — LEGACY flat shape [{path,name,current}] for U6 rollout compat. Entries are
    // bare repos (have a top-level `path`), NOT grouped {name,repos[]} objects. Same union + current
    // semantics as the grouped default, just flattened.
    {
      const r = await req('GET', `/workspaces?flat=1&workspace=${encodeURIComponent(WS2)}`);
      ok('(C-flat) ?flat=1 returns ok:true', r.status === 200 && r.body.ok === true);
      const list = r.body.workspaces || [];
      ok('(C-flat) every entry is a flat repo {path,name} (no nested repos[])',
        list.length > 0 && list.every((w) => typeof w.path === 'string' && w.path && !Array.isArray(w.repos)));
      const ws1Entry = list.find((w) => w.path === WS1);
      const ws2Entry = list.find((w) => w.path === WS2);
      ok('(C-flat) WS1 present in flat list', !!ws1Entry);
      ok('(C-flat) WS2 present in flat list', !!ws2Entry);
      ok('(C-flat) WS2 current:true when ?workspace=WS2', ws2Entry && ws2Entry.current === true);
      ok('(C-flat) WS1 current:false when ?workspace=WS2', ws1Entry && ws1Entry.current === false);
      ok('(C-flat) WS2 name is basename', ws2Entry && ws2Entry.name === path.basename(WS2));
      ok('(C-flat) current field echoes ?workspace= (WS2)', r.body.current === WS2);
    }

    // (C-orphan) Synthetic "(unregistered)" bucket: a repo present on disk (with a .graph) that the
    // daemon learned via graphStore/session/agent reads but was NEVER registered under a named
    // workspace in workspaces.json must surface — grouped under the "(unregistered)" group. Drive it
    // by binding a fresh repo whose name we then confirm does NOT key its own registry group.
    {
      const ORPHAN_NAME = '(unregistered)';
      // A real on-disk repo dir with a .graph, never added via /workspace/add-repo to a named group.
      const ORPH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslist-orphan-')));
      fs.mkdirSync(path.join(ORPH, '.graph'), { recursive: true });
      // Read it through /state so the daemon opens its graphStore + records a session workspace, the
      // same way an unregistered repo becomes daemon-known without ever joining a named group.
      await req('GET', `/state?workspace=${encodeURIComponent(ORPH)}`);

      const r = await req('GET', '/workspaces');
      ok('(C-orphan) /workspaces ok', r.status === 200 && r.body.ok === true);
      const orphGroup = (r.body.workspaces || []).find((g) => g.name === ORPHAN_NAME);
      ok('(C-orphan) "(unregistered)" group exists', !!orphGroup);
      ok('(C-orphan) orphan repo lives under the "(unregistered)" group',
        orphGroup && orphGroup.repos.some((rp) => rp.path === ORPH));
      // It is NOT mis-bucketed into its own basename-named group.
      const ownNameGroup = (r.body.workspaces || []).find((g) => g.name === path.basename(ORPH));
      ok('(C-orphan) orphan repo did NOT create its own named group',
        !ownNameGroup || !ownNameGroup.repos.some((rp) => rp.path === ORPH));
      try { fs.rmSync(ORPH, { recursive: true, force: true }); } catch { /* */ }
    }

    // (D) workspaces.json registry was persisted — verify file on disk.
    // U2 wired lib/workspace-registry into the daemon: the file is now the v2 grouped shape
    // { version:2, workspaces:{ <name>:{ repos:[...] } } }, NOT the legacy v1 flat array. Each repo
    // registers under a single-repo workspace keyed by basename(repo) (default group). We assert the
    // flattened member set (allRepos-equivalent) contains both repo PATHS.
    {
      let stored;
      try { stored = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'workspaces.json'), 'utf8')); } catch { stored = null; }
      const allRepos = (reg) => {
        if (!reg || reg.version !== 2 || !reg.workspaces) return [];
        return Object.values(reg.workspaces).flatMap((w) => (w && Array.isArray(w.repos) ? w.repos : []));
      };
      ok('(D) workspaces.json written to disk (v2 shape)', stored && stored.version === 2 && stored.workspaces && typeof stored.workspaces === 'object');
      ok('(D) WS1 in registry file', allRepos(stored).includes(WS1));
      ok('(D) WS2 in registry file', allRepos(stored).includes(WS2));
    }

    // (E) P3: GET /state without ?workspace= 400s (no daemon-global default to fall back onto).
    {
      const r = await req('GET', '/state');
      ok('(E) /state without ?workspace= returns 400 (no global default)', r.status === 400 && r.body.ok === false);
    }

    // (F) GET /state?workspace=WSn targets exactly that workspace (per-request binding, isolated).
    {
      const r1 = await req('GET', `/state?workspace=${encodeURIComponent(WS1)}`);
      ok('(F) /state?workspace=WS1 returns WS1', r1.status === 200 && r1.body.workspace === WS1);
      const r2 = await req('GET', `/state?workspace=${encodeURIComponent(WS2)}`);
      ok('(F) /state?workspace=WS2 returns WS2 (no global pointer to clobber)', r2.status === 200 && r2.body.workspace === WS2);
    }

    // (G) Ghost path: a path that never existed on disk is dropped from /workspaces.
    // Inject a nonexistent path directly into the registry file; the daemon reads it fresh.
    {
      const GHOST = path.join(os.tmpdir(), 'orch-wslist-ghost-never-existed-' + Date.now());
      const wsFile = path.join(SANDBOX, 'workspaces.json');
      let known = [];
      try { known = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch { /* */ }
      if (!Array.isArray(known)) known = [];
      if (!known.includes(GHOST)) { known.push(GHOST); fs.writeFileSync(wsFile, JSON.stringify(known)); }

      const r = await req('GET', '/workspaces');
      ok('(G) /workspaces ok with ghost in registry', r.status === 200 && r.body.ok === true);
      const entries = repoEntries(r.body);
      ok('(G) ghost nonexistent path is absent from list', !entries.some((w) => w.path === GHOST));
      // Real workspaces are still present
      ok('(G) WS2 still in list despite ghost', entries.some((w) => w.path === WS2));
    }

    // (H) Removed-dir workspace disappears: delete WS1 from disk; it should drop out of the list.
    // WS1 is currently in the registry (added during (B)/(C)) but its dir is now removed.
    {
      try { fs.rmSync(WS1, { recursive: true, force: true }); } catch { /* */ }
      const r = await req('GET', '/workspaces');
      ok('(H) /workspaces ok after WS1 removed', r.status === 200 && r.body.ok === true);
      const entries = repoEntries(r.body);
      ok('(H) removed WS1 dir no longer in list', !entries.some((w) => w.path === WS1));
      ok('(H) WS2 still present after WS1 removed', entries.some((w) => w.path === WS2));
    }

  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS1, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS2, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
