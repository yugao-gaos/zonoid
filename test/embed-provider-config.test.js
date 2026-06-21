#!/usr/bin/env node
'use strict';

const {
  DIMS,
  embeddingMeta,
  listEmbeddingProviders,
  nodeVecs,
  validateEmbeddingConfig,
  vectorMatchesMeta,
} = require('../lib/embed');
const overlayStore = require('../lib/overlay');
const { scoreMatchesSemantic } = require('../daemon');
const { askGate } = require('../lib/ask-gate');
const { gateTask } = require('../lib/context-gate');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const minilmVec = Array.from({ length: DIMS }, (_, i) => i / DIMS);
const voyageMeta = { provider: 'voyage', model: 'voyage-4-lite', dimensions: 1024, identity: 'voyage:voyage-4-lite:1024' };
const voyageVec = Array.from({ length: 1024 }, (_, i) => i / 1024);
const cohereMeta = { provider: 'cohere', model: 'embed-v4.0', dimensions: 1536, identity: 'cohere:embed-v4.0:1536' };

{
  const providers = listEmbeddingProviders();
  const ids = providers.map((p) => p.id);
  ok('MiniLM compatibility provider is present', ids.includes('minilm'));
  ok('OpenAI generic embedding provider is intentionally absent', !ids.includes('openai'));
  ok('Voyage hosted provider is present', ids.includes('voyage'));
  ok('Cohere hosted provider is present', ids.includes('cohere'));
  ok('Gemini hosted provider is present', ids.includes('gemini'));
  ok('local instruct provider is present', ids.includes('local-instruct'));
}

{
  const local = listEmbeddingProviders().find((p) => p.id === 'local-instruct');
  ok('local provider declares query/document template support', local.supportsQueryDocumentMode === 'template');
  ok('local provider declares LoRA tuning support', local.tuningSupport === 'lora');
  ok('local provider only lists instruct-tunable models', local.supportedModels.some((m) => /qwen3|bge|e5|gemma/i.test(m.id)));
}

{
  const bad = validateEmbeddingConfig({ provider: 'openai', model: 'text-embedding-3-small' });
  ok('generic OpenAI embeddings are rejected by registry validation', bad.ok === false);
  const good = validateEmbeddingConfig({ provider: 'voyage', model: 'voyage-4-lite', dimensions: 1024 });
  ok('Voyage instruct provider validates', good.ok === true && good.config.provider === 'voyage');
}

{
  const ov = overlayStore.EMPTY();
  const meta = embeddingMeta(ov);
  ok('default embedding identity is MiniLM', meta.provider === 'minilm' && meta.dimensions === DIMS);
  ok('legacy MiniLM vector is accepted under MiniLM default', nodeVecs({ vec: minilmVec }, { expectedMeta: meta }).length === 1);
  ok('legacy MiniLM vector is rejected under hosted provider identity', nodeVecs({ vec: minilmVec }, { expectedMeta: voyageMeta }).length === 0);
  ok('matching hosted metadata is accepted', nodeVecs({ vec: voyageVec, vecMeta: voyageMeta }, { expectedMeta: voyageMeta }).length === 1);
  ok('mismatched hosted metadata is rejected', nodeVecs({ vec: voyageVec, vecMeta: cohereMeta }, { expectedMeta: voyageMeta }).length === 0);
  ok('vectorMatchesMeta checks provider/model/dimensions', vectorMatchesMeta(voyageVec, voyageMeta, voyageMeta) && !vectorMatchesMeta(voyageVec, cohereMeta, voyageMeta));
}

{
  const item = { _vec: voyageVec, _vecMeta: voyageMeta };
  ok('knowledge item vector sidecar is accepted under hosted provider identity', nodeVecs({ vec: item._vec, vecMeta: item._vecMeta }, { expectedMeta: voyageMeta }).length === 1);
  ok('knowledge item vector without sidecar is rejected under hosted provider identity', nodeVecs({ vec: item._vec }, { expectedMeta: voyageMeta }).length === 0);
}

{
  const ov = overlayStore.EMPTY();
  overlayStore.setTaskVec(ov, 'sess/1', voyageVec, voyageMeta);
  ok('setTaskVec preserves raw vector array shape', Array.isArray(ov.taskVecs['sess/1']) && Array.isArray(ov.taskVecs['sess/1'][0]));
  ok('setTaskVec stores metadata sidecar', ov.taskVecMeta['sess/1'][0].identity === voyageMeta.identity);
  overlayStore.setTaskVec(ov, 'sess/1', null);
  ok('setTaskVec(null) clears metadata sidecar', !ov.taskVecMeta['sess/1']);
}

async function runAsyncTests() {
  {
    const target = { id: 'sess/query', label: 'alpha request', summary: '', deps: [], context_deps: [] };
    const matching = { id: 'note:matching', label: 'bravo corpus', summary: '', status: 'note', kind: 'note', vec: voyageVec, vecMeta: voyageMeta };
    const stale = { id: 'note:stale', label: 'charlie corpus', summary: '', status: 'note', kind: 'note', vec: voyageVec, vecMeta: cohereMeta };
    const g = { tasks: [matching, stale] };
    const hits = scoreMatchesSemantic(g, target, voyageVec, { expectedMeta: voyageMeta, targetVecMeta: voyageMeta });
    ok('non-default target meta enables semantic scoring', hits.some((h) => h.key === matching.id && h.via === 'semantic' && h.score > 0.99));
    ok('stale candidate metadata is filtered out of semantic scoring', !hits.some((h) => h.key === stale.id));
    const missingTargetMeta = scoreMatchesSemantic(g, target, voyageVec, { expectedMeta: voyageMeta });
    ok('non-default target without targetVecMeta is treated as stale', !missingTargetMeta.some((h) => h.via === 'semantic'));
  }

  {
    const embedQuery = async () => voyageVec;
    const cosine = () => 1;
    const missing = { id: 'note:missing-meta', label: 'missing meta', summary: 'SPEC IS INCOMPLETE: vector metadata was missing after provider switch.', vec: voyageVec };
    const stale = { id: 'note:stale-meta', label: 'stale meta', summary: 'SPEC IS INCOMPLETE: vector metadata came from an old provider.', vec: voyageVec, vecMeta: cohereMeta };
    const gateMissing = await gateTask({ label: 'provider switch', summary: 'check vector identity' }, [missing], { embedQuery, cosine, expectedMeta: voyageMeta });
    ok('context gate missing hosted vec metadata does not use raw semantic fallback', gateMissing.via === 'lexical' && gateMissing.top1 === 0);
    const gateStale = await gateTask({ label: 'provider switch', summary: 'check vector identity' }, [stale], { embedQuery, cosine, expectedMeta: voyageMeta });
    ok('context gate stale hosted vec metadata does not use raw semantic fallback', gateStale.via === 'lexical' && gateStale.top1 === 0);
    const askMissing = await askGate('should missing provider metadata be trusted', [missing], { embedQuery, cosine, expectedMeta: voyageMeta });
    ok('ask gate missing hosted vec metadata does not use raw semantic fallback', askMissing.via === 'lexical' && askMissing.top1 === 0);
    const askStale = await askGate('should stale provider metadata be trusted', [stale], { embedQuery, cosine, expectedMeta: voyageMeta });
    ok('ask gate stale hosted vec metadata does not use raw semantic fallback', askStale.via === 'lexical' && askStale.top1 === 0);
  }
}

runAsyncTests().then(() => {
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
