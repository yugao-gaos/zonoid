'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

function neutralGitEnv() {
  const env = { ...process.env };
  const names = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    env,
    encoding: 'utf8',
  }).split(/\s+/).filter(Boolean);
  for (const name of names) delete env[name];
  return env;
}

function git(repo, args, env) {
  return execFileSync('git', ['-C', repo, ...args], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

test('test runner removes hook-local Git repository variables from child tests', (t) => {
  const env = neutralGitEnv();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-run-tests-git-env-')));
  const source = path.join(root, 'source');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'test'), { recursive: true });
  fs.copyFileSync(path.join(PROJECT_ROOT, 'scripts', 'run-tests.js'), path.join(source, 'scripts', 'run-tests.js'));
  fs.writeFileSync(path.join(source, 'test', 'git-fixture.test.js'), `
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
assert.equal(process.env.CODEX_SESSION_ID, undefined);
assert.equal(process.env.CODEX_THREAD_ID, undefined);
assert.equal(process.env.ORCH_GATE_OFF, undefined);
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-git-fixture-')));
try {
  execFileSync('git', ['init', '-q'], { cwd: fixture });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: fixture });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: fixture });
  fs.writeFileSync(path.join(fixture, 'fixture.txt'), 'fixture\\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: fixture });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: fixture });
  assert.equal(fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: fixture, encoding: 'utf8',
  }).trim()), fixture);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
`);

  execFileSync('git', ['init', '-q', source], { env, windowsHide: true });
  git(source, ['config', 'user.name', 'Source'], env);
  git(source, ['config', 'user.email', 'source@example.test'], env);
  git(source, ['add', 'scripts/run-tests.js', 'test/git-fixture.test.js'], env);
  git(source, ['commit', '-q', '-m', 'seed'], env);

  const configBefore = fs.readFileSync(path.join(source, '.git', 'config'), 'utf8');
  const headBefore = git(source, ['rev-parse', 'HEAD'], env);
  const hookEnv = {
    ...env,
    GIT_DIR: path.join(source, '.git'),
    GIT_WORK_TREE: source,
    GIT_INDEX_FILE: path.join(source, '.git', 'index'),
    CODEX_SESSION_ID: 'host-session',
    CODEX_THREAD_ID: 'host-thread',
    ORCH_GATE_OFF: '1',
  };
  const result = spawnSync(process.execPath, [path.join(source, 'scripts', 'run-tests.js')], {
    cwd: source,
    env: hookEnv,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(source, '.git', 'config'), 'utf8'), configBefore);
  assert.equal(git(source, ['rev-parse', 'HEAD'], env), headBefore);
  assert.equal(git(source, ['status', '--short'], env), '');
});
