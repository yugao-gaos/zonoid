'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_PROVIDER_ID = 'minilm';
const MINILM_MODEL = 'Xenova/all-MiniLM-L6-v2';
const MINILM_DIMS = 384;
const VECTOR_SCHEMA_VERSION = 1;

const PROVIDER_KINDS = {
  LOCAL: 'local',
  HOSTED: 'hosted',
};

const CUSTOMIZATION_LEVELS = {
  NONE: 'none',
  HOSTED_TUNED_MODEL: 'hosted_tuned_model',
  LOCAL_LORA_ADAPTER: 'local_lora_adapter',
  FULL_FINETUNE: 'full_finetune',
};

const TUNING_SUPPORT = {
  NONE: 'none',
  CUSTOM: 'custom',
  FINE_TUNE: 'fine-tune',
  LORA: 'lora',
};

const MODALITIES = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
};

const TASK_MODES = {
  QUERY: 'query',
  DOCUMENT: 'document',
};

const MODE_SIGNALS = {
  NONE: 'none',
  INPUT_TYPE: 'input_type',
  TASK_TYPE: 'task_type',
  TEMPLATE: 'template',
  ADAPTER: 'adapter',
};

const VECTOR_IDENTITY_FIELDS = [
  'vector_schema_version',
  'provider',
  'model',
  'dimensions',
  'task_mode',
  'modality',
  'adapter',
  'tuned_model_id',
];

