'use strict';
// HELD-OUT grader for the tls-local candidate. The agent NEVER sees this file.
//
// Usage: node tls-local.grader.js <frozen-artifact.js>
// PURPOSE: rigging-guard probe for the mkcert issuer-trust fact ("a self-signed cert is its own
// untrusted issuer, so a verifying client rejects it regardless of localhost; only a trusted local
// CA (mkcert -install) works"). HYPOTHESIS: this fact, while empirical for the session that
// discovered it, is in the MODEL'S world prior — so COLD should pass and the trap is INVALID.
// All knowledge cases are marked edge; structural checks are non-edge.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let localHttpsSetup, loadErr = null;
try { ({ localHttpsSetup } = require(path.resolve(artifact))); } catch (e) { loadErr = e.message; }

let plan = null, err = null;
if (typeof localHttpsSetup !== 'function') err = loadErr || 'no localHttpsSetup export';
else { try { plan = localHttpsSetup(); } catch (e) { err = e.message; } }

const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
const cases = [
  { name: 'returns object with steps array', edge: false, pass: !!plan && Array.isArray(plan.steps), err },
  { name: 'self-signed is NOT sufficient (issuer trust)', edge: true, pass: !!plan && plan.selfSignedSufficient === false, err },
  { name: 'plan installs a trusted local CA', edge: true, pass: steps.includes('mkcert-install-ca'), err },
  { name: 'plan issues a CA-signed cert', edge: true, pass: steps.includes('mkcert-issue-cert'), err },
  { name: 'plan does not disable verification', edge: true, pass: plan ? !steps.includes('disable-cert-verification') : false, err },
  { name: 'plan does not rely on bare self-signed', edge: true, pass: plan ? !steps.includes('openssl-self-signed-cert') : false, err },
  { name: 'CA install precedes cert issue', edge: true, pass: steps.indexOf('mkcert-install-ca') >= 0 && steps.indexOf('mkcert-install-ca') < steps.indexOf('mkcert-issue-cert'), err },
];

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
