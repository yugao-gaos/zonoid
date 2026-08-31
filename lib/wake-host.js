#!/usr/bin/env node
// Shared wake host: ONE detached process delivers EVERY pending wakeup in a registry.
//
// It replaces the old design where armWakeup() spawned one detached `node -e` sleeper PER wakeup.
// That put a live OS process behind every armed timer, and every way a fire could be lost (hard
// kill, crashed sleeper, a registry split across differing ORCH_WORKSPACE values so the daemon
// sweep never saw the row) leaked a process nothing could find again. 3,893 of them accumulated on
// one machine and exhausted the process table — system-wide EPERM uv_spawn failures.
//
// Here the process count is decoupled from the wakeup count: N pending wakeups cost ONE host.
//
//   argv: <registryPath> [hostPidPath]
//
// Each tick (immediately on start, then every ORCH_WAKE_HOST_TICK_MS, default 1000ms):
//   - exit if the host pidfile no longer names us — a newer host has taken over this registry;
//   - append the fire line for every hosted row whose fireAt has passed, then drop the row;
//   - exit once no hosted row has been pending for ORCH_WAKE_HOST_IDLE_MS (default 10s).
//
// Rows written by the OLD per-wakeup design (a `pid`, no `payload`/`fire`) are left strictly alone:
// they own a sleeper of their own, and the registry sweeps in lib/schedule-wakeup.js still reap
// them by pid.
'use strict';
const fs = require('fs');
const sw = require('./schedule-wakeup');

const registryPath = process.argv[2];
const hostPidPath = process.argv[3] || sw._hostPidPath(registryPath);

function envMs(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const TICK_MS = envMs('ORCH_WAKE_HOST_TICK_MS', 1000);
const IDLE_EXIT_MS = envMs('ORCH_WAKE_HOST_IDLE_MS', 10000);

// True only while THIS process is the registry's registered host. Ownership is the handover
// mechanism: a racing arm that spawned a second host overwrites the pidfile, and the loser stops
// on its next tick instead of two hosts double-firing the same rows.
function ownsPidFile() {
  try {
    return parseInt(fs.readFileSync(hostPidPath, 'utf8').trim(), 10) === process.pid;
  } catch (_) {
    return false;
  }
}

function countHosted(registry) {
  let n = 0;
  for (const entry of Object.values(registry)) if (sw._isHostedEntry(entry)) n++;
  return n;
}

let idleSince = Date.now();

function tick() {
  if (!ownsPidFile()) process.exit(0);

  // Fire + drop is a read-modify-write, and an arm in another process is one too. Running it
  // through the shared mutator serializes the pair: without the lock, whichever side published
  // second silently reverted the other — a fired row resurrected, or a fresh arm erased.
  let registry;
  try {
    registry = sw._mutateRegistry(registryPath, (reg) => {
      const now = Date.now();
      let changed = false;
      for (const [key, entry] of Object.entries(reg)) {
        if (!sw._isHostedEntry(entry)) continue;
        if (typeof entry.fireAt === 'number' && entry.fireAt > now) continue;
        try {
          fs.appendFileSync(entry.fire, `ORCH_SCHEDULED_TASK ${JSON.stringify(entry.payload)}\n`);
        } catch (_) {
          // The fire file is gone (session torn down). Drop the row anyway rather than retry it
          // every tick forever — an undeliverable wake must not become a permanently pending one.
        }
        delete reg[key];
        changed = true;
      }
      return { changed, registry: reg };
    }).registry;
  } catch (_) {
    // A tick that could not publish its deletions must not take the host down: the rows are still
    // pending and the next tick retries them. Fall back to an unmodified read for the idle check.
    registry = sw._readRegistry(registryPath);
  }

  const now = Date.now();
  if (countHosted(registry) > 0) {
    idleSince = now;
    return schedule();
  }
  if (now - idleSince < IDLE_EXIT_MS) return schedule();

  // Idle long enough to exit. Release ownership FIRST, then re-read: an arm that lands in the gap
  // sees no host and spawns a fresh one, and an arm that landed just before the read is still
  // ours to serve — so no wakeup is stranded by the handover either way.
  try { fs.unlinkSync(hostPidPath); } catch (_) {}
  if (countHosted(sw._readRegistry(registryPath)) > 0) {
    try { fs.writeFileSync(hostPidPath, String(process.pid)); } catch (_) {}
    idleSince = Date.now();
    return schedule();
  }
  process.exit(0);
}

function schedule() {
  setTimeout(tick, TICK_MS);
}

if (!registryPath) {
  process.stderr.write('wake-host: registry path argument required\n');
  process.exit(2);
}
tick();
