#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const configPath = process.argv[2];
const readyPath = process.argv[3];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function send(res, body) {
  const data = Buffer.from(JSON.stringify(body || {}));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function taskDetailFor(u) {
  const key = u.searchParams.get('key') || '';
  const details = config.taskDetails || {};
  return details[key] || config.defaultTaskDetail || { task: { metric: null, git: null } };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/ping') return send(res, { ok: true });
  if (u.pathname === '/active-claim') return send(res, config.activeClaim || { claimed: false });
  if (u.pathname === '/session-info') return send(res, config.sessionInfo || { is_subagent: true });
  if (u.pathname === '/dispatcher/children') return send(res, config.dispatcherChildren || { children: [] });
  if (u.pathname === '/task/detail') return send(res, taskDetailFor(u));
  if (u.pathname === '/usage/dispatcher-edit') {
    if (config.dispatcherEditMarker) {
      fs.mkdirSync(path.dirname(config.dispatcherEditMarker), { recursive: true });
      fs.writeFileSync(config.dispatcherEditMarker, '');
    }
    return send(res, { ok: true });
  }
  return send(res, {});
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(readyPath, JSON.stringify({ port: server.address().port }));
});
