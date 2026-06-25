'use strict';
// Resolve lib/schedule-wakeup.js from monorepo layout or @zonoid/core install.
const fs = require('fs');
const path = require('path');

function load() {
  const candidates = [
    path.resolve(__dirname, '../../../lib/schedule-wakeup.js'),
    path.join(process.cwd(), 'node_modules/@zonoid/core/lib/schedule-wakeup.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('schedule-wakeup: zonoid lib not found — install @zonoid/core or symlink the repo');
}

module.exports = load();