const providerList = [
  {
    id: 'minilm',
    displayName: 'MiniLM sidecar',
    kind: PROVIDER_KINDS.LOCAL,
    defaultModel: MINILM_MODEL,
    defaultDimensions: MINILM_DIMS,
    dimensions: [MINILM_DIMS],
    modalities: [MODALITIES.TEXT],
    maxInput: { tokens: 256 },
    taskModes: [],
    modeSignal: MODE_SIGNALS.NONE,
    supportsQueryDocumentMode: false,
    supportsContextualChunks: false,
    supportsTaskType: false,
    tuningSupport: TUNING_SUPPORT.NONE,
    customizationLevel: CUSTOMIZATION_LEVELS.NONE,
    tuningNotes: 'Compatibility/default provider. It is intentionally kept even though it is not instruction-aware or tunable.',
    costHints: { hosted: false, metered: false, cacheRecommended: true },
    cacheHints: { cacheable: true, identityFields: VECTOR_IDENTITY_FIELDS },
    capabilityGate: {
      legacyFallbackOnly: true,
      providerSwapEligible: false,
      reason: 'MiniLM is text-only and lacks query/document retrieval semantics.',
    },
    supportedModels: [
      {
        id: MINILM_MODEL,
        dimensions: [MINILM_DIMS],
        defaultDimensions: MINILM_DIMS,
        supportsQueryDocumentMode: false,
        tuningSupport: TUNING_SUPPORT.NONE,
      },
    ],
    isAuthed: () => true,
    isAvailable: () => true,
  },
  {
    id: 'local-instruct',
    displayName: 'Local instruct embeddings',
    kind: PROVIDER_KINDS.LOCAL,
    defaultModel: 'qwen3-embedding:0.6b',
    defaultDimensions: 1024,
    dimensions: [768, 1024, 2048, 2560, 4096],
    modalities: [MODALITIES.TEXT],
    maxInput: { tokens: 8192 },
    taskModes: [TASK_MODES.QUERY, TASK_MODES.DOCUMENT],
    modeSignal: MODE_SIGNALS.TEMPLATE,
    supportsQueryDocumentMode: 'template',
    supportsContextualChunks: false,
    supportsTaskType: false,
    tuningSupport: TUNING_SUPPORT.LORA,
    customizationLevel: CUSTOMIZATION_LEVELS.LOCAL_LORA_ADAPTER,
    tuningNotes: 'Open instruct embedding families with query/document prompt templates and credible local fine-tune/LoRA paths. Generic local embedding models are deliberately excluded.',
    costHints: { hosted: false, metered: false, cacheRecommended: true },
    cacheHints: { cacheable: true, identityFields: VECTOR_IDENTITY_FIELDS },
    capabilityGate: {
      legacyFallbackOnly: false,
      providerSwapEligible: false,
      reason: 'Text-only local instruct families are useful experiments but do not satisfy the multimodal gate.',
    },
    env: {
      baseUrl: 'ZONOID_EMBED_LOCAL_BASE_URL or OLLAMA_HOST',
      apiStyle: 'ZONOID_EMBED_LOCAL_API_STYLE=ollama|openai',
      apiKey: 'ZONOID_EMBED_LOCAL_API_KEY for OpenAI-compatible endpoints',
    },
    supportedModels: [
      { id: 'qwen3-embedding:0.6b', defaultDimensions: 1024, dimensions: [1024], template: 'qwen3', tuningSupport: TUNING_SUPPORT.LORA },
      { id: 'qwen3-embedding:4b', defaultDimensions: 2560, dimensions: [2560], template: 'qwen3', tuningSupport: TUNING_SUPPORT.LORA },
      { id: 'qwen3-embedding:8b', defaultDimensions: 4096, dimensions: [4096], template: 'qwen3', tuningSupport: TUNING_SUPPORT.LORA },
      { id: 'BAAI/bge-m3', defaultDimensions: 1024, dimensions: [1024], template: 'bge', tuningSupport: TUNING_SUPPORT.FINE_TUNE },
      { id: 'bge-m3', defaultDimensions: 1024, dimensions: [1024], template: 'bge', tuningSupport: TUNING_SUPPORT.FINE_TUNE },
      { id: 'embeddinggemma:300m', defaultDimensions: 768, dimensions: [768], template: 'gemma', tuningSupport: TUNING_SUPPORT.LORA },
      { id: 'intfloat/e5-large-v2', defaultDimensions: 1024, dimensions: [1024], template: 'e5', tuningSupport: TUNING_SUPPORT.FINE_TUNE },
    ],
    isAuthed: () => true,
    isAvailable: () => true,
    embed: embedLocalInstruct,
  },
  {
    id: 'voyage',
    displayName: 'Voyage AI',
    kind: PROVIDER_KINDS.HOSTED,
    defaultModel: 'voyage-multimodal-3.5',
    defaultDimensions: 1024,
    dimensions: [256, 512, 1024, 2048],
    modalities: [MODALITIES.TEXT, MODALITIES.IMAGE],
    maxInput: { tokens: 32000 },
    taskModes: [TASK_MODES.QUERY, TASK_MODES.DOCUMENT],
    modeSignal: MODE_SIGNALS.INPUT_TYPE,
    supportsQueryDocumentMode: true,
    supportsContextualChunks: true,
    supportsTaskType: false,
    tuningSupport: TUNING_SUPPORT.CUSTOM,
    customizationLevel: CUSTOMIZATION_LEVELS.HOSTED_TUNED_MODEL,
    tuningNotes: 'Supports query/document input_type and custom/domain embedding paths; contextualized chunk embeddings are available for long-context retrieval.',
    costHints: { hosted: true, metered: true, unit: 'token', cacheRecommended: true },
    cacheHints: { cacheable: true, identityFields: VECTOR_IDENTITY_FIELDS },
    capabilityGate: { legacyFallbackOnly: false, providerSwapEligible: true },
    env: { apiKey: 'VOYAGE_API_KEY' },
    supportedModels: [
      { id: 'voyage-multimodal-3.5', defaultDimensions: 1024, dimensions: [256, 512, 1024, 2048], modalities: [MODALITIES.TEXT, MODALITIES.IMAGE] },
    ],
    isAuthed: () => !!process.env.VOYAGE_API_KEY,
    isAvailable: () => null,
    embed: embedVoyage,
  },
  {
    id: 'cohere',
    displayName: 'Cohere Embed',
    kind: PROVIDER_KINDS.HOSTED,
    defaultModel: 'embed-v4.0',
    defaultDimensions: 1536,
    dimensions: [256, 512, 1024, 1536],
    modalities: [MODALITIES.TEXT, MODALITIES.IMAGE],
    maxInput: { tokens: 128000 },
    taskModes: [TASK_MODES.QUERY, TASK_MODES.DOCUMENT],
    modeSignal: MODE_SIGNALS.INPUT_TYPE,
    supportsQueryDocumentMode: true,
    supportsContextualChunks: false,
    supportsTaskType: false,
    tuningSupport: TUNING_SUPPORT.CUSTOM,
    customizationLevel: CUSTOMIZATION_LEVELS.HOSTED_TUNED_MODEL,
    tuningNotes: 'Supports search_query/search_document input_type and Cohere custom/private embedding model paths.',
    costHints: { hosted: true, metered: true, unit: 'token', cacheRecommended: true },
    cacheHints: { cacheable: true, identityFields: VECTOR_IDENTITY_FIELDS },
    capabilityGate: { legacyFallbackOnly: false, providerSwapEligible: true },
    env: { apiKey: 'COHERE_API_KEY' },
    supportedModels: [
      { id: 'embed-v4.0', defaultDimensions: 1536, dimensions: [256, 512, 1024, 1536], modalities: [MODALITIES.TEXT, MODALITIES.IMAGE] },
    ],
    isAuthed: () => !!process.env.COHERE_API_KEY,
    isAvailable: () => null,
    embed: embedCohere,
  },
  {
    id: 'gemini',
    displayName: 'Gemini / Vertex embeddings',
    kind: PROVIDER_KINDS.HOSTED,
    defaultModel: 'gemini-embedding-001',
    defaultDimensions: 3072,
    dimensions: [768, 1536, 3072],
    modalities: [MODALITIES.TEXT],
    maxInput: { tokens: 8192 },
    taskModes: [TASK_MODES.QUERY, TASK_MODES.DOCUMENT],
    modeSignal: MODE_SIGNALS.TASK_TYPE,
    supportsQueryDocumentMode: true,
    supportsContextualChunks: false,
    supportsTaskType: true,
    tuningSupport: TUNING_SUPPORT.CUSTOM,
    customizationLevel: CUSTOMIZATION_LEVELS.HOSTED_TUNED_MODEL,
    tuningNotes: 'Gemini API supports RETRIEVAL_QUERY/RETRIEVAL_DOCUMENT taskType for text embeddings. It is disabled for provider-swap eligibility until a verified multimodal Vertex adapter exists.',
    costHints: { hosted: true, metered: true, unit: 'token', cacheRecommended: true },
    cacheHints: { cacheable: true, identityFields: VECTOR_IDENTITY_FIELDS },
    capabilityGate: {
      legacyFallbackOnly: false,
      providerSwapEligible: false,
      adapterMustVerifyModality: true,
      reason: 'The currently implemented Gemini API adapter is text-only; multimodal eligibility requires a verified Vertex/Gemini multimodal embedding endpoint.',
    },
    env: { apiKey: 'GEMINI_API_KEY' },
    supportedModels: [
      { id: 'gemini-embedding-001', defaultDimensions: 3072, dimensions: [768, 1536, 3072] },
    ],
    isAuthed: () => !!process.env.GEMINI_API_KEY,
    isAvailable: () => null,
    embed: embedGemini,
  },
  {
    id: 'jina-v5-omni',
    displayName: 'Jina v5 omni',
    kind: PROVIDER_KINDS.LOCAL,
    defaultModel: 'jinaai/jina-embeddings-v5-omni-small-retrieval',
    defaultDimensions: 1024,
    dimensions: [32, 64, 128, 256, 512, 768, 1024],
    modalities: [MODALITIES.TEXT, MODALITIES.IMAGE, MODALITIES.VIDEO, MODALITIES.AUDIO],
    maxInput: { tokens: 32768 },
    taskModes: [TASK_MODES.QUERY, TASK_MODES.DOCUMENT],
    modeSignal: MODE_SIGNALS.ADAPTER,
    supportsQueryDocumentMode: 'adapter',
    supportsContextualChunks: false,
    supportsTaskType: false,
    tuningSupport: TUNING_SUPPORT.LORA,
    customizationLevel: CUSTOMIZATION_LEVELS.LOCAL_LORA_ADAPTER,
    tuningNotes: 'Jina v5 omni retrieval variants are the first local multimodal instruct candidates, but the current Node runtime cannot execute them: the repo pins @xenova/transformers 2.17.2 / ONNX Runtime 1.14, while Jina v5 omni requires the Python Transformers remote-code path or another verified local runtime.',
    costHints: { hosted: false, metered: false, cacheRecommended: true },
    cacheHints: { cacheable: true, identityFields: VECTOR_IDENTITY_FIELDS },
    capabilityGate: {
      legacyFallbackOnly: false,
      providerSwapEligible: false,
      adapterPending: true,
      runtimeUnsupported: true,
      reason: 'No verified @xenova/transformers 2.17.2 + ONNX Runtime 1.14 artifact exists for Jina v5 omni multimodal retrieval; local adapter returns null until a supported Transformers.js/ONNX, GGUF, or service runtime is wired.',
    },
    env: {
      runtime: 'disabled in the current Node/transformers/ONNX stack',
    },
    supportedModels: [
      { id: 'jinaai/jina-embeddings-v5-omni-small-retrieval', defaultDimensions: 1024, dimensions: [32, 64, 128, 256, 512, 768, 1024] },
      { id: 'jinaai/jina-embeddings-v5-omni-nano-retrieval', defaultDimensions: 768, dimensions: [32, 64, 128, 256, 512, 768] },
    ],
    isAuthed: () => true,
    isAvailable: () => false,
    embed: embedJinaV5Omni,
  },
];

