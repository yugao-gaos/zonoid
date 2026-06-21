#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const REPO = path.resolve(__dirname, '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-onboard-doc-structure-')));

async function main() {
try {
  const target = path.join(TMP, 'target');
  const outDir = path.join(TMP, 'out');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'README.md'), [
    '# Architecture',
    '',
    'The miner must preserve document structure because distilled facts lose document progression.',
    '',
    '## Retrieval Expansion',
    '',
    'Source sections should stay connected to evidence chunks because retrieval later expands around sibling facts.',
    '',
  ].join('\n'));

  const mined = spawnSync(process.execPath, [
    path.join(REPO, 'scripts', 'onboard-mine-docs.js'),
    '--repo', target,
    '--out', outDir,
  ], { encoding: 'utf8' });
  ok('doc miner exits successfully', mined.status === 0);

  const notes = JSON.parse(fs.readFileSync(path.join(outDir, 'doc-notes.json'), 'utf8'));
  const structure = JSON.parse(fs.readFileSync(path.join(outDir, 'doc-structure.json'), 'utf8'));
  const docs = structure.nodes.filter((n) => n.type === 'source_doc');
  const sections = structure.nodes.filter((n) => n.type === 'source_section');
  const chunks = structure.nodes.filter((n) => n.type === 'source_chunk');
  ok('distilled doc notes still emit', notes.length >= 1);
  ok('source_doc emits for markdown document', docs.length === 1 && docs[0].source_path === 'README.md');
  ok('source_section emits for headings', sections.length === 2);
  ok('source_chunk emits evidence chunks', chunks.length >= 2);
  ok('section records doc parent provenance', sections.every((n) => n.metadata && n.metadata.parent_key === docs[0].key));
  ok('chunk records section parent provenance', chunks.every((n) => n.metadata && sections.some((s) => s.key === n.metadata.parent_key)));
  ok('doc to section context edges emit', sections.every((s) => structure.edges.some((e) => e.from === docs[0].key && e.to === s.key && e.kind === 'context')));
  ok('section to chunk context edges emit', chunks.every((c) => structure.edges.some((e) => e.to === c.key && e.kind === 'context')));

  const { enrichLearnerResultWithEvidenceRefs, injectDocumentStructure, injectOnboardNotes } = require('../scripts/onboard-learn');
  const calls = [];
  const injected = await injectDocumentStructure(outDir, target, async (method, urlPath, body) => {
    calls.push({ method, urlPath, body });
    return { ok: true };
  });
  const firstEdge = calls.findIndex((c) => c.urlPath === '/overlay/edge');
  ok('inject upserts every document structure node', injected.nodes === structure.nodes.length);
  ok('inject wires every document structure edge', injected.edges === structure.edges.length);
  ok('inject creates nodes before edges', firstEdge === structure.nodes.length);
  ok('inject targets requested workspace', calls.every((c) => c.body.workspace === target));
  ok('inject uses typed knowledge-node endpoint', calls.slice(0, structure.nodes.length).every((c) => c.method === 'POST' && c.urlPath === '/overlay/knowledge-node'));
  ok('inject uses context edge endpoint for provenance', calls.slice(structure.nodes.length).every((c) => c.method === 'POST' && c.urlPath === '/overlay/edge' && c.body.kind === 'context'));

  const learnerResult = {
    kept: [{
      title: 'Preserve document progression',
      summary: 'Distilled facts lose document progression unless source chunks stay connected.',
      evidence: 'README.md:3',
      kind: 'invariant',
      source: '0',
    }],
    rejected: [],
  };
  const enriched = enrichLearnerResultWithEvidenceRefs(learnerResult, [{ source: 'README.md', summary: notes[0].summary }], outDir);
  ok('learner output records evidence refs', Array.isArray(enriched.kept[0].evidence_refs) && enriched.kept[0].evidence_refs.some((ref) => ref.startsWith('knowledge:source_')));

  const notesFile = path.join(outDir, 'onboard-notes.json');
  fs.writeFileSync(notesFile, JSON.stringify(enriched, null, 2));
  const noteCalls = [];
  await injectOnboardNotes(notesFile, true, target, async (method, urlPath, body) => {
    noteCalls.push({ method, urlPath, body });
    if (urlPath === '/overlay/note') return { ok: true, key: 'note:distilled-fact' };
    return { ok: true };
  });
  const noteCreate = noteCalls.find((c) => c.urlPath === '/overlay/note');
  const evidenceEdge = noteCalls.find((c) => c.urlPath === '/overlay/edge' && c.body.to === 'note:distilled-fact');
  ok('distilled note carries evidence ref knowledge', noteCreate && noteCreate.body.knowledge.some((k) => k.startsWith('evidence_ref:knowledge:source_')));
  ok('inject wires source evidence to distilled note', evidenceEdge && evidenceEdge.body.kind === 'context' && evidenceEdge.body.from.startsWith('knowledge:source_'));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
