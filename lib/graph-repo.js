'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const githubAccount = require('./github-account');
const tuning = require('./tuning');

const queues = new Map();
const GRAPH_ATTRIBUTES = [
  '*.jsonl merge=union',
  'checkpoint.json merge=ours',
];
const TERMINAL_CLAIM_STATUSES = new Set(['done', 'tested', 'failed', 'canceled', 'released']);

function repoKey(repoRoot) {
  const absolute = path.resolve(repoRoot);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function serialize(repoRoot, fn) {
  const key = repoKey(repoRoot);
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(fn);
  const tail = result.catch(() => {});
  queues.set(key, tail);
  return result.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
}

function inspect(repoRoot) {
  const graphDir = path.join(path.resolve(repoRoot), '.graph');
  let stat;
  try {
    stat = fs.statSync(graphDir);
  } catch {
    return { kind: 'missing', graphDir };
  }
  if (!stat.isDirectory()) return { kind: 'missing', graphDir };
  try {
    const gitMarker = fs.statSync(path.join(graphDir, '.git'));
    if (gitMarker.isDirectory() || gitMarker.isFile()) return { kind: 'submodule', graphDir };
  } catch {}
  return { kind: 'ordinary', graphDir };
}

function detect(repoRoot) {
  return inspect(repoRoot).kind;
}

function runGit(cwd, args, scope = null) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...githubAccount.gitArgs(scope, args)], githubAccount.gitOptions(scope, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }), (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout || '').trim());
      error.stdout = String(stdout || '').trim();
      error.stderr = String(stderr || '').trim();
      reject(error);
    });
  });
}

