'use strict';
// Cross-platform IPC endpoint for the embedding/rerank sidecars.
//
// macOS/Linux: a Unix domain socket file under the orchestrator data dir (e.g. ~/.claude/orchestrator/embed.sock).
// Windows: `net.Server.listen(<path>)` treats a string path as a NAMED PIPE and only accepts names in
//   the `\\.\pipe\` namespace — a filesystem path like `...\embed.sock` throws `EACCES`. So on Windows
//   we use a pipe name instead. It's salted with a hash of the data dir so two users / orchestrator
//   instances on one host don't collide on a global pipe name.
//
// Both the servers (server.listen(SOCKET_PATH)) and clients (http.request({ socketPath: SOCKET_PATH }))
// accept a named-pipe path on Windows with no other changes — the transport is identical.
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');

function ipcPath(name) {
  if (process.platform === 'win32') {
    const salt = crypto.createHash('sha1').update(BASE).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\zonoid-${name}-${salt}`;
  }
  return path.join(BASE, `${name}.sock`);
}

module.exports = { ipcPath, BASE };
