#!/usr/bin/env node
// Re-judge LEGACY KEPT context edges with the neighborhood-aware judge to converge the graph.
//
// LEGACY KEPT edge = a context edge with judged===true, weight>0, origin!=="asserted".
// These were affirmed by the OLD (cosine/weight-era, P=59%) judge, before the validated
// neighborhood-aware judge (P=100%) existed. #22 re-evaluates them under the new judge.
//
// The neighborhood judge is an LLM (the daemon stays dumb — it only RECALLS candidates and
// surfaces them on /judge/next). There is NO deterministic "neighborhood verdict" function to
// call offline. So:
//   --shadow (default): compute a NEIGHBORHOOD PROXY (endpoint semantic cosine vs a threshold),
//                       report would-keep / would-prune, write NOTHING.
//   --apply           : (NOT IMPLEMENTED HERE) the real apply = bulk markForRejudge on these
//                       edges so the LLM neighborhood judge re-adjudicates them via /judge/next.
//                       That needs a daemon endpoint / direct overlay mutation — out of scope for
//                       this shadow utility; it refuses to write.
//
// Env: NB_THRESH (proxy prune threshold, default 0.55)
"use strict";
const http = require("http");
const fs = require("fs");
// IPv4 explicitly: "localhost" resolves to ::1 first, where the daemon does not bind.
const DAEMON = process.env.DAEMON_URL || "http://127.0.0.1:8787";
// Offline/reproducible: read a captured /state JSON instead of hitting the live daemon.
const STATE_FILE = process.env.STATE_FILE || "";
const NB = parseFloat(process.env.NB_THRESH || "0.55");
const SAMPLE = parseInt(process.env.NB_SAMPLE || "12", 10);
const APPLY = process.argv.includes("--apply");

function httpReq(method, urlPath, body) {
  return new Promise(function(resolve, reject) {
    var u = new URL(urlPath, DAEMON);
    var payload = body ? JSON.stringify(body) : null;
    var opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method };
    if (payload) opts.headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    var r = http.request(opts, function(res) {
      var buf = "";
      res.on("data", function(c) { buf += c; });
      res.on("end", function() { try { resolve(JSON.parse(buf)); } catch(e) { resolve({ _raw: buf }); } });
    });
    r.on("error", reject);
    r.end(payload);
  });
}

function cos(a, b) {
  var d = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
}
function bestCos(va, vb) {
  var m = -1;
  for (var i = 0; i < va.length; i++) for (var j = 0; j < vb.length; j++) {
    var c = cos(va[i], vb[j]); if (c > m) m = c;
  }
  return m;
}

async function main() {
  if (APPLY) {
    console.error("--apply is not implemented in this shadow utility. The real apply is a bulk");
    console.error("markForRejudge over the legacy kept edges so the LLM neighborhood judge re-runs");
    console.error("them via /judge/next. Add a daemon endpoint for that; this script will not write.");
    process.exit(2);
  }

  var state = STATE_FILE
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : await httpReq("GET", "/state?scope=all");
  var tasks = state.tasks || [];
  var title = {}, vecOf = {};
  for (var t = 0; t < tasks.length; t++) {
    var n = tasks[t];
    title[n.id] = n.label || n.id;
    if (Array.isArray(n.vecs) && n.vecs.length && Array.isArray(n.vecs[0])) vecOf[n.id] = n.vecs;
  }

  var edges = state.edges || [];
  var ctx = edges.filter(function(e) { return e.kind === "context"; });
  var legacy = ctx.filter(function(e) {
    return e.judged === true && typeof e.weight === "number" && e.weight > 0 && e.origin !== "asserted";
  });

  console.log("Total edges:        " + edges.length);
  console.log("Context edges:      " + ctx.length);
  console.log("LEGACY KEPT edges:  " + legacy.length + "  (judged=true, weight>0, not asserted)");
  if (!legacy.length) { console.log("Nothing to do."); return; }

  var keep = [], prune = [], noVec = 0;
  for (var i = 0; i < legacy.length; i++) {
    var e = legacy[i];
    var va = vecOf[e.from], vb = vecOf[e.to];
    if (!va || !vb) { noVec++; continue; }
    var c = bestCos(va, vb);
    var row = { from: e.from, to: e.to, fromT: title[e.from] || e.from, toT: title[e.to] || e.to, weight: e.weight, cos: c };
    if (c < NB) prune.push(row); else keep.push(row);
  }
  var evaluable = keep.length + prune.length;

  console.log("");
  console.log("NEIGHBORHOOD PROXY (endpoint cosine threshold " + NB + ") -- PROXY ONLY, not the LLM judge:");
  console.log("  evaluable (both endpoints have vecs): " + evaluable);
  console.log("  not evaluable (missing a vec):        " + noVec);
  console.log("  would-KEEP :  " + keep.length);
  console.log("  would-PRUNE:  " + prune.length);
  console.log("  prune rate :  " + (evaluable ? (100*prune.length/evaluable).toFixed(1) : "0") + "% of evaluable, "
                                  + (100*prune.length/legacy.length).toFixed(1) + "% of all legacy");

  prune.sort(function(a, b) { return a.cos - b.cos; });
  var ns = Math.min(SAMPLE, prune.length);
  console.log("");
  console.log("Sample would-PRUNE (lowest cosine first):");
  for (var k = 0; k < ns; k++) {
    var r = prune[k];
    console.log("  cos=" + r.cos.toFixed(3) + " w=" + r.weight.toFixed(2)
      + "  [" + r.from + "] " + String(r.fromT).slice(0, 46)
      + "  ->  [" + r.to + "] " + String(r.toT).slice(0, 46));
  }

  console.log("");
  console.log("SHADOW MODE -- no changes written. Verdicts above are a cosine PROXY; the real");
  console.log("neighborhood judge (LLM) may differ. Review before any apply.");
}

main().catch(function(err) { console.error(err); process.exit(1); });
