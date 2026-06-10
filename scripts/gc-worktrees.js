#!/usr/bin/env node
'use strict';

// gc-worktrees.js — conservative worktree GC / retention sweep.
//
// Scans <repo>/worktrees/<bucket>/<slug>/ (incl. worktrees/self/<slug>/),
// classifies each worktree dir and each empty parent bucket dir, and either
// reports (DRY RUN, default) or — with --confirm — removes only the dirs that
// are provably safe to remove.
//
// Classes:
//   EMPTY          empty parent/bucket dir (no children)            -> GC (rmdir)
//   ACTIVE         registered in `git worktree list` AND mtime
//                  within the retention window                       -> SKIP
//   NEEDS-ATTENTION  uncommitted changes OR unmerged commits OR a
//                  git probe failed (un-extracted / unknown work)    -> KEEP, report loudly
//   GC-ELIGIBLE    clean AND fully merged into main AND not
//                  active/in-retention                               -> remove
//
// DRY RUN by default. --confirm executes GC for EMPTY + GC-ELIGIBLE only.
// Flags: --confirm, --retention-hours <n> (default 24), --repo <path>.
//
// Dependency-free. Node >= 16.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const opts = { confirm: false, retentionHours: 24, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') opts.confirm = true;
    else if (a === '--retention-hours') opts.retentionHours = Number(argv[++i]);
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  if (!Number.isFinite(opts.retentionHours) || opts.retentionHours < 0) {
    console.error('--retention-hours must be a non-negative number');
    process.exit(2);
  }
  return opts;
}

// ---- git helpers ---------------------------------------------------------
function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: r.status === 0 && !r.error,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error || null,
  };
}

// Parse `git worktree list --porcelain` into a map: absPath -> { branch, head }.
function registeredWorktrees(repo) {
  const out = git(repo, ['worktree', 'list', '--porcelain']);
  const map = new Map();
  if (!out.ok) return map;
  let cur = null;
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) map.set(cur.path, cur);
      cur = { path: fs.realpathSync.native ? safeReal(line.slice(9)) : line.slice(9), branch: null, head: null };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line === '' && cur) {
      map.set(cur.path, cur);
      cur = null;
    }
  }
  if (cur) map.set(cur.path, cur);
  return map;
}

