#!/usr/bin/env node
'use strict';

const {
  DIMS,
  VECTOR_SCHEMA_VERSION,
  embedWithMeta,
  getEmbeddingProvider,
  embeddingMeta,
  listEmbeddingProviders,
  nodeVecs,
  validateEmbeddingConfig,
  vectorMatchesMeta,
} = require('../lib/embed');
const https = require('https');
const { planVectorInvalidation } = require('../lib/embedding-store');
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
const voyageMeta = embeddingMeta({ provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 }, { mode: 'document' });
const voyageQueryMeta = embeddingMeta({ provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 }, { mode: 'query' });
const voyageRetrievalQueryMeta = embeddingMeta({ provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 }, { mode: 'retrieval.query' });
const voyageRetrievalDocumentMeta = embeddingMeta({ provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 }, { mode: 'retrieval.document' });
const voyageImageMeta = embeddingMeta({ provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 }, { mode: 'document', modality: 'image' });
const voyageVec = Array.from({ length: 1024 }, (_, i) => i / 1024);
const cohereMeta = embeddingMeta({ provider: 'cohere', model: 'embed-v4.0', dimensions: 1536 }, { mode: 'document' });

function withMockHttps(response, fn) {
  const original = https.request;
  const calls = [];
  https.request = (opts, cb) => {
    const chunks = [];
    const req = {
      write: (data) => chunks.push(String(data)),
      end: () => {
        calls.push({ opts, body: chunks.join('') ? JSON.parse(chunks.join('')) : null });
        const res = new (require('events').EventEmitter)();
        res.statusCode = 200;
        cb(res);
        process.nextTick(() => {
          res.emit('data', JSON.stringify(response));
          res.emit('end');
        });
      },
      on: () => req,
      setTimeout: () => req,
    };
    return req;
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => { https.request = original; });
}

{
  const providers = listEmbeddingProviders();
  const ids = providers.map((p) => p.id);
  ok('MiniLM compatibility provider is present', ids.includes('minilm'));
  ok('OpenAI generic embedding provider is intentionally absent', !ids.includes('openai'));
  ok('Voyage hosted provider is present', ids.includes('voyage'));
  ok('Cohere hosted provider is present', ids.includes('cohere'));
  ok('Gemini hosted provider is present', ids.includes('gemini'));
  ok('Jina v5 omni provider family is present', ids.includes('jina-v5-omni'));
  ok('local instruct provider is present', ids.includes('local-instruct'));
}

{
  const local = listEmbeddingProviders().find((p) => p.id === 'local-instruct');
  ok('local provider declares query/document template support', local.supportsQueryDocumentMode === 'template');
  ok('local provider declares LoRA tuning support', local.tuningSupport === 'lora');
  ok('local provider only lists instruct-tunable models', local.supportedModels.some((m) => /qwen3|bge|e5|gemma/i.test(m.id)));
  ok('text-only local provider does not pass multimodal provider gate', local.capabilityGate.providerSwapEligible === false);
}

{
  const voyage = listEmbeddingProviders().find((p) => p.id === 'voyage');
  const cohere = listEmbeddingProviders().find((p) => p.id === 'cohere');
  const gemini = listEmbeddingProviders().find((p) => p.id === 'gemini');
  const jina = listEmbeddingProviders().find((p) => p.id === 'jina-v5-omni');
  ok('Voyage declares multimodal input_type capability gate', voyage.capabilityGate.providerSwapEligible === true && voyage.modalities.includes('image') && voyage.modeSignal === 'input_type');
  ok('Cohere declares embed-v4 multimodal input_type capability gate', cohere.capabilityGate.providerSwapEligible === true && cohere.modalities.includes('image') && cohere.customizationLevel === 'hosted_tuned_model');
  ok('Gemini text endpoint is not marked multimodal provider-swap eligible', gemini.capabilityGate.providerSwapEligible === false && gemini.capabilityGate.adapterMustVerifyModality === true && !gemini.modalities.includes('image'));
  ok('Jina v5 omni declares disabled local multimodal runtime gap', jina.capabilityGate.providerSwapEligible === false && jina.capabilityGate.adapterPending === true && jina.capabilityGate.runtimeUnsupported === true && jina.modalities.includes('audio'));
  ok('eligible providers expose cost and cache hints', [voyage, cohere, gemini, jina].every((p) => p.costHints && p.cacheHints && p.maxInput));
}

