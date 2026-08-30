#!/usr/bin/env node
// Runner for test/smoke.sh — resolves a REAL bash instead of letting the shell pick one.
//
// WHY THIS EXISTS — the package script used to be `bash test/smoke.sh`. npm runs scripts through
// cmd.exe on Windows (script-shell defaults to null -> ComSpec), and `where bash` there answers:
//
//     C:\Windows\System32\bash.exe                              <- the WSL relay
//     C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\bash.exe  <- the Store alias for the same
//
// Both are the WSL entrypoint, not a POSIX bash: with no distro installed the relay fails outright
// (`execvpe /bin/bash ENOENT`), and with one installed it would run smoke.sh INSIDE the distro,
// where the repo path, the temp dirs and `node` are not what the script expects. Git's real bash
// (Program Files\Git\usr\bin) is not on the machine PATH that cmd.exe sees, so `bash` never reaches
// it. The result: `npm run test:all` passed all 263 test files and then died on the smoke step,
// which is exactly the pre-push blocker this runner removes.
//
// The previous workaround was environmental — prepend Git's usr/bin to the user's PATH. That fixes
// one machine and silently breaks every fresh clone and CI runner, so the resolution now lives in
// the repo. test/helpers/bash.js is the single place that knows which bash is real (and, on require,
// puts its directory in front of PATH so smoke.sh's `mktemp`/`seq`/`curl` resolve to MSYS2 rather
// than to whatever System32 offers).
//
// No-op on POSIX/CI: bashExe() returns the bare name and PATH resolution is already correct there.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { bashExe } = require('../test/helpers/bash');   // requiring also fixes PATH (see above)

const script = path.join(__dirname, '..', 'test', 'smoke.sh');

const res = spawnSync(bashExe(), [script], { stdio: 'inherit', env: process.env });

if (res.error) {
  console.error(`smoke: failed to launch ${bashExe()}: ${res.error.message}`);
  process.exit(1);
}
// Signal death (e.g. the runner killed us) has no exit code — report it as a failure, never as 0.
process.exit(res.status === null ? 1 : res.status);