function safeReal(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// ---- fs helpers ----------------------------------------------------------
function listDirs(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  return ents.filter((e) => e.isDirectory()).map((e) => e.name);
}

function isWorktree(dir) {
  // A real worktree has a .git file (or dir, but linked worktrees use a file).
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

function dirMtimeMs(dir) {
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

function isEmptyDir(dir) {
  try { return fs.readdirSync(dir).length === 0; } catch { return false; }
}

// ---- classification ------------------------------------------------------
function classifyWorktree(repo, wtDir, registered, retentionMs, now) {
  const real = safeReal(wtDir);
  const reg = registered.get(real) || registered.get(wtDir) || null;
  const isRegistered = !!reg;

  // branch: prefer the registered branch, fall back to the worktree's own HEAD.
  let branch = reg && reg.branch ? reg.branch : null;
  if (!branch) {
    const sr = git(wtDir, ['symbolic-ref', '--short', 'HEAD']);
    branch = sr.ok ? sr.stdout : null;
  }

  const reasons = [];
  let probeFailed = false;

  // uncommitted?
  const status = git(wtDir, ['status', '--porcelain']);
  if (!status.ok) {
    probeFailed = true;
    reasons.push('git status failed');
  }
  const dirty = status.ok && status.stdout.length > 0;
  if (dirty) {
    const n = status.stdout.split('\n').length;
    reasons.push(`${n} uncommitted change(s)`);
  }

  // unmerged commits? Use the worktree's own HEAD against main — robust even
  // when the branch ref isn't visible from the main repo.
  let unmerged = null;
  const rl = git(wtDir, ['rev-list', '--count', 'main..HEAD']);
  if (rl.ok && /^\d+$/.test(rl.stdout)) {
    unmerged = Number(rl.stdout);
    if (unmerged > 0) reasons.push(`${unmerged} unmerged commit(s)`);
  } else {
    probeFailed = true;
    reasons.push('rev-list main..HEAD failed');
  }

  const mtime = dirMtimeMs(wtDir);
  const ageMs = now - mtime;
  const inRetention = ageMs <= retentionMs;

  let cls;
  if (probeFailed || dirty || (unmerged != null && unmerged > 0)) {
    cls = 'NEEDS-ATTENTION';
  } else if (isRegistered && inRetention) {
    cls = 'ACTIVE';
    reasons.push(`active: registered, mtime ${(ageMs / 3600000).toFixed(1)}h < retention`);
  } else {
    cls = 'GC-ELIGIBLE';
    reasons.push('clean + fully merged into main, not active');
  }

  return {
    dir: wtDir,
    real,
    branch,
    registered: isRegistered,
    dirty,
    unmerged,
    ageHours: ageMs / 3600000,
    cls,
    reason: reasons.join('; ') || '—',
  };
}

// ---- GC actions ----------------------------------------------------------
function gcWorktree(repo, item, confirm) {
  // Remove the worktree, then delete its branch (best-effort).
  if (!confirm) return { done: false, note: 'dry-run' };
  // Dirty-worktree guard: classification happened earlier in the scan; a worktree can acquire
  // uncommitted work in the interim. Re-probe IMMEDIATELY before the destructive remove and refuse
  // to reap anything with uncommitted changes (or whose probe fails) — `worktree remove --force`
  // would otherwise silently discard that work. Makes "never reap uncommitted work" airtight.
  const recheck = git(item.dir, ['status', '--porcelain']);
  if (!recheck.ok) {
    return { done: false, note: `SKIPPED — status re-probe failed (${recheck.stderr || recheck.code}); not reaping` };
  }
  if (recheck.stdout.length > 0) {
    const n = recheck.stdout.split('\n').length;
    return { done: false, note: `SKIPPED — ${n} uncommitted change(s) appeared since scan; not reaping` };
  }
  const notes = [];
  const rm = git(repo, ['worktree', 'remove', '--force', item.dir]);
  if (rm.ok) notes.push('worktree removed');
  else {
    notes.push(`worktree remove failed (${rm.stderr || rm.code}); attempting rmdir`);
    try { fs.rmSync(item.dir, { recursive: true, force: true }); notes.push('dir removed'); }
    catch (e) { notes.push(`rmdir failed: ${e.message}`); }
  }
  if (item.branch) {
    const bd = git(repo, ['branch', '-D', item.branch]);
    notes.push(bd.ok ? `branch ${item.branch} deleted` : `branch delete skipped (${bd.stderr || bd.code})`);
  }
  return { done: true, note: notes.join('; ') };
}

function gcEmpty(dir, confirm) {
  if (!confirm) return { done: false, note: 'dry-run' };
  try { fs.rmdirSync(dir); return { done: true, note: 'rmdir' }; }
  catch (e) { return { done: true, note: `rmdir failed: ${e.message}` }; }
}

// ---- report --------------------------------------------------------------
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function printTable(rows) {
  const c1 = Math.max(9, ...rows.map((r) => r.col1.length));
  const c2 = Math.max(5, ...rows.map((r) => r.col2.length));
  const line = `${pad('worktree', c1)}  ${pad('class', c2)}  reason`;
  console.log(line);
  console.log('-'.repeat(line.length));
  for (const r of rows) {
    console.log(`${pad(r.col1, c1)}  ${pad(r.col2, c2)}  ${r.col3}`);
  }
}

// ---- main ----------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: gc-worktrees.js [--confirm] [--retention-hours <n>] [--repo <path>]');
    process.exit(0);
  }

  // Resolve repo root.
  let repo = opts.repo || process.cwd();
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (top.ok) repo = top.stdout;
  const worktreesRoot = path.join(repo, 'worktrees');

  console.log(`gc-worktrees: ${opts.confirm ? 'CONFIRM (will modify)' : 'DRY RUN (no changes)'}`);
  console.log(`repo:          ${repo}`);
  console.log(`worktrees:     ${worktreesRoot}`);
  console.log(`retention:     ${opts.retentionHours}h`);
  console.log('');

  if (!fs.existsSync(worktreesRoot)) {
    console.log('No worktrees/ directory — nothing to do.');
    process.exit(0);
  }

  const registered = registeredWorktrees(repo);
  const retentionMs = opts.retentionHours * 3600000;
  const now = Date.now();

  const items = [];       // worktree classifications
  const emptyDirs = [];   // empty parent/bucket dirs

  for (const bucket of listDirs(worktreesRoot)) {
    const bucketDir = path.join(worktreesRoot, bucket);
    const slugs = listDirs(bucketDir);

    if (slugs.length === 0 && isEmptyDir(bucketDir)) {
      emptyDirs.push(bucketDir);
      continue;
    }

    for (const slug of slugs) {
      const slugDir = path.join(bucketDir, slug);
      if (isWorktree(slugDir)) {
        items.push(classifyWorktree(repo, slugDir, registered, retentionMs, now));
      } else if (isEmptyDir(slugDir)) {
        emptyDirs.push(slugDir);
      } else {
        // Non-worktree, non-empty dir: keep, report as needs-attention (unknown).
        items.push({
          dir: slugDir, real: safeReal(slugDir), branch: null, registered: false,
          dirty: false, unmerged: null, ageHours: (now - dirMtimeMs(slugDir)) / 3600000,
          cls: 'NEEDS-ATTENTION', reason: 'non-empty dir without .git (unknown contents)',
        });
      }
    }

    // After possibly consuming slugs, re-check the bucket: still non-empty?
    // (We do not rmdir buckets that still hold worktrees; only truly empty ones.)
    if (isEmptyDir(bucketDir)) emptyDirs.push(bucketDir);
  }

  // ---- DRY-RUN / report table ----
  const rel = (p) => path.relative(repo, p) || p;
  const rows = [];
  for (const it of items) {
    rows.push({ col1: rel(it.dir), col2: it.cls, col3: it.reason });
  }
  for (const d of emptyDirs) {
    rows.push({ col1: rel(d), col2: 'EMPTY', col3: 'empty dir -> rmdir' });
  }
  rows.sort((a, b) => a.col1.localeCompare(b.col1));
  printTable(rows);

  // ---- counts ----
  const counts = { EMPTY: emptyDirs.length, ACTIVE: 0, 'NEEDS-ATTENTION': 0, 'GC-ELIGIBLE': 0 };
  for (const it of items) counts[it.cls] = (counts[it.cls] || 0) + 1;
  console.log('');
  console.log('counts:');
  for (const k of ['EMPTY', 'ACTIVE', 'NEEDS-ATTENTION', 'GC-ELIGIBLE']) {
    console.log(`  ${pad(k, 16)} ${counts[k] || 0}`);
  }

  // ---- needs-attention, loud ----
  const attn = items.filter((it) => it.cls === 'NEEDS-ATTENTION');
  if (attn.length) {
    console.log('');
    console.log('!!! NEEDS-ATTENTION — NOT touched (holds un-extracted work) !!!');
    for (const it of attn) {
      console.log(`  * ${rel(it.dir)}  [${it.branch || '?'}]  ${it.reason}`);
    }
  }

  // ---- execute GC (confirm only) ----
  const toGc = items.filter((it) => it.cls === 'GC-ELIGIBLE');
  console.log('');
  if (!opts.confirm) {
    console.log(`DRY RUN — would GC ${emptyDirs.length} empty dir(s) + ${toGc.length} eligible worktree(s). Re-run with --confirm to execute.`);
    return;
  }

  console.log('CONFIRM — performing GC...');
  for (const d of emptyDirs) {
    const r = gcEmpty(d, true);
    console.log(`  [EMPTY]       ${rel(d)} — ${r.note}`);
  }
  for (const it of toGc) {
    const r = gcWorktree(repo, it, true);
    console.log(`  [GC-ELIGIBLE] ${rel(it.dir)} — ${r.note}`);
  }
  const prune = git(repo, ['worktree', 'prune']);
  console.log(`  git worktree prune — ${prune.ok ? 'ok' : 'failed: ' + (prune.stderr || prune.code)}`);
}

module.exports = { git, gcWorktree, gcEmpty, classifyWorktree, registeredWorktrees };

if (require.main === module) main();
