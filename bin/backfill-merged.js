#!/usr/bin/env node
// One-shot, idempotent backfill: stamp merged:true + merge_sha + merged_at onto HISTORICAL done
// task nodes whose attempt branch (orch/attempt/<slugified-task-key>) landed on a repo's main —
// /git/merge only started persisting the stamp at commit dbe64bb, so every earlier merge reads as
// non-merged and /costflow misclassifies its cost as waste (the known 0/343 results gap).
//
// Evidence, per candidate repo (task repos from the overlay + the orchestrator repo + the workspace):
//   1. `git branch --merged main` entries matching orch/attempt/<slug>
//   2. merge-commit subjects on main: "orch: merge attempt <slug>" / "Merge branch 'orch/attempt/<slug>'"
//     (catches attempts whose branch was deleted after merging)
// CONSERVATIVE matching — a slug must map to exactly ONE overlay task key (slugify(key) === slug);
// ambiguous slugs (≥2 keys) or cross-repo sha conflicts are SKIPPED and reported, never guessed.
// Already-stamped keys are skipped, so re-running is a no-op (idempotent).
//
// Persistence: writes through lib/overlay.js (the daemon's own format, atomic temp+rename), then
// asks the LIVE daemon to reload the overlay (POST /workspace with the same path) so its in-memory
// copy can't clobber the stamps on its next save, and VERIFIES the stamps survived (retry ×3).
// Never restarts the daemon.
//
// Usage: node bin/backfill-merged.js [--dry-run] [--workspace <path>] [--repo <path>]...
//                                    [--port <daemon port>] [--no-reload]
// --workspace defaults to the repo containing the cwd (resolved via lib/workspace-registry repoRoot);
// candidate repos are drawn from the workspace registry (workspaces.json) rather than a global pointer.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const overlayStore = require('../lib/overlay');
const nt = require('../lib/native-tasks');
const mcpCore = require('../lib/mcp-core');
const wsRegistry = require('../lib/workspace-registry');
const runtimePaths = require('../lib/runtime-paths');

const INSTALL_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = runtimePaths.resolveDataDir();
const WORKSPACES_FILE = path.join(RUNTIME_DIR, 'workspaces.json');

// --- args ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const opts = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]] : []));
const DRY = flag('--dry-run');
const PORT = Number(opt('--port') || 8787);
const RELOAD = !flag('--no-reload');

// --- helpers ------------------------------------------------------------------------------------
// Same slug rule as lib/git.js branchName(): collapse anything outside [A-Za-z0-9._-] to '-'.
const slugify = (key) => String(key || '').replace(/[^A-Za-z0-9._-]/g, '-');
function git(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch { return null; }
}
const isRepo = (p) => !!p && fs.existsSync(p) && git(p, ['rev-parse', '--is-inside-work-tree']) === 'true';
const hasMain = (repo) => git(repo, ['rev-parse', '--verify', 'main']) != null;

// Collect merged-attempt evidence for one repo: Map slug -> { sha, at, via }.
function mergedAttempts(repo) {
  const out = new Map();
  // (a) merge-commit subjects on main, newest first — first (most recent) occurrence wins.
  const log = git(repo, ['log', 'main', '--format=%H%x09%cI%x09%s']) || '';
  for (const line of log.split('\n')) {
    const [sha, at, ...rest] = line.split('\t');
    const subj = rest.join('\t') || '';
    const m = subj.match(/^orch: merge attempt ([A-Za-z0-9._-]+)$/) || subj.match(/^Merge branch 'orch\/attempt\/([A-Za-z0-9._-]+)'/);
    if (m && !out.has(m[1])) out.set(m[1], { sha, at, via: 'merge-commit' });
  }
  // (b) branches still present and merged into main (covers ff-merges with no merge commit):
  // evidence sha = the branch tip (it IS an ancestor of main), at = that commit's date.
  const branches = git(repo, ['branch', '--format=%(refname:short)', '--merged', 'main']) || '';
  for (const b of branches.split('\n')) {
    const m = b.trim().match(/^orch\/attempt\/([A-Za-z0-9._-]+)$/);
    if (!m || out.has(m[1])) continue;
    const sha = git(repo, ['rev-parse', m[1]]);
    const at = sha ? git(repo, ['show', '-s', '--format=%cI', sha]) : null;
    if (sha && at) out.set(m[1], { sha, at, via: 'merged-branch' });
  }
  return out;
}