const providers = new Map(providerList.map((p) => [p.id, p]));

function getProvider(id) {
  return providers.get(String(id || '')) || null;
}

function listProviders() {
  return [...providers.values()];
}

function modelEntry(provider, model) {
  const wanted = String(model || provider.defaultModel || '');
  return (provider.supportedModels || []).find((m) => m.id === wanted) || null;
}

function modelModalities(provider, entry) {
  const values = entry && Array.isArray(entry.modalities) && entry.modalities.length
    ? entry.modalities
    : provider.modalities;
  return Array.isArray(values) ? values : [];
}

function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return value === 'query' || value === 'retrieval.query' ? TASK_MODES.QUERY : TASK_MODES.DOCUMENT;
}

function normalizeModality(modality) {
  const value = String(modality || '').trim().toLowerCase();
  return Object.values(MODALITIES).includes(value) ? value : MODALITIES.TEXT;
}

function parseDimensions(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeEmbeddingConfig(source) {
  const raw = source && source.config && source.config.embedding ? source.config.embedding
    : (source && source.embedding ? source.embedding : source);
  const providerId = String(
    (raw && raw.provider)
    || process.env.ZONOID_EMBED_PROVIDER
    || DEFAULT_PROVIDER_ID
  );
  const provider = getProvider(providerId) || getProvider(DEFAULT_PROVIDER_ID);
  const model = String((raw && raw.model) || process.env.ZONOID_EMBED_MODEL || provider.defaultModel);
  const entry = modelEntry(provider, model) || modelEntry(provider, provider.defaultModel);
  const resolvedModel = entry ? entry.id : provider.defaultModel;
  let dims = parseDimensions((raw && raw.dimensions) || process.env.ZONOID_EMBED_DIMENSIONS)
    || (entry && entry.defaultDimensions)
    || provider.defaultDimensions
    || null;
  if (entry && Array.isArray(entry.dimensions) && entry.dimensions.length && !entry.dimensions.includes(dims)) {
    dims = entry.defaultDimensions || provider.defaultDimensions || dims;
  }
  const cfg = {
    provider: provider.id,
    model: resolvedModel,
    dimensions: dims,
  };
  if (raw && raw.baseUrl) cfg.baseUrl = String(raw.baseUrl);
  if (raw && raw.apiStyle) cfg.apiStyle = String(raw.apiStyle);
  if (raw && raw.adapter) cfg.adapter = String(raw.adapter);
  const tuned = raw && (raw.tuned_model_id || raw.tunedModelId || raw.customModel);
  if (tuned) cfg.tuned_model_id = String(tuned);
  if (raw && raw.modality) cfg.modality = normalizeModality(raw.modality);
  return cfg;
}

function vectorIdentityString(meta) {
  return VECTOR_IDENTITY_FIELDS
    .filter((field) => meta[field] !== undefined && meta[field] !== null && meta[field] !== '')
    .map((field) => `${field}=${encodeURIComponent(String(meta[field]))}`)
    .join('|');
}

function embeddingMeta(source, opts = {}) {
  const cfg = normalizeEmbeddingConfig(source);
  const meta = {
    vector_schema_version: VECTOR_SCHEMA_VERSION,
    provider: cfg.provider,
    model: cfg.model,
    dimensions: cfg.dimensions,
    task_mode: normalizeMode(opts.mode || cfg.task_mode || cfg.taskMode),
    modality: normalizeModality(opts.modality || cfg.modality),
  };
  if (cfg.adapter) meta.adapter = cfg.adapter;
  if (cfg.tuned_model_id) meta.tuned_model_id = cfg.tuned_model_id;
  meta.identity = vectorIdentityString(meta);
  return meta;
}

function validateEmbeddingConfig(input = {}) {
  const provider = getProvider(input.provider || DEFAULT_PROVIDER_ID);
  if (!provider) return { ok: false, error: `unknown embedding provider '${input.provider}'` };
  const model = input.model || provider.defaultModel;
  const entry = modelEntry(provider, model);
  if (!entry) {
    const known = (provider.supportedModels || []).map((m) => m.id);
    return { ok: false, error: `unsupported embedding model '${model}' for provider '${provider.id}' (known: ${known.join(', ')})` };
  }
  const dimensions = parseDimensions(input.dimensions) || entry.defaultDimensions || provider.defaultDimensions || null;
  if (dimensions && Array.isArray(entry.dimensions) && entry.dimensions.length && !entry.dimensions.includes(dimensions)) {
    return { ok: false, error: `unsupported dimensions ${dimensions} for '${model}' (known: ${entry.dimensions.join(', ')})` };
  }
  const modality = input.modality ? normalizeModality(input.modality) : null;
  if (modality && !modelModalities(provider, entry).includes(modality)) {
    return { ok: false, error: `unsupported modality '${modality}' for embedding model '${entry.id}'` };
  }
  if (provider.capabilityGate && provider.capabilityGate.providerSwapEligible === true) {
    const modalities = modelModalities(provider, entry);
    const hasMultimodal = modalities.includes(MODALITIES.TEXT) && modalities.some((m) => m !== MODALITIES.TEXT);
    const hasRetrievalModes = (provider.taskModes || []).includes(TASK_MODES.QUERY) && (provider.taskModes || []).includes(TASK_MODES.DOCUMENT);
    if (!hasMultimodal || !hasRetrievalModes) {
      return { ok: false, error: `embedding provider '${provider.id}' is missing multimodal or query/document retrieval support` };
    }
  }
  const out = { provider: provider.id, model: entry.id };
  if (dimensions) out.dimensions = dimensions;
  if (input.baseUrl) out.baseUrl = String(input.baseUrl);
  if (input.apiStyle) out.apiStyle = String(input.apiStyle);
  if (input.adapter) out.adapter = String(input.adapter);
  const tuned = input.tuned_model_id || input.tunedModelId || input.customModel;
  if (tuned) out.tuned_model_id = String(tuned);
  if (modality) out.modality = modality;
  return { ok: true, config: out };
}

function comparableMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  return {
    vector_schema_version: Number(meta.vector_schema_version || meta.schema_version || VECTOR_SCHEMA_VERSION),
    provider: String(meta.provider || ''),
    model: String(meta.model || ''),
    dimensions: Number(meta.dimensions),
    task_mode: normalizeMode(meta.task_mode || meta.taskMode),
    modality: normalizeModality(meta.modality),
    adapter: meta.adapter ? String(meta.adapter) : null,
    tuned_model_id: meta.tuned_model_id || meta.tunedModelId || meta.customModel
      ? String(meta.tuned_model_id || meta.tunedModelId || meta.customModel)
      : null,
  };
}