{
  const minilm = listEmbeddingProviders().find((p) => p.id === 'minilm');
  ok('MiniLM is marked legacy fallback only', minilm.capabilityGate.legacyFallbackOnly === true && minilm.capabilityGate.providerSwapEligible === false);
}

{
  const bad = validateEmbeddingConfig({ provider: 'openai', model: 'text-embedding-3-small' });
  ok('generic OpenAI embeddings are rejected by registry validation', bad.ok === false);
  const good = validateEmbeddingConfig({ provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 });
  ok('Voyage instruct provider validates', good.ok === true && good.config.provider === 'voyage');
  const badModality = validateEmbeddingConfig({ provider: 'gemini', model: 'gemini-embedding-001', modality: 'image' });
  ok('text-only Gemini adapter rejects image modality validation', badModality.ok === false);
}

{
  const ov = overlayStore.EMPTY();
  const meta = embeddingMeta(ov);
  ok('default embedding identity is MiniLM document text v1', meta.provider === 'minilm' && meta.dimensions === DIMS && meta.task_mode === 'document' && meta.modality === 'text' && meta.vector_schema_version === VECTOR_SCHEMA_VERSION);
  ok('retrieval mode aliases normalize into query/document identity', voyageRetrievalQueryMeta.task_mode === 'query' && voyageRetrievalDocumentMeta.task_mode === 'document' && voyageRetrievalQueryMeta.identity === voyageQueryMeta.identity && voyageRetrievalDocumentMeta.identity === voyageMeta.identity);
  ok('legacy MiniLM vector is accepted under MiniLM default', nodeVecs({ vec: minilmVec }, { expectedMeta: meta }).length === 1);
  ok('legacy MiniLM vector is rejected under hosted provider identity', nodeVecs({ vec: minilmVec }, { expectedMeta: voyageMeta }).length === 0);
  ok('matching hosted metadata is accepted', nodeVecs({ vec: voyageVec, vecMeta: voyageMeta }, { expectedMeta: voyageMeta }).length === 1);
  ok('mismatched hosted metadata is rejected', nodeVecs({ vec: voyageVec, vecMeta: cohereMeta }, { expectedMeta: voyageMeta }).length === 0);
  ok('vectorMatchesMeta checks provider/model/dimensions/mode/modality', vectorMatchesMeta(voyageVec, voyageMeta, voyageMeta) && !vectorMatchesMeta(voyageVec, cohereMeta, voyageMeta) && !vectorMatchesMeta(voyageVec, voyageQueryMeta, voyageMeta) && !vectorMatchesMeta(voyageVec, voyageImageMeta, voyageMeta));
  ok('hosted identity string carries versioned vector fields', voyageMeta.identity.includes('vector_schema_version=1') && voyageMeta.identity.includes('task_mode=document') && voyageMeta.identity.includes('modality=text'));
  const tunedMeta = embeddingMeta({ provider: 'voyage', model: 'voyage-4-lite', dimensions: 1024, tuned_model_id: 'tenant-a' }, { mode: 'document' });
  const adapterMeta = embeddingMeta({ provider: 'jina-v5-omni', adapter: 'retrieval-v1', dimensions: 1024 }, { mode: 'document' });
  ok('tuned model id participates in vector identity', tunedMeta.tuned_model_id === 'tenant-a' && !vectorMatchesMeta(voyageVec, voyageMeta, tunedMeta));
  ok('adapter id participates in vector identity', adapterMeta.adapter === 'retrieval-v1' && adapterMeta.identity.includes('adapter=retrieval-v1'));
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
  ok('setTaskVec stores versioned metadata sidecar', ov.taskVecMeta['sess/1'][0].identity === voyageMeta.identity && ov.taskVecMeta['sess/1'][0].task_mode === 'document');
  overlayStore.setTaskVec(ov, 'sess/1', null);
  ok('setTaskVec(null) clears metadata sidecar', !ov.taskVecMeta['sess/1']);
}