// Ask the live daemon to reload the overlay from disk (POST /workspace, same path). Best-effort.
function daemonReload(ws) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ path: ws });
    const token = mcpCore.readToken();
    const req = http.request(
      { host: 'localhost', port: PORT, path: '/workspace', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- main ---------------------------------------------------------------------------------------
(async () => {
  // Workspace = the repo whose overlay/tasks we backfill. The old single global pointer
  // (runtimeDir/'workspace') is gone (note:note-mqj0wcabtxh): take --workspace verbatim, else resolve
  // cwd -> its containing repo root via the registry's repoRoot.
  const ws = opt('--workspace') || wsRegistry.repoRoot(process.cwd());
  if (!ws) { console.error('no workspace (pass --workspace, or run from inside a repo)'); process.exit(1); }
  const ov = overlayStore.load(ws);

  // Done task keys (native 'completed' or an overlay 'done' override — overlay wins when present).
  const tasks = nt.aggregateWorkspace(ws, ov.snapshots);
  const doneKeys = tasks.filter((t) => {
    const eff = ov.status[t.key] || (t.native_status === 'completed' ? 'done' : t.native_status);
    return eff === 'done';
  }).map((t) => t.key);

  // slug -> [task keys]; ≥2 keys for one slug = ambiguous, skipped below.
  const slugToKeys = new Map();
  for (const k of doneKeys) {
    const s = slugify(k);
    if (!slugToKeys.has(s)) slugToKeys.set(s, []);
    slugToKeys.get(s).push(k);
  }
  // Label fallback for attempts branched under a descriptive key instead of the task key: a slug
  // may match a done task's LABEL — but only a UNIQUE exact or prefix match of the normalized
  // label ("tool-usage-analytics" ← "Tool-usage analytics: instrument …"). Anything looser is a guess.
  const normLabel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const doneByKey = new Map(tasks.filter((t) => doneKeys.includes(t.key)).map((t) => [t.key, t]));
  function labelMatches(slug) {
    return [...doneByKey.values()].filter((t) => { const n = normLabel(t.label); return n === slug || n.startsWith(slug + '-'); }).map((t) => t.key);
  }

  // Candidate repos: explicit --repo, else overlay task repos + every registered repo
  // (lib/workspace-registry allRepos) + the orchestrator repo + the workspace.
  const repoArgs = opts('--repo');
  const registeredRepos = (() => { try { return wsRegistry.allRepos(wsRegistry.loadRegistry(WORKSPACES_FILE)); } catch { return []; } })();
  const candidates = repoArgs.length
    ? repoArgs
    : [...new Set([...Object.values(ov.repos || {}), ...registeredRepos, INSTALL_ROOT, ws])];
  const repos = candidates.filter((r) => isRepo(r) && hasMain(r));
  if (!repos.length) { console.error('no candidate git repos with a main branch'); process.exit(1); }

  // Gather evidence across repos; a slug seen in ≥2 repos with DIFFERENT shas is ambiguous.
  const evidence = new Map(); // slug -> { sha, at, via, repo } | 'conflict'
  for (const repo of repos) {
    for (const [slug, ev] of mergedAttempts(repo)) {
      const prev = evidence.get(slug);
      if (!prev) evidence.set(slug, { ...ev, repo });
      else if (prev !== 'conflict' && prev.sha !== ev.sha) evidence.set(slug, 'conflict');
    }
  }

  const stamped = [], skipped = [];
  for (const [slug, ev] of evidence) {
    if (ev === 'conflict') { skipped.push({ slug, reason: 'cross-repo sha conflict' }); continue; }
    let keys = slugToKeys.get(slug) || [];
    let how = 'id';
    if (keys.length === 0) { keys = labelMatches(slug); how = 'label'; }
    if (keys.length === 0) {
      // attempt slug matching neither a done task key nor (uniquely) a done task label — never guess
      skipped.push({ slug, reason: 'no done task with this slug (id or label)' });
      continue;
    }
    if (keys.length > 1) { skipped.push({ slug, reason: `ambiguous: ${keys.length} ${how}-matched keys` }); continue; }
    const key = keys[0];
    if (ov.git[key] && ov.git[key].merged) { skipped.push({ slug, key, reason: 'already stamped' }); continue; }
    stamped.push({ key, slug, merge_sha: ev.sha, merged_at: ev.at, via: `${ev.via}/${how}-match`, repo: ev.repo });
  }

  console.log(`workspace: ${ws}`);
  console.log(`repos scanned: ${repos.join(', ')}`);
  console.log(`done tasks: ${doneKeys.length} · merged-attempt evidence: ${evidence.size}`);
  console.log(`\n--- to stamp: ${stamped.length} ---`);
  for (const s of stamped) console.log(`  ${s.key}  ←  ${s.merge_sha.slice(0, 8)} @ ${s.merged_at} (${s.via}, ${path.basename(s.repo)})`);
  console.log(`--- skipped: ${skipped.length} ---`);
  for (const s of skipped) console.log(`  ${s.key || s.slug}: ${s.reason}`);
  if (DRY || !stamped.length) { console.log(DRY ? '\ndry run — nothing written' : '\nnothing to stamp'); return; }

  // Write + daemon reload + verify, retrying: the live daemon saves its in-memory overlay on graph
  // activity, which can clobber a write that lands between our save and its reload.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fresh = overlayStore.load(ws);                  // re-read just before writing (narrow race window)
    for (const s of stamped) overlayStore.setGit(fresh, s.key, { merged: true, merge_sha: s.merge_sha, merged_at: s.merged_at, backfilled: true });
    overlayStore.save(ws, fresh);
    if (RELOAD) {
      const code = await daemonReload(ws);
      console.log(`\ndaemon reload (POST /workspace :${PORT}): ${code == null ? 'unreachable — stamps are on disk; reload/restart the daemon to pick them up' : `HTTP ${code}`}`);
    }
    await sleep(1500);
    const check = overlayStore.load(ws);
    const lost = stamped.filter((s) => !(check.git[s.key] && check.git[s.key].merged));
    if (!lost.length) { console.log(`verified: all ${stamped.length} stamps persisted (attempt ${attempt})`); return; }
    console.log(`attempt ${attempt}: ${lost.length} stamps clobbered by a concurrent daemon save — retrying`);
  }
  console.error('FAILED to persist stamps after 3 attempts — live daemon keeps overwriting; re-run when quieter');
  process.exit(1);
})();
