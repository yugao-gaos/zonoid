#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
let passed = 0;
let failed = 0;

function ok(name, condition) {
  if (condition) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('not ok - ' + name); }
}

ok('viewer query is presentation-only Codex, Claude, or neutral context',
  html.includes("const VIEWER_KIND = VIEWER_HOST === 'codex' ? 'codex' : VIEWER_HOST === 'claude' ? 'claude' : 'neutral'")
  && html.includes('all recorded providers included'));

ok('settings wording follows viewer without changing usage accounting',
  html.includes('This Codex view does not change which providers are included in usage totals.')
  && html.includes('This Claude view does not change which providers are included in usage totals.')
  && !html.includes('Claude is the default.'));

const adviceGuard = html.indexOf("if(VIEWER_KIND!=='claude')");
const anthropicAdvice = html.indexOf('Anthropic does not publish real-time quota limits.');
ok('Anthropic subscription advice is unreachable in Codex and neutral views',
  adviceGuard >= 0 && anthropicAdvice > adviceGuard
  && html.includes('Anthropic subscription advice is hidden in Codex.'));

ok('Claude subscription advice is suppressed for mixed provider ledgers',
  html.includes("billedModels.some(m=>!m.startsWith('claude-'))")
  && html.includes('this ledger includes non-Claude models'));

ok('cron cost consumes server pricing and never guesses provider rates in the browser',
  html.includes('function serverCronCost(entries)')
  && html.includes('entry.cost_usd')
  && html.includes('return null;')
  && !html.includes('cronRateFor')
  && !html.includes('rateForH')
  && !html.includes('[3,15,0.3]'));

ok('unpriced cron data remains explicit instead of being counted as zero',
  html.includes("fmtUSD(sessionCost)+' + unpriced cron'")
  && html.includes("cronCost!=null?fmtUSD(cronCost):'unpriced'"));

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