async function gitResult(cwd, args, scope = null) {
  try {
    return { ok: true, stdout: await runGit(cwd, args, scope) };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorText(error) {
  return String((error && (error.stderr || error.message)) || error || 'git failed').trim();
}

async function configureGraphRepo(graphDir, options = {}) {
  // A fresh machine may have no global Git identity. Keep the fallback local to the graph repo.
  const name = await gitResult(graphDir, ['config', '--get', 'user.name']);
  if (!name.ok || !name.stdout) await runGit(graphDir, ['config', 'user.name', 'zonoid graph daemon']);
  const email = await gitResult(graphDir, ['config', '--get', 'user.email']);
  if (!email.ok || !email.stdout) await runGit(graphDir, ['config', 'user.email', 'zonoid@localhost']);
  await runGit(graphDir, ['config', 'merge.ours.driver', 'true']);

  if (options.writePolicy === false) return;
  const attributes = path.join(graphDir, '.gitattributes');
  let content = '';
  try { content = fs.readFileSync(attributes, 'utf8'); } catch {}
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  let changed = false;
  for (const entry of GRAPH_ATTRIBUTES) {
    if (!lines.has(entry)) { lines.add(entry); changed = true; }
  }
  if (changed || !fs.existsSync(attributes)) {
    fs.writeFileSync(attributes, `${Array.from(lines).join('\n')}\n`);
  }
}

async function currentCommit(graphDir) {
  const result = await gitResult(graphDir, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout : null;
}

async function remoteDefaultBranch(graphDir, scope = null) {
  const local = await gitResult(graphDir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (local.ok && local.stdout.startsWith('origin/')) return local.stdout.slice('origin/'.length);

  const remote = await gitResult(graphDir, ['ls-remote', '--symref', 'origin', 'HEAD'], scope);
  if (remote.ok) {
    const match = remote.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match) return match[1];
  }
  return 'main';
}

async function attachDetachedHead(graphDir, scope = null) {
  const head = await gitResult(graphDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.ok && head.stdout) return head.stdout;
  const branch = await remoteDefaultBranch(graphDir, scope);
  await runGit(graphDir, ['checkout', '-B', branch, 'HEAD']);
  return branch;
}

async function trackingRefExists(graphDir, branch) {
  return (await gitResult(graphDir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).ok;
}

async function fetchAndRebase(graphDir, branch, scope = null) {
  await runGit(graphDir, ['fetch', '--prune', 'origin'], scope);
  if (!(await trackingRefExists(graphDir, branch))) return;
  try {
    await runGit(graphDir, ['rebase', `refs/remotes/origin/${branch}`]);
  } catch (error) {
    await gitResult(graphDir, ['rebase', '--abort']);
    throw error;
  }
}

async function gitPath(graphDir, name) {
  const value = await runGit(graphDir, ['rev-parse', '--git-path', name]);
  return path.isAbsolute(value) ? value : path.resolve(graphDir, value);
}

async function interruptedRebaseState(graphDir) {
  for (const kind of ['rebase-merge', 'rebase-apply']) {
    const marker = await gitPath(graphDir, kind);
    if (fs.existsSync(marker)) return { active: true, kind, marker };
  }
  return { active: false, kind: null, marker: null };
}

async function unmergedEntries(graphDir) {
  const output = await runGit(graphDir, ['ls-files', '-u', '-z']);
  const byPath = new Map();
  for (const row of output.split('\0').filter(Boolean)) {
    const match = row.match(/^(\d+) ([0-9a-f]+) ([123])\t([\s\S]+)$/);
    if (!match) throw new Error(`cannot parse unmerged graph entry: ${row.slice(0, 200)}`);
    const [, mode, oid, stageText, file] = match;
    if (!byPath.has(file)) byPath.set(file, { path: file, entries: [] });
    byPath.get(file).entries.push({ mode, oid, stage: Number(stageText) });
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function conflictType(file) {
  if (/^claims\/[^/]+\.json$/.test(file)) return 'claim-json';
  if (/^nodes\/.+\.jsonl$/.test(file)) return 'jsonl-union';
  return 'unknown';
}

async function planInterruptedRebase(repoRoot) {
  const info = inspect(repoRoot);
  if (info.kind !== 'submodule') {
    return { status: 'refused', kind: info.kind, rebase: false, recoverable: false, conflicts: [], error: 'graph rebase recovery requires a .graph submodule' };
  }
  const state = await interruptedRebaseState(info.graphDir);
  if (!state.active) {
    return { status: 'not-needed', kind: info.kind, rebase: false, recoverable: true, conflicts: [] };
  }
  const conflicts = (await unmergedEntries(info.graphDir)).map((item) => ({
    path: item.path,
    type: conflictType(item.path),
    stages: item.entries.map((entry) => entry.stage).sort(),
  }));
  const unknown = conflicts.filter((item) => item.type === 'unknown').map((item) => item.path);
  return {
    status: 'plan',
    kind: info.kind,
    graphDir: info.graphDir,
    rebase: true,
    rebaseKind: state.kind,
    recoverable: unknown.length === 0,
    conflicts,
    unknown,
  };
}

async function stageText(graphDir, stage, file) {
  const result = await gitResult(graphDir, ['show', `:${stage}:${file}`]);
  return result.ok ? result.stdout : null;
}

function graphPath(graphDir, file) {
  const root = path.resolve(graphDir);
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe graph conflict path: ${file}`);
  }
  return target;
}

function jsonLines(source, label) {
  const lines = String(source == null ? '' : source).split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    if (!line || /^(?:<{7}|={7}|>{7}|\|{7})/.test(line)) continue;
    try { JSON.parse(line); } catch {
      throw new Error(`invalid JSONL line in ${label}`);
    }
    result.push(line);
  }
  return result;
}

async function resolveJsonlConflict(graphDir, file) {
  const sources = [];
  for (const stage of [2, 3]) {
    const value = await stageText(graphDir, stage, file);
    if (value != null) sources.push({ label: `stage ${stage} ${file}`, value });
  }
  const target = graphPath(graphDir, file);
  try { sources.push({ label: `worktree ${file}`, value: fs.readFileSync(target, 'utf8') }); } catch {}
  const seen = new Set();
  const lines = [];
  for (const source of sources) {
    for (const line of jsonLines(source.value, source.label)) {
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
  }
  if (!lines.length) throw new Error(`cannot recover empty JSONL conflict: ${file}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join('\n')}\n`);
}

function claimTimestamp(claim) {
  const values = ['completed_at', 'updated_at', 'claimed_at']
    .map((key) => Date.parse(claim && claim[key] || ''))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : Number.NEGATIVE_INFINITY;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function newerClaim(left, right) {
  const leftTerminal = TERMINAL_CLAIM_STATUSES.has(String(left.status || 'claimed')) ? 1 : 0;
  const rightTerminal = TERMINAL_CLAIM_STATUSES.has(String(right.status || 'claimed')) ? 1 : 0;
  if (leftTerminal !== rightTerminal) return leftTerminal > rightTerminal ? left : right;
  const leftTime = claimTimestamp(left);
  const rightTime = claimTimestamp(right);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return canonicalJson(left).localeCompare(canonicalJson(right)) >= 0 ? left : right;
}

async function resolveClaimConflict(graphDir, file) {
  const claims = [];
  for (const stage of [2, 3]) {
    const value = await stageText(graphDir, stage, file);
    if (value == null) continue;
    try { claims.push(JSON.parse(value)); } catch { throw new Error(`invalid claim JSON in stage ${stage}: ${file}`); }
  }
  const taskKeys = new Set(claims.map((claim) => claim && claim.task_key).filter(Boolean));
  if (!claims.length || taskKeys.size > 1) throw new Error(`incompatible claim JSON conflict: ${file}`);
  const selected = claims.reduce(newerClaim);
  const target = graphPath(graphDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(selected, null, 2)}\n`);
}

async function resolveKnownConflicts(graphDir, conflicts) {
  for (const conflict of conflicts) {
    if (conflict.type === 'claim-json') await resolveClaimConflict(graphDir, conflict.path);
    else if (conflict.type === 'jsonl-union') await resolveJsonlConflict(graphDir, conflict.path);
    else throw new Error(`unsupported graph rebase conflict: ${conflict.path}`);
    await runGit(graphDir, ['add', '--', conflict.path]);
  }
}

async function hasUnstagedChanges(graphDir) {
  const tracked = await gitResult(graphDir, ['diff', '--quiet', '--exit-code']);
  if (!tracked.ok) return true;
  return (await runGit(graphDir, ['ls-files', '--others', '--exclude-standard', '-z'])).length > 0;
}

async function stashUnstagedChanges(graphDir) {
  if (!(await hasUnstagedChanges(graphDir))) return null;
  const before = await gitResult(graphDir, ['rev-parse', '--verify', 'refs/stash']);
  const message = `zonoid graph rebase recovery ${new Date().toISOString()}`;
  await runGit(graphDir, ['stash', 'push', '--include-untracked', '--keep-index', '-m', message, '--', '.']);
  const after = await gitResult(graphDir, ['rev-parse', '--verify', 'refs/stash']);
  if (!after.ok || (before.ok && before.stdout === after.stdout)) throw new Error('failed to preserve unstaged graph events in a stash');
  return { oid: after.stdout, ref: 'stash@{0}', message };
}

async function stashRefForOid(graphDir, oid) {
  const rows = await runGit(graphDir, ['stash', 'list', '--format=%gd%x09%H']);
  const match = rows.split('\n').map((row) => row.split('\t')).find(([, hash]) => hash === oid);
  return match ? match[0] : null;
}

async function recoveryFailure(graphDir, error, steps, stash) {
  const state = await interruptedRebaseState(graphDir);
  let conflicts = [];
  try { conflicts = (await unmergedEntries(graphDir)).map((item) => item.path); } catch {}
  return {
    status: 'failed',
    rebase: state.active,
    recoverable: true,
    steps,
    stash,
    conflicts,
    error: errorText(error),
    next_steps: stash
      ? [`Inspect ${stash.ref} (${stash.oid}) before retrying; it contains the preserved unstaged graph events.`]
      : ['Inspect the interrupted rebase before retrying; no recovery stash was created.'],
  };
}

async function recoverInterruptedRebase(repoRoot, options = {}) {
  return serialize(repoRoot, async () => {
    const initial = await planInterruptedRebase(repoRoot);
    if (!initial.rebase) return initial;
    if (options.dryRun !== false) return { ...initial, status: 'dry-run', dryRun: true };
    if (options.drainsPaused !== true) {
      return { ...initial, status: 'refused', error: 'graph rebase recovery requires explicit confirmation that drains are paused' };
    }
    const pause = tuning.describe(options.env || process.env);
    const maxIterations = pause.knobs && pause.knobs.drain_max_iterations;
    if (!maxIterations || maxIterations.value !== -1 || maxIterations.file_value !== -1) {
      return {
        ...initial,
        status: 'refused',
        error: 'graph rebase recovery requires persisted drain_max_iterations=-1 with an effective value of -1',
        drain_pause: maxIterations || null,
      };
    }
    if (!initial.recoverable) {
      return { ...initial, status: 'refused', error: `unsupported graph rebase conflicts: ${initial.unknown.join(', ')}` };
    }

    const graphDir = initial.graphDir;
    let stash = null;
    let steps = 0;
    try {
      let plan = initial;
      if (plan.conflicts.length) {
        await resolveKnownConflicts(graphDir, plan.conflicts);
        steps++;
      }
      stash = await stashUnstagedChanges(graphDir);
      if (typeof options.failHook === 'function') await options.failHook('after-stash', { graphDir, stash });

      for (let attempt = 0; attempt < 100; attempt++) {
        const continued = await gitResult(graphDir, ['-c', 'core.editor=true', 'rebase', '--continue']);
        const state = await interruptedRebaseState(graphDir);
        if (!state.active) {
          if (!continued.ok) throw continued.error;
          break;
        }
        const conflicts = await unmergedEntries(graphDir);
        if (!conflicts.length) {
          throw continued.ok ? new Error('rebase remains active without conflicts') : continued.error;
        }
        plan = await planInterruptedRebase(repoRoot);
        if (!plan.recoverable) throw new Error(`unsupported graph rebase conflicts: ${plan.unknown.join(', ')}`);
        await resolveKnownConflicts(graphDir, plan.conflicts);
        steps++;
      }
      if ((await interruptedRebaseState(graphDir)).active) throw new Error('graph rebase recovery exceeded 100 steps');

      let stashRetained = false;
      let warning = null;
      if (stash) {
        const applied = await gitResult(graphDir, ['stash', 'apply', stash.oid]);
        if (!applied.ok) throw applied.error;
        const ref = await stashRefForOid(graphDir, stash.oid);
        if (ref) {
          const dropped = await gitResult(graphDir, ['stash', 'drop', ref]);
          if (!dropped.ok) {
            stashRetained = true;
            warning = `restored graph events but could not drop ${ref}`;
          }
        }
      }
      return {
        status: 'recovered',
        kind: initial.kind,
        rebase: false,
        recoverable: true,
        steps,
        stash: stash ? { ...stash, retained: stashRetained } : null,
        warning,
      };
    } catch (error) {
      return recoveryFailure(graphDir, error, steps, stash);
    }
  });
}

function skipped(kind) {
  return { status: 'skipped', kind, commit: null };
}

async function flushSubmodule(info, options) {
  const graphDir = info.graphDir;
  const message = options.message || 'zonoid: persist graph state';
  const shouldPush = options.push !== false;
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 2;
  let branch = null;
  let scope = null;

  try {
    branch = await attachDetachedHead(graphDir);
    await configureGraphRepo(graphDir);
    // daemon.port is written into the mounted graph directory for discovery but is machine-local
    // runtime state, never durable graph history.
    await runGit(graphDir, ['add', '-A', '--', '.', ':(exclude)daemon.port']);
    const staged = await gitResult(graphDir, ['diff', '--cached', '--quiet', '--exit-code']);
    if (!staged.ok) await runGit(graphDir, ['commit', '-m', message]);
  } catch (error) {
    return { status: 'error', kind: info.kind, branch, commit: await currentCommit(graphDir), error: errorText(error) };
  }

  let commit = await currentCommit(graphDir);
  if (!shouldPush) return { status: 'pending', kind: info.kind, branch, commit, error: null };

  try {
    const remote = await runGit(graphDir, ['remote', 'get-url', 'origin']);
    scope = await githubAccount.scopeForRemote(remote, options.githubAccount);
  } catch (error) {
    return { status: 'pending', kind: info.kind, branch, commit, attempts: 0, error: errorText(error) };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fetchAndRebase(graphDir, branch, scope);
      commit = await currentCommit(graphDir);
      await runGit(graphDir, ['push', 'origin', `HEAD:refs/heads/${branch}`], scope);
      return { status: 'pushed', kind: info.kind, branch, commit, attempts: attempt + 1, error: null };
    } catch (error) {
      commit = await currentCommit(graphDir);
      if (attempt === retries) {
        return { status: 'pending', kind: info.kind, branch, commit, attempts: attempt + 1, error: errorText(error) };
      }
    }
  }

  return { status: 'pending', kind: info.kind, branch, commit, attempts: retries + 1, error: 'push retries exhausted' };
}

function flush(repoRoot, options = {}) {
  return serialize(repoRoot, async () => {
    const info = inspect(repoRoot);
    if (info.kind !== 'submodule') return skipped(info.kind);
    return flushSubmodule(info, options);
  });
}

function sync(repoRoot, options = {}) {
  return serialize(repoRoot, async () => {
    const info = inspect(repoRoot);
    if (info.kind !== 'submodule') return skipped(info.kind);
    const graphDir = info.graphDir;
    let branch = null;
    try {
      let scope = null;
      if (options.latest !== false) {
        const remote = await runGit(graphDir, ['remote', 'get-url', 'origin']);
        scope = await githubAccount.scopeForRemote(remote, options.githubAccount);
      }
      branch = await attachDetachedHead(graphDir, scope);
      await configureGraphRepo(graphDir, { writePolicy: false });
      if (options.latest !== false) await fetchAndRebase(graphDir, branch, scope);
      return { status: 'synced', kind: info.kind, branch, commit: await currentCommit(graphDir), error: null };
    } catch (error) {
      return { status: 'pending', kind: info.kind, branch, commit: await currentCommit(graphDir), error: errorText(error) };
    }
  });
}

function ensureRemoteCommit(repoRoot, commit) {
  return serialize(repoRoot, async () => {
    const info = inspect(repoRoot);
    if (info.kind !== 'submodule' || !commit) return false;
    try {
      const graphDir = info.graphDir;
      const remote = await runGit(graphDir, ['remote', 'get-url', 'origin']);
      const scope = await githubAccount.scopeForRemote(remote);
      await runGit(graphDir, ['fetch', '--prune', 'origin'], scope);
      const heads = await runGit(graphDir, ['ls-remote', '--heads', 'origin'], scope);
      const commits = heads
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean);
      for (const head of commits) {
        if ((await gitResult(graphDir, ['merge-base', '--is-ancestor', commit, head])).ok) return true;
      }
    } catch {}
    return false;
  });
}

module.exports = {
  detect,
  flush,
  sync,
  ensureRemoteCommit,
  serialize,
  configureGraphRepo,
  planInterruptedRebase,
  recoverInterruptedRebase,
  GRAPH_ATTRIBUTES,
};
