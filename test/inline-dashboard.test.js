#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'inline.html'), 'utf8');

function ok(name, pass) {
  if (!pass) {
    console.error('not ok - ' + name);
    process.exitCode = 1;
    return;
  }
  console.log('ok - ' + name);
}

ok('inline dashboard renders compact summary shell', html.includes('<main id="dash">'));
ok('inline dashboard exposes refresh action', html.includes('id="refreshBtn"') && html.includes('refreshBtn.onclick=refresh'));
ok('inline dashboard links to the full view in the Codex browser', html.includes('Open in Codex browser') && html.includes('dashboardUrl()'));
ok('inline dashboard does not render per-task node cards', !html.includes('className=\'node') && !html.includes('levelize('));
ok('inline dashboard still polls daemon state', html.includes("fetch(DAEMON + scoped('/state')"));
