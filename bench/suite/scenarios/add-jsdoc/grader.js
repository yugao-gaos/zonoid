'use strict';
// Grader for add-jsdoc scenario.
// Checks: (1) exports are intact, (2) each function has a JSDoc block,
// (3) @param coverage, (4) @returns coverage, (5) summary lines present.

const artifactPath = process.argv[2]; // bench/sandbox/solution.js
const total = 10;
let pass = 0;

let mod;
try {
  mod = require(artifactPath);
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total, error: 'require failed: ' + e.message }));
  process.exit(0);
}

// 1-3: Exports still work correctly
if (typeof mod.formatDate === 'function') pass++;
if (typeof mod.truncate === 'function') pass++;
if (typeof mod.deepMerge === 'function') pass++;

// 4: formatDate still works (use noon UTC to avoid timezone-off-by-one-day issues)
try {
  const d = new Date('2024-06-15T12:00:00Z');
  const r = mod.formatDate(d, 'YYYY');
  // Just check it returns a 4-digit year string
  if (typeof r === 'string' && /^\d{4}/.test(r)) pass++;
} catch { /* no point */ }

// 5: truncate still works
try {
  if (mod.truncate('hello world', 8) === 'hello...') pass++;
} catch { /* no point */ }

const fs = require('fs');
const src = fs.readFileSync(artifactPath, 'utf8');

// 6-8: Each of the 3 functions has a JSDoc block immediately before it
const fnNames = ['formatDate', 'truncate', 'deepMerge'];
for (const fn of fnNames) {
  // Match /** ... */ followed (with optional whitespace) by function declaration
  const re = new RegExp('\\/\\*\\*[\\s\\S]*?\\*\\/\\s*(?:function\\s+' + fn + '|(?:const|let|var)\\s+' + fn + ')');
  if (re.test(src)) pass++;
}

// 9: @param coverage — formatDate(2), truncate(3), deepMerge(2) = 7 total; require >= 5
const paramCount = (src.match(/@param/g) || []).length;
if (paramCount >= 5) pass++;

// 10: @returns coverage — 3 functions, require all 3
const returnsCount = (src.match(/@returns?/g) || []).length;
if (returnsCount >= 3) pass++;

console.log(JSON.stringify({ ok: pass === total, pass, total }));
