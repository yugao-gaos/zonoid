'use strict';
// Probes for OPTIONAL external tools a few suites shell out to (python3, git-filter-repo).
//
// These are not project dependencies — they are developer-machine tooling that CI images happen to
// carry. A suite that hard-fails when one is missing is reporting the machine, not the code, so the
// callers use these probes to SKIP the tool-dependent assertion (matching the existing
// "SKIP  <label> (<why>)" convention) while every assertion that does not need the tool still runs.
//
// The probes RUN the tool rather than checking PATH, because on Windows `python3` usually resolves
// to the Microsoft Store alias stub: it exists on PATH, exits 9009, and prints an install ad to
// stderr. A PATH-existence check would call that "available" and the suite would fail anyway.

const { spawnSync } = require('child_process');

function probe(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, ...opts });
    return !r.error && r.status === 0;
  } catch { return false; }
}

let _python;
// Name of a working Python 3 interpreter ('python3' / 'python' / 'py' / $PYTHON), or null if none runs.
//
// 'py' (the Windows Python launcher) is the last candidate: it is how a real CPython install is
// reachable on a Windows box whose bare `python3`/`python` are the Store alias stubs described above.
// It is probed bare rather than as `py -3` so the return stays a single command name for callers;
// the version_info check below is what actually rejects a non-3 interpreter, so the two are
// equivalent in outcome. On POSIX `py` simply ENOENTs and the probe reports false.
function pythonExe() {
  if (_python !== undefined) return _python;
  _python = null;
  const candidates = [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean);
  for (const c of candidates) {
    if (probe(c, ['-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'])) { _python = c; break; }
  }
  return _python;
}

let _filterRepo;
// True when `git filter-repo` (a separate install, not part of git) is callable.
function hasGitFilterRepo() {
  if (_filterRepo !== undefined) return _filterRepo;
  _filterRepo = probe('git', ['filter-repo', '--version']);
  return _filterRepo;
}

module.exports = { pythonExe, hasGitFilterRepo };
