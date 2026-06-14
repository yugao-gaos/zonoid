#!/usr/bin/env node
// Test for neighborhood-change-aware re-judgment (task /23).
// addEdge re-marks an anchor node via markEagerJudge when:
//   - the new edge is autowire (by:"autowire", judged:false)
//   - the anchor already has OTHER unjudged context edges
// Guard: promoted (judged:true) or hand-asserted edges must NOT re-mark.
'use strict';
const ov = require('../lib/overlay');

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log("PASS  " + label); pass++; } else { console.log("FAIL  " + label); fail++; } }

function overlayWithCandidate(nodeKey, otherKey) {
  const o = ov.EMPTY();
  o.epoch = 5;
  ov.addEdge(o, nodeKey, otherKey, null, "context", 0, { by: "autowire", judged: false, score: 0.8 });
  delete o.eagerJudge[nodeKey];
  delete o.eagerJudge[otherKey];
  return o;
}

// === autowire edge to existing node re-marks anchor ====================================
{
  const o = overlayWithCandidate("task:A", "note:x");
  ov.addEdge(o, "note:n", "task:A", null, "context", 0, { by: "autowire", judged: false, score: 0.7 });
  ok("autowire edge to existing node re-marks anchor for eager re-judge", "task:A" in o.eagerJudge);
  ok("epoch stamp is current epoch", o.eagerJudge["task:A"] === 5);
}

// === both endpoints re-marked when both have other unjudged candidates ================
{
  const o = ov.EMPTY();
  o.epoch = 3;
  ov.addEdge(o, "note:n", "note:existing", null, "context", 0, { by: "autowire", judged: false, score: 0.6 });
  ov.addEdge(o, "task:B", "note:y", null, "context", 0, { by: "autowire", judged: false, score: 0.8 });
  delete o.eagerJudge["note:n"];
  delete o.eagerJudge["note:existing"];
  delete o.eagerJudge["task:B"];
  delete o.eagerJudge["note:y"];
  ov.addEdge(o, "note:n", "task:B", null, "context", 0, { by: "autowire", judged: false, score: 0.65 });
  ok("from endpoint re-marked when it has other unjudged candidates", "note:n" in o.eagerJudge);
  ok("to endpoint re-marked when it has other unjudged candidates", "task:B" in o.eagerJudge);
}

// === PROMOTED (judged:true) edge does NOT trigger re-mark ============================
{
  const o = overlayWithCandidate("task:C", "note:z");
  ov.addEdge(o, "note:m", "task:C", null, "context", 0.8, { by: "judge", judged: true, score: 0.8 });
  ok("promoted (judged:true) edge does NOT re-mark anchor", !("task:C" in o.eagerJudge));
}

// === hand-asserted edge does NOT trigger re-mark ======================================
{
  const o = overlayWithCandidate("task:D", "note:w");
  ov.addEdge(o, "note:p", "task:D", null, "context", 1.0, { origin: "asserted" });
  ok("hand-asserted edge does NOT re-mark anchor", !("task:D" in o.eagerJudge));
}

// === endpoint with NO other unjudged edges is NOT re-marked ==========================
{
  const o = overlayWithCandidate("task:E", "note:v");
  ov.addEdge(o, "note:fresh", "task:E", null, "context", 0, { by: "autowire", judged: false, score: 0.65 });
  ok("task:E (with other unjudged edges) IS re-marked", "task:E" in o.eagerJudge);
  ok("note:fresh (no other unjudged edges) is NOT re-marked", !("note:fresh" in o.eagerJudge));
}

// === duplicate edge (already exists) — no re-mark ====================================
{
  const o = overlayWithCandidate("task:F", "note:u");
  ov.addEdge(o, "note:q", "task:F", null, "context", 0, { by: "autowire", judged: false, score: 0.7 });
  ok("first add marks task:F", "task:F" in o.eagerJudge);
  delete o.eagerJudge["task:F"];
  ov.addEdge(o, "note:q", "task:F", null, "context", 0, { by: "autowire", judged: false, score: 0.7 });
  ok("duplicate (deduped) edge does NOT re-mark", !("task:F" in o.eagerJudge));
}

// === re-mark is idempotent: already-marked node gets epoch refreshed =================
{
  const o = overlayWithCandidate("task:G", "note:t");
  o.epoch = 10;
  ov.markEagerJudge(o, "task:G");
  o.epoch = 11;
  ov.addEdge(o, "note:r", "task:G", null, "context", 0, { by: "autowire", judged: false, score: 0.6 });
  ok("already-marked node gets epoch refreshed to current epoch", o.eagerJudge["task:G"] === 11);
}

console.log("-----");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
