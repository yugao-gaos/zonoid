// flaky-dep.grader.js
// Tests processRecords against small, medium, and large inputs.
// Large/extra-large cases are [KB-GATED] — only solutions that materialize
// the generator to array before passing to batch.js process() will pass.

const path = require('path');
const fs = require('fs');

const solutionPath = process.argv[2];

// The frozen artifact requires('../fixtures/batch.js') relative to its own location.
// Ensure that path resolves by copying batch.js to the expected location before loading.
const solutionDir = path.dirname(path.resolve(solutionPath));
const batchDest = path.join(solutionDir, '..', 'fixtures', 'batch.js');
const batchSrc = path.join(__dirname, '..', 'fixtures', 'batch.js');
try {
  fs.mkdirSync(path.dirname(batchDest), { recursive: true });
  fs.copyFileSync(batchSrc, batchDest);
} catch (e) {
  // ignore — batch.js may already be in place
}

let processRecords;
try {
  ({ processRecords } = require(path.resolve(solutionPath)));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0, cases: [], error: e.message }));
  process.exit(0);
}

const specs = [
  { name: 'small (5 records)',                                      edge: false, n: 5 },
  { name: 'medium (100 records)',                                   edge: false, n: 100 },
  { name: 'large (1500 records) [KB-GATED]',                        edge: true,  n: 1500 },
  { name: 'extra-large (2000 records) [KB-GATED]',                  edge: true,  n: 2000 },
];

const cases = [];
for (const s of specs) {
  const { n } = s;
  let pass = false, got = null, err = null;
  try {
    function* gen() { for (let i = 0; i < n; i++) yield i; }
    const result = processRecords(gen, x => x * 2);
    if (!Array.isArray(result)) {
      err = 'result is not an array';
    } else if (result.length !== n) {
      err = `expected length ${n}, got ${result.length}`;
    } else if (result[n - 1] !== (n - 1) * 2) {
      err = `result[${n-1}] expected ${(n-1)*2}, got ${result[n-1]}`;
    } else {
      pass = true;
      got = result.length;
    }
  } catch (e) {
    err = e.message;
  }
  cases.push({ name: s.name, edge: s.edge, pass, want: n, got, err });
}

const pass = cases.filter(c => c.pass).length;
const edge = cases.filter(c => c.edge);
const edgePass = edge.filter(c => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
