'use strict';
// Free-port allocation for tests that spawn a sandboxed daemon.
//
// WHY THIS EXISTS — the older convention is a random port inside a hand-picked range
// (`18840 + Math.floor(Math.random() * 100)`), with a comment asserting the range belongs to this
// suite alone. Both halves of that convention fail in practice:
//
//   * The ranges OVERLAP. test/endpoints.test.js owns 19550-19649, which entirely contains the
//     19560-19589 that agent-tool-spawn-register.test.js documents as exclusively its own.
//   * A random port is not a free port. A daemon leaked by an earlier run — a suite that was
//     interrupted, a test that failed before its `finally`, a killed runner — keeps LISTENING, and
//     nothing in the range check notices.
//
// The failure mode is silent and misattributed, which is the real cost. When the chosen port is
// already taken, the freshly spawned daemon cannot bind and dies, but `/ping` is answered by the
// STALE daemon still sitting there. waitForPing therefore SUCCEEDS ("daemon came up" passes), and
// every assertion after it fails against a daemon whose CLAUDE_PLUGIN_DATA points at some long
// deleted temp sandbox. The suite reports a pile of unrelated logic failures instead of "port busy".
//
// Asking the OS for port 0 removes the guesswork: the kernel hands back a port that is free right
// now, and the listener is closed immediately so the daemon can claim it. This is the pattern
// test/dispatcher-model.test.js already uses; this module just makes it shareable.
//
// Residual race: another process could grab the port between close() and the daemon's bind. That is
// unavoidable without passing a live socket to the child, and is vastly less likely than colliding
// with a leaked daemon that holds its port indefinitely.

const net = require('net');

// Resolve to a TCP port that is free on 127.0.0.1 at the moment of the call.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
