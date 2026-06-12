'use strict';
const fs = require('fs');
const path = require('path');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, PUBLIC } = ctx;

  if ((p === '/' || p === '/graph') && m === 'GET') {
    send(res, 200, fs.readFileSync(path.join(PUBLIC, 'graph.html'), 'utf8'), 'text/html; charset=utf-8');
    return true;
  }

  return false;
};