function sameMeta(a, b) {
  if (!a || !b) return false;
  const left = comparableMeta(a);
  const right = comparableMeta(b);
  if (!left || !right) return false;
  return VECTOR_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function vectorMatchesMeta(vec, meta, expected) {
  if (!Array.isArray(vec) || !expected || Number(expected.dimensions) !== vec.length) return false;
  if (meta) return sameMeta(meta, expected);
  return expected.provider === DEFAULT_PROVIDER_ID && expected.model === MINILM_MODEL && vec.length === MINILM_DIMS;
}

function annotateProvider(provider) {
  const activeModel = modelEntry(provider, provider.defaultModel);
  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    defaultModel: provider.defaultModel,
    defaultDimensions: provider.defaultDimensions,
    dimensions: provider.dimensions || [],
    modalities: provider.modalities || [],
    maxInput: provider.maxInput || null,
    taskModes: provider.taskModes || [],
    modeSignal: provider.modeSignal || MODE_SIGNALS.NONE,
    supportsQueryDocumentMode: provider.supportsQueryDocumentMode,
    supportsContextualChunks: provider.supportsContextualChunks,
    supportsTaskType: provider.supportsTaskType,
    tuningSupport: provider.tuningSupport,
    customizationLevel: provider.customizationLevel || provider.tuningSupport || CUSTOMIZATION_LEVELS.NONE,
    tuningNotes: provider.tuningNotes,
    costHints: provider.costHints || null,
    cacheHints: provider.cacheHints || null,
    capabilityGate: provider.capabilityGate || null,
    supportedModels: provider.supportedModels || [],
    isAvailable: typeof provider.isAvailable === 'function' ? provider.isAvailable() : null,
    isAuthed: typeof provider.isAuthed === 'function' ? !!provider.isAuthed() : false,
    activeModel,
  };
}

