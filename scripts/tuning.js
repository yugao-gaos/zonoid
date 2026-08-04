#!/usr/bin/env node
'use strict';
// CLI for the persisted daemon tuning knobs (lib/tuning.js).
//
// Writes <runtime dir>/tuning.json directly, so it works with the daemon stopped — the bootstrap
// case POST /config/tuning cannot serve. A RUNNING daemon picks the file up on its next pump
// (every knob re-resolves per use and the parse cache keys on mtime), so `set` needs no restart
// either; pass --reload to additionally poke the daemon so the change lands immediately.
//
// Usage:
//   node scripts/tuning.js get                        # effective values + which tier won
//   node scripts/tuning.js get --json                 # machine-readable describe() output
//   node scripts/tuning.js path                       # print the tuning file path
//   node scripts/tuning.js set drain_max_concurrency=6 spawn_timeout_ms=3600000
//   node scripts/tuning.js unset judge_budget         # revert a knob to env/default
//   node scripts/tuning.js reload                     # ask a running daemon to re-read the file
//
// Exits 0 on success, 1 on a usage/validation/write error.

const http = require('http');
const tuning = require('../lib/tuning');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'get';
const rest = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (f) => argv.includes(f);

const USAGE = [
  'Usage:',
  '  node scripts/tuning.js get [--json]',
  '  node scripts/tuning.js path',
  '  node scripts/tuning.js set <knob>=<value> [<knob>=<value> ...] [--reload]',
  '  node scripts/tuning.js unset <knob> [<knob> ...] [--reload]',
  '  node scripts/tuning.js reload',
  '',
  'Knobs:',
  ...tuning.KNOB_NAMES.map((n) => `  ${n.padEnd(24)} ${tuning.KNOBS[n].doc} [${tuning.KNOBS[n].env}]`),
].join('\n');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function printTable() {
  const d = tuning.describe();
  console.log(`file: ${d.file || '(none — set ORCH_TUNING_FILE)'}`);
  if (d.file_error) console.log(`file error: ${d.file_error}`);
  console.log(`restart required: ${d.restart_required.length ? d.restart_required.join(', ') : 'none'}`);
  console.log('');
  const width = Math.max(...tuning.KNOB_NAMES.map((n) => n.length));
  for (const name of tuning.KNOB_NAMES) {
    const k = d.knobs[name];
    console.log(`${name.padEnd(width)}  ${String(k.value).padStart(10)}  (${k.source})`);
  }
}

/**
 * Poke a running daemon so a file written here is reflected immediately rather than on its next
 * pump. Best-effort by design: no daemon (ECONNREFUSED) is the normal stopped-daemon case, and an
 * auth-gated daemon returns 401 — neither is a failure of the write that already succeeded.
 */
function reload() {
  const port = Number(process.env.ORCH_PORT) || 8787;
  return new Promise((resolve) => {
    const body = JSON.stringify({ set: {} }); // empty patch: re-reads + invalidates, changes nothing
    const req = http.request({
      host: '127.0.0.1', port, path: '/config/tuning', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(process.env.ORCH_TOKEN ? { Authorization: `Bearer ${process.env.ORCH_TOKEN}` } : {}),
      },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200
        ? 'daemon reloaded'
        : `daemon responded ${res.statusCode} (file is still picked up on the next pump)`);
    });
    req.on('error', (e) => resolve(`no daemon reached (${e.code || e.message}) — the file applies on next boot/pump`));
    req.end(body);
  });
}

async function main() {
  if (has('--help') || has('-h')) { console.log(USAGE); return; }

  if (cmd === 'path') {
    const p = tuning.filePath();
    if (!p) fail('no tuning file path resolved (set ORCH_TUNING_FILE)');
    console.log(p);
    return;
  }

  if (cmd === 'get') {
    if (has('--json')) console.log(JSON.stringify({ tuning: tuning.effective(), ...tuning.describe() }, null, 2));
    else printTable();
    return;
  }

  if (cmd === 'reload') {
    tuning.invalidate();
    console.log(await reload());
    return;
  }

  if (cmd === 'set' || cmd === 'unset') {
    if (!rest.length) fail(`${cmd} needs at least one knob\n\n${USAGE}`);
    const patch = {};
    for (const arg of rest) {
      if (cmd === 'unset') { patch[arg] = null; continue; }
      const eq = arg.indexOf('=');
      if (eq < 0) fail(`expected <knob>=<value>, got '${arg}'\n\n${USAGE}`);
      patch[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    const result = tuning.write(patch);
    if (!result.ok) fail(result.error);
    console.log(`wrote ${result.path}`);
    printTable();
    if (has('--reload')) console.log(await reload());
    return;
  }

  fail(`unknown command '${cmd}'\n\n${USAGE}`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