{
  const ov = overlayStore.EMPTY();
  ov.status['sess/1'] = 'done';
  ov.note_nodes.fresh = { id: 'fresh', title: 'fresh', summary: '', vec: voyageVec, vecMeta: voyageMeta };
  ov.note_nodes.stale = { id: 'stale', title: 'stale', summary: '', vec: voyageVec, vecMeta: cohereMeta };
  overlayStore.setTaskVec(ov, 'sess/1', voyageVec, voyageMeta);
  overlayStore.setTaskVec(ov, 'sess/2', voyageVec, cohereMeta);
  ov.edges.push({ from: 'note:stale', to: 'sess/2', origin: 'autowire-semantic', kind: 'context' });
  ov.edges.push({ from: 'sess/1', to: 'sess/2', origin: 'manual', kind: 'blocking' });
  const beforeStatus = ov.status['sess/1'];
  const plan = planVectorInvalidation(ov, { expectedMeta: voyageMeta });
  ok('vector invalidation plan reports only stale dense vector layer', plan.denseVectors.total === 4 && plan.denseVectors.stale === 2 && plan.denseVectors.staleByLayer['note.vec'] === 1 && plan.denseVectors.staleByLayer.taskVecs === 1);
  ok('vector invalidation plan reports semantic derived artifacts separately', plan.semanticDerivedArtifacts.stale === 1 && plan.semanticDerivedArtifacts.refs[0].layer === 'edges.autowire-semantic');
  ok('vector invalidation plan does not mutate unrelated task state', ov.status['sess/1'] === beforeStatus && plan.unaffected.includes('dependencies'));
}

async function runAsyncTests() {
  {
    const oldKey = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const r = await embedWithMeta(
      { input: 'find provider config', mode: 'retrieval.query', provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 },
      {}
    );
    ok('embedWithMeta object request preserves query metadata when provider is unavailable', r.vec === null && r.meta.provider === 'voyage' && r.meta.task_mode === 'query');
    if (oldKey !== undefined) process.env.VOYAGE_API_KEY = oldKey;
  }

  {
    const voyage = getEmbeddingProvider('voyage');
    const oldKey = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = 'test-voyage-key';
    await withMockHttps({ data: [{ embedding: Array.from({ length: 1024 }, () => 0.25) }] }, async (calls) => {
      const vec = await voyage.embed(
        { imageUrl: 'https://example.test/image.png', text: 'diagram' },
        { provider: 'voyage', model: 'voyage-multimodal-3.5', dimensions: 1024 },
        { mode: 'document', modality: 'image' }
      );
      ok('Voyage multimodal adapter extracts hosted vector', Array.isArray(vec) && vec.length === 1024);
      ok('Voyage multimodal adapter sends image content and document input_type', calls[0].body.input_type === 'document' && Array.isArray(calls[0].body.input[0]) && calls[0].body.input[0].some((p) => p.type === 'image_url'));
    });
    if (oldKey === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = oldKey;
  }

  {
    const cohere = getEmbeddingProvider('cohere');
    const oldKey = process.env.COHERE_API_KEY;
    process.env.COHERE_API_KEY = 'test-cohere-key';
    await withMockHttps({ embeddings: { float: [Array.from({ length: 1536 }, () => 0.5)] } }, async (calls) => {
      const vec = await cohere.embed(
        'find similar screenshots',
        { provider: 'cohere', model: 'embed-v4.0', dimensions: 1536 },
        { mode: 'query', modality: 'text' }
      );
      ok('Cohere embed-v4 adapter extracts hosted vector', Array.isArray(vec) && vec.length === 1536);
      ok('Cohere embed-v4 adapter sends search_query text request', calls[0].body.input_type === 'search_query' && calls[0].body.texts[0] === 'find similar screenshots');
    });
    if (oldKey === undefined) delete process.env.COHERE_API_KEY;
    else process.env.COHERE_API_KEY = oldKey;
  }

  {
    const gemini = getEmbeddingProvider('gemini');
    const oldKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const vec = await gemini.embed(
      { imageUrl: 'https://example.test/image.png' },
      { provider: 'gemini', model: 'gemini-embedding-001', dimensions: 3072, modality: 'image' },
      { mode: 'document', modality: 'image' }
    );
    ok('Gemini adapter returns null for unverified image modality', vec === null);
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  }

  {
    const jina = getEmbeddingProvider('jina-v5-omni');
    const vec = await jina.embed(
      'find related screenshots',
      { provider: 'jina-v5-omni', model: 'jinaai/jina-embeddings-v5-omni-small-retrieval', dimensions: 1024 },
      { mode: 'query', modality: 'text' }
    );
    ok('Jina v5 omni local adapter fails soft while runtime is unsupported', vec === null);
    ok('Jina v5 omni provider reports unavailable runtime', jina.isAvailable() === false);
  }

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