function applyLocalTemplate(model, text, mode) {
  const m = String(model || '').toLowerCase();
  const s = String(text || '');
  if (m.includes('e5')) return `${mode === 'query' ? 'query' : 'passage'}: ${s}`;
  if (m.includes('bge')) return mode === 'query'
    ? `Represent this sentence for searching relevant passages: ${s}`
    : s;
  if (m.includes('qwen3')) return mode === 'query'
    ? `Instruct: Given a retrieval query, retrieve relevant passages that answer the query\nQuery: ${s}`
    : `Document: ${s}`;
  if (m.includes('gemma')) return `${mode === 'query' ? 'Query' : 'Document'}: ${s}`;
  return s;
}

function postJson(urlString, body, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body || {});
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = s ? JSON.parse(s) : {}; } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

function extractVector(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.embedding)) return payload.embedding;
  if (payload && Array.isArray(payload.embeddings) && Array.isArray(payload.embeddings[0])) return payload.embeddings[0];
  if (payload && payload.embeddings && Array.isArray(payload.embeddings.float) && Array.isArray(payload.embeddings.float[0])) return payload.embeddings.float[0];
  if (payload && Array.isArray(payload.data) && payload.data[0] && Array.isArray(payload.data[0].embedding)) return payload.data[0].embedding;
  if (payload && payload.embedding && Array.isArray(payload.embedding.values)) return payload.embedding.values;
  return null;
}

