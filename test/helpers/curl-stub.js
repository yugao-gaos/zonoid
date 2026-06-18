'use strict';
// Shared test harness for the curl-stub hook tests (codex-hooks, classify-hook-*,
// cursor-classify-relay, cursor-e2e-integration, judge-hook-nudge).
//
// WHY THIS EXISTS — two cross-platform hazards bite these tests on Git-Bash/Windows:
//
//  (1) jq resolution. The shell hooks (hooks/classify.sh, adapters/codex/hooks/agent-done.sh,
//      adapters/cursor/classify.sh) call `jq`, and many run under `set -euo pipefail` so a missing
//      jq kills the hook (exit 127) BEFORE it ever shells out to the stub curl — the stub never
//      runs, its output file is never written, and the test crashes ENOENT reading that file.
//      On POSIX/CI jq lives in /usr/bin and is always resolvable. On Windows, jq is frequently
//      installed only as `jq.exe` in a dir (e.g. WinGet Links) that sits in Node's `process.env.PATH`
//      in *Windows* form (`C:\...`). When a test builds the spawned-bash PATH as
//      `stubDir + ':' + process.env.PATH`, MSYS2 does not reliably resolve `jq.exe` out of that
//      mixed Windows-form entry, so jq goes missing inside the hook. The fix: locate jq's dir from
//      process.env.PATH and prepend it in MSYS2-resolvable (POSIX, via `cygpath -u`) form.
//
//  (2) stub executability. `fs.writeFileSync(stub, body, {mode:0o755})` does not set the MSYS2
//      executable bit on Windows (Node reports mode 666). bash on Git-Bash usually still execs a
//      file with a `#!` shebang via PATH lookup, but to be robust against shell/mode quirks we also
//      run a real `chmod +x` through bash, and normalize line endings to LF so the shebang parses.
//
// Both fixes are no-ops on POSIX/CI (jq already on PATH; chmod is real there anyway), so the helper
// is portable. It deliberately does NOT touch the production hooks — they keep calling plain `curl`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

// --- jq directory detection (cached) ---------------------------------------------------------
let _jqDirPosix; // undefined = not computed; null = none found
function jqDirPosix() {
  if (_jqDirPosix !== undefined) return _jqDirPosix;
  _jqDirPosix = null;
  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    for (const name of ['jq', 'jq.exe']) {
      let found = false;
      try { found = fs.existsSync(path.join(dir, name)); } catch { found = false; }
      if (found) {
        _jqDirPosix = toPosixDir(dir);
        return _jqDirPosix;
      }
    }
  }
  return _jqDirPosix;
}

function toPosixDir(dir) {
  if (!IS_WIN) return dir;
  try {
    const c = spawnSync('cygpath', ['-u', dir], { encoding: 'utf8' });
    if (c.status === 0 && c.stdout) return c.stdout.trim();
  } catch { /* cygpath unavailable — fall back to raw dir */ }
  return dir;
}

// Build a PATH string for a spawned bash that guarantees `jq` resolves and puts the caller's
// stub/extra dirs first. `prefixDirs` are prepended (highest priority, e.g. the curl-stub dir),
// in the order given; the detected jq dir is inserted after them; then process.env.PATH.
function hookPath(...prefixDirs) {
  const parts = [];
  for (const d of prefixDirs) if (d) parts.push(d);
  const jq = jqDirPosix();
  if (jq) parts.push(jq);
  parts.push(process.env.PATH || '');
  return parts.join(':');
}

// Build a complete env for spawning a hook under bash: process.env + jq-resolvable PATH (with the
// given stub dirs first) + caller overrides. If the caller passes its own PATH in `extraEnv`, that
// wins verbatim (caller opted out of the helper's PATH handling).
function hookEnv(stubDirs, extraEnv = {}) {
  const dirs = Array.isArray(stubDirs) ? stubDirs : (stubDirs ? [stubDirs] : []);
  const env = { ...process.env, PATH: hookPath(...dirs), ...extraEnv };
  return env;
}

// --- curl stub writer ------------------------------------------------------------------------
// Write a stub `curl` (or any executable) into `dir` and make it genuinely executable on every
// platform. `body` is the script text; a `#!/bin/bash` shebang is prepended if absent. Returns the
// stub's full path. Line endings are normalized to LF so the shebang parses under MSYS2.
function writeCurlStub(dir, body, name = 'curl') {
  fs.mkdirSync(dir, { recursive: true });
  let script = String(body);
  if (!/^#!/.test(script)) script = '#!/bin/bash\n' + script;
  script = script.replace(/\r\n/g, '\n');
  const full = path.join(dir, name);
  fs.writeFileSync(full, script, { mode: 0o755 });
  makeExecutable(full);
  return full;
}

// Run a real chmod +x through bash so MSYS2 honors the executable bit (Node's mode:0o755 does not
// set it on Windows). No-op-safe on POSIX. Best-effort: failures are swallowed since the shebang
// PATH-exec path usually suffices anyway.
function makeExecutable(file) {
  try { fs.chmodSync(file, 0o755); } catch { /* */ }
  try {
    const posix = IS_WIN ? toPosixFile(file) : file;
    spawnSync('bash', ['-c', 'chmod +x "$1"', '--', posix], { encoding: 'utf8' });
  } catch { /* */ }
}

function toPosixFile(file) {
  if (!IS_WIN) return file;
  try {
    const c = spawnSync('cygpath', ['-u', file], { encoding: 'utf8' });
    if (c.status === 0 && c.stdout) return c.stdout.trim();
  } catch { /* */ }
  return file;
}

// Convenience: spawn a bash hook with the helper's env. Returns the spawnSync result.
function runHook(hookScript, input, { stubDirs = [], env = {} } = {}) {
  return spawnSync('bash', [hookScript], {
    input,
    encoding: 'utf8',
    env: hookEnv(stubDirs, env),
  });
}

module.exports = { writeCurlStub, makeExecutable, hookPath, hookEnv, jqDirPosix, runHook };
