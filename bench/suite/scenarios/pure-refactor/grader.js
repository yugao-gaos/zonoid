'use strict';
// grader.js — pure-refactor scenario grader.
// Checks: (1) behavioral correctness vs reference, (2) >= 3 exported functions, (3) no fn > 20 lines.
// Usage: node grader.js <artifact-path>
// Returns JSON: { ok, pass, total }

const artifactPath = process.argv[2];
const fs = require('fs');

// Reference implementation (same logic as messyFunction, used for behavioral comparison).
function reference(s) {
  if (!s || typeof s !== 'string') return null;
  const result = { name: null, age: NaN, tags: [], active: false };
  for (const part of s.split(';')) {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) continue;
    const k = part.substring(0, colonIdx);
    const v = part.substring(colonIdx + 1);
    if (k === 'name') {
      result.name = v !== '' ? v : null;
    } else if (k === 'age') {
      result.age = v !== '' ? parseInt(v, 10) : NaN;
    } else if (k === 'tags') {
      result.tags = v.trim() !== '' ? v.split(',').map(t => t.trim()).filter(Boolean) : [];
    } else if (k === 'active') {
      result.active = v === 'true';
    }
  }
  return result;
}

let parseRecord;
let sourceText = '';
try {
  ({ parseRecord } = require(artifactPath));
  sourceText = fs.readFileSync(artifactPath, 'utf8');
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 10, error: 'require failed: ' + e.message }));
  process.exit(0);
}

let pass = 0;
const total = 10;

// --- Behavioral tests (8 points) ---
const behavioralCases = [
  { input: 'name:Alice;age:30;tags:a,b,c;active:true', desc: 'full valid record' },
  { input: 'name:Bob;age:25;tags:;active:false', desc: 'empty tags' },
  { input: 'name:Charlie;active:true', desc: 'missing age and tags' },
  { input: 'age:abc;tags:x , y;active:false', desc: 'invalid age and spaced tags' },
  { input: '', desc: 'empty string returns null' },
  { input: null, desc: 'null input returns null' },
  { input: 'name:;age:0;tags:only;active:true', desc: 'empty name value' },
  { input: 'unknown:field;name:Dave;age:5', desc: 'unknown keys ignored' },
];

function deepEqual(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') {
    if (typeof a === 'number' && isNaN(a) && isNaN(b)) return true;
    return a === b;
  }
  for (const k of Object.keys(b)) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

for (const tc of behavioralCases) {
  let actual, expected, ok = false;
  try {
    actual = parseRecord(tc.input);
    expected = reference(tc.input);
    ok = deepEqual(actual, expected);
  } catch (e) {
    ok = false;
  }
  if (ok) pass++;
}

// --- Structural checks (2 points) ---

// Check 1: at least 3 exported identifiers (main fn + 2 helpers)
let exportCount = 0;
try {
  const mod = require(artifactPath);
  exportCount = Object.keys(mod).length;
} catch {}
if (exportCount >= 3) pass++;

// Check 2: no function body longer than 20 lines
// Heuristic: scan for function declarations/expressions and measure body length.
function maxFunctionLines(src) {
  const lines = src.split('\n');
  let maxLines = 0;
  let depth = 0;
  let fnStart = -1;
  let fnDepth = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFnDecl = /\bfunction\b/.test(line) || /=>\s*\{/.test(line);

    for (const ch of line) {
      if (ch === '{') {
        depth++;
        if (isFnDecl && fnStart === -1) {
          fnStart = i;
          fnDepth = depth;
        }
      } else if (ch === '}') {
        if (fnStart !== -1 && depth === fnDepth) {
          const len = i - fnStart + 1;
          if (len > maxLines) maxLines = len;
          fnStart = -1;
          fnDepth = -1;
        }
        depth--;
      }
    }
  }
  return maxLines;
}

const maxLines = maxFunctionLines(sourceText);
if (maxLines <= 20) pass++;

const ok = pass === total;
console.log(JSON.stringify({ ok, pass, total, details: { exportCount, maxFunctionLines: maxLines } }));