function isDataImage(value) {
  return typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function normalizeHostedInput(input, modality) {
  if (modality === MODALITIES.TEXT) return { ok: true, text: String(input || '') };
  if (modality !== MODALITIES.IMAGE) {
    return { ok: false, error: `unsupported hosted embedding modality '${modality}'` };
  }
  if (typeof input === 'object' && input && !Array.isArray(input)) {
    const image = input.image || input.imageUrl || input.url || input.dataUrl || input.base64;
    const text = input.text || input.caption || '';
    if (image) return { ok: true, image: String(image), text: String(text || '') };
  }
  const value = String(input || '');
  if (isDataImage(value) || isHttpUrl(value)) return { ok: true, image: value, text: '' };
  return { ok: false, error: 'image embeddings require an image URL or data:image base64 URL' };
}

function assertHostedRequest(provider, cfg, opts) {
  const mode = normalizeMode(opts && opts.mode);
  const modality = normalizeModality((opts && opts.modality) || cfg.modality);
  const entry = modelEntry(provider, cfg.model);
  if (!entry || !modelModalities(provider, entry).includes(modality)) return null;
  if (![TASK_MODES.QUERY, TASK_MODES.DOCUMENT].includes(mode)) return null;
  return { mode, modality };
}

async function embedLocalInstruct(text, cfg, opts) {
  const mode = normalizeMode(opts && opts.mode);
  const input = applyLocalTemplate(cfg.model, text, mode);
  const base = String(cfg.baseUrl || process.env.ZONOID_EMBED_LOCAL_BASE_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const explicitStyle = String(cfg.apiStyle || process.env.ZONOID_EMBED_LOCAL_API_STYLE || '').toLowerCase();
  const style = explicitStyle || (base.endsWith('/v1') ? 'openai' : 'ollama');
  if (style === 'openai') {
    const headers = {};
    const key = process.env.ZONOID_EMBED_LOCAL_API_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;
    const body = { model: cfg.model, input };
    if (cfg.dimensions) body.dimensions = cfg.dimensions;
    return extractVector(await postJson(`${base}/embeddings`, body, headers));
  }
  try {
    return extractVector(await postJson(`${base}/api/embed`, { model: cfg.model, input }));
  } catch {
    return extractVector(await postJson(`${base}/api/embeddings`, { model: cfg.model, prompt: input }));
  }
}

async function embedVoyage(text, cfg, opts) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  const request = assertHostedRequest(getProvider('voyage'), cfg, opts);
  if (!request) return null;
  const input = normalizeHostedInput(text, request.modality);
  if (!input.ok) return null;
  const item = input.image
    ? [{ type: 'text', text: input.text || 'Represent this image for retrieval.' }, { type: 'image_url', image_url: input.image }]
    : input.text;
  const body = { model: cfg.model, input: [item], input_type: request.mode };
  if (cfg.dimensions) body.output_dimension = cfg.dimensions;
  return extractVector(await postJson('https://api.voyageai.com/v1/embeddings', body, { Authorization: `Bearer ${key}` }));
}

async function embedCohere(text, cfg, opts) {
  const key = process.env.COHERE_API_KEY;
  if (!key) return null;
  const request = assertHostedRequest(getProvider('cohere'), cfg, opts);
  if (!request) return null;
  const input = normalizeHostedInput(text, request.modality);
  if (!input.ok) return null;
  const mode = request.mode === 'query' ? 'search_query' : 'search_document';
  const body = { model: cfg.model, input_type: mode, embedding_types: ['float'] };
  if (input.image) body.images = [input.image];
  else body.texts = [input.text];
  if (cfg.dimensions) body.output_dimension = cfg.dimensions;
  return extractVector(await postJson('https://api.cohere.com/v2/embed', body, { Authorization: `Bearer ${key}` }));
}

async function embedGemini(text, cfg, opts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const request = assertHostedRequest(getProvider('gemini'), cfg, opts);
  if (!request) return null;
  const mode = normalizeMode(opts && opts.mode) === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
  const model = encodeURIComponent(cfg.model);
  const body = { content: { parts: [{ text }] }, taskType: mode };
  if (cfg.dimensions) body.outputDimensionality = cfg.dimensions;
  return extractVector(await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`, body));
}

async function embedJinaV5Omni() {
  if (process.env.ZONOID_EMBED_DEBUG === '1') {
    process.stderr.write('[embed] provider jina-v5-omni disabled: current @xenova/transformers 2.17.2 / ONNX Runtime 1.14 stack cannot run Jina v5 omni retrieval models locally\n');
  }
  return null;
}

module.exports = {
  DEFAULT_PROVIDER_ID,
  MINILM_MODEL,
  MINILM_DIMS,
  PROVIDER_KINDS,
  CUSTOMIZATION_LEVELS,
  TUNING_SUPPORT,
  MODALITIES,
  TASK_MODES,
  MODE_SIGNALS,
  VECTOR_SCHEMA_VERSION,
  VECTOR_IDENTITY_FIELDS,
  getProvider,
  listProviders,
  annotateProvider,
  normalizeMode,
  normalizeModality,
  normalizeEmbeddingConfig,
  validateEmbeddingConfig,
  embeddingMeta,
  vectorIdentityString,
  vectorMatchesMeta,
};
