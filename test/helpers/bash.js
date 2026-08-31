'use strict';
// Shared bash/sh resolver for tests that shell out via spawnSync.
//
// WHY THIS EXISTS — on Windows, plain `spawnSync('bash', ...)` resolves through the child's PATH and
// lands on one of three very different executables, only one of which behaves like the POSIX bash
// these tests assume:
//
//   * C:\WINDOWS\system32\bash.exe        — the WSL relay. Ships with Windows and sits early on the
//     system PATH, so it SHADOWS Git bash for Node's spawnSync. It runs the command inside the WSL
//     distro (or fails outright when none is installed), where the test's Windows paths, stub dirs
//     and temp files simply do not exist.
//   * C:\Program Files\Git\bin\bash.exe   — a shim, not bash. It PREPENDS /mingw64/bin:/usr/bin to
//     whatever PATH it is handed, which defeats the stub-dir-first PATH trick these tests rely on:
//     a real `curl`/`jq` from /usr/bin wins over the test's stub and the stub never runs.
//   * C:\Program Files\Git\usr\bin\bash.exe — the REAL MSYS2 bash. It honors the PATH it is given
//     verbatim, so a stub dir placed first actually takes effect.
//
// So: prefer the real usr/bin bash when it exists, else fall back to whatever PATH gives us (correct
// on POSIX/CI, where `bash` is already the real thing and this whole module is a pass-through).

const fs = require('fs');

const IS_WIN = process.platform === 'win32';

// Explicit real-bash locations, in preference order. usr/bin FIRST — see the header: Git\bin\bash.exe
// is a PATH-rewriting shim and System32\bash.exe is the WSL relay; neither is usable here.
const WIN_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
];

let _bash; // undefined = not resolved yet

// Absolute path to a usable bash, or the bare name 'bash' to let PATH resolve it.
function bashExe() {
  if (_bash !== undefined) return _bash;
  _bash = 'bash';
  if (IS_WIN) {
    for (const c of WIN_BASH_CANDIDATES) {
      try {
        if (fs.existsSync(c)) { _bash = c; break; }
      } catch { /* keep looking */ }
    }
  }
  return _bash;
}

// `sh` resolves to the same MSYS2 layout on Windows; on POSIX keep the real /bin/sh semantics.
let _sh;
function shExe() {
  if (_sh !== undefined) return _sh;
  _sh = 'sh';
  if (IS_WIN) {
    for (const c of WIN_BASH_CANDIDATES) {
      const sh = c.replace(/bash\.exe$/, 'sh.exe');
      try {
        if (fs.existsSync(sh)) { _sh = sh; break; }
      } catch { /* keep looking */ }
    }
    if (_sh === 'sh') _sh = bashExe();
  }
  return _sh;
}

// Directory holding the resolved bash (POSIX coreutils live alongside it: chmod, cygpath, ...).
// null when bash came from PATH rather than an explicit location.
function bashBinDir() {
  const exe = bashExe();
  if (exe === 'bash') return null;
  return exe.replace(/[\\/][^\\/]+$/, '');
}

// Put the resolved bash's own directory at the FRONT of this process's PATH, ONCE, at require time.
//
// This is the flip side of preferring usr/bin/bash.exe. That binary honors the PATH it is handed
// VERBATIM — which is exactly why the stub-dir-first tests need it — but it therefore does NOT
// inherit MSYS2's coreutils the way Git\bin\bash.exe does (that shim silently prepends /usr/bin,
// the same behavior that defeats the stub trick). Two things break without this, neither related to
// the code under test:
//   * hooks/orch-gate.sh calls `dirname`, gets "command not found", resolves HOOK_DIR to the empty
//     string, and execs the wrong file.
//   * a hook that re-enters bash (adapters/cursor/classify.sh pipes into `bash hooks/classify.sh`)
//     resolves that inner `bash` from the child PATH. C:\WINDOWS\system32 is on every Windows PATH
//     and ships a bash.exe — the WSL relay — so the nested shell runs in the WSL distro, where the
//     test's temp dirs and stub curl do not exist. It exits 0 having done nothing.
//
// PREPENDED to process.env.PATH — the INHERITED system PATH, which never contains a test's stub
// dir. Helpers that install stubs (curl-stub.hookEnv/hookPath) build their PATH as
// `stubDirs + jqDir + process.env.PATH`, so stubs still sit ahead of everything here and keep
// shadowing the real `curl`/`jq`; this only decides MSYS2-vs-System32 for tools no stub provides.
// Idempotent, and skipped on POSIX (bash and coreutils are already on PATH there), so requiring
// this module twice — or on Linux/macOS — changes nothing.
function ensureBashToolsOnPath() {
  if (!IS_WIN) return;
  const dir = bashBinDir();
  if (!dir) return;
  const sep = ';';
  const current = process.env.PATH || '';
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  const entries = current.split(sep).filter(Boolean);
  if (entries.length && norm(entries[0]) === norm(dir)) return;   // already in front
  process.env.PATH = [dir, ...entries.filter((p) => norm(p) !== norm(dir))].join(sep);
}
ensureBashToolsOnPath();

module.exports = { bashExe, shExe, bashBinDir, ensureBashToolsOnPath, IS_WIN };
