# Embedding Provider Contract

Status: architecture contract plus registry metadata. Runtime adapter work is
limited to providers that already have an implementation in
`lib/embed-providers.js`; Voyage multimodal and Cohere Embed v4 are the current
hosted multimodal adapters. Jina v5 omni is registered as the first local
multimodal instruct candidate, but its adapter is intentionally disabled because
the current `@xenova/transformers` 2.17.2 / ONNX Runtime 1.14 stack cannot run a
verified local Jina v5 omni retrieval artifact.

This contract defines the capability surface future embedding adapters must
expose before they are eligible for provider-swap work. MiniLM remains the legacy
compatibility fallback only: it may keep existing lexical/semantic behavior
alive, but it does not satisfy the future provider gate.

## Provider shape

Every provider registry entry should expose:

- `id`: stable provider family id, such as `voyage`, `cohere`, `gemini`, or
  `jina-v5-omni`
- `kind`: `hosted` or `local`
- `defaultModel`, `supportedModels`, `dimensions`, and `defaultDimensions`
- `modalities`: input modalities the selected family can place in one shared
  vector space, such as `text`, `image`, `video`, or `audio`
- `maxInput`: provider/model input limit metadata, preferably tokens or native
  provider units
- `taskModes`: retrieval modes the adapter can request, at minimum `query` and
  `document`
- `modeSignal`: how the adapter expresses asymmetric retrieval semantics:
  `input_type`, `task_type`, `template`, `adapter`, or `none`
- `customizationLevel`: one of `none`, `hosted_tuned_model`,
  `local_lora_adapter`, or `full_finetune`
- `costHints`: coarse billing hints for hosted providers and local cost signals
- `cacheHints`: whether request/result caching is safe and what identity fields
  must be part of the cache key
- `capabilityGate`: machine-readable eligibility results

The normalized embedding identity is versioned and stored beside every vector.
Version 1 identity fields are `vector_schema_version`, `provider`, `model`,
`dimensions`, `task_mode`, `modality`, plus `adapter` or `tuned_model_id` when
present. Future adapters that add quantization variants or non-float encodings
must add those fields by bumping the vector schema version before storing
vectors.

## Capability gates

A provider is eligible for future provider-swap work only when all of these are
true:

- It is a local or hosted model family with a concrete adapter path.
- It declares `text` plus at least one non-text modality in `modalities`, or the
  selected hosted/local model family has credible multimodal support that can be
  enabled by a child adapter.
- It supports asymmetric retrieval through query/document modes. Acceptable
  signals include provider `input_type`, provider `taskType`, local prompt
  templates, task adapters, or equivalent prefixes.
- It declares dimensions, max input metadata, hosted/local placement, and
  customization level.
- It can produce vector metadata stable enough for stale-vector rejection.

Explicit exclusions:

- OpenAI text embeddings are excluded by policy even if the API is available.
- MiniLM is allowed only as the legacy fallback and should not be selected by
  provider-swap evaluation.
- A text-only instruct model can remain usable for experiments, but it does not
  pass the multimodal provider gate until paired with a credible multimodal model
  family.

## Candidate families

The registry should account for these families without requiring every adapter
to be implemented in this task:

| Provider | Placement | Modalities | Query/document signal | Customization level |
|---|---|---|---|---|
| Voyage multimodal | hosted | text, image | `input_type` | `hosted_tuned_model` |
| Cohere Embed v4 | hosted | text, image | `input_type` | `hosted_tuned_model` |
| Gemini / Vertex embeddings | hosted | text only in the current adapter | `task_type` / Vertex task type | `hosted_tuned_model` |
| Jina v5 omni/local | local candidate, disabled in current Node runtime | text, image, video, audio | adapter/template prefixes | `local_lora_adapter` |

For Jina v5 omni, the local adapter must stay fail-soft until runtime support is
verified. The current implementation returns `null` and marks
`capabilityGate.providerSwapEligible=false` with `runtimeUnsupported=true`
instead of claiming local support that the pinned Node/Transformers/ONNX stack
cannot provide.

For Gemini, adapter code must verify the selected API/model supports the
declared modality before passing the gate. The existing text endpoint is not
enough by itself, so the current Gemini registry entry is disabled for
provider-swap eligibility until a verified multimodal Vertex/Gemini adapter is
implemented.

## Adapter contract

Adapters must implement:

```js
async function embed(input, config, context) {
  // input is text today; multimodal child tasks may widen it to a structured
  // content array after the vector store and ingestion paths understand it.
  // context.mode is "query" or "document".
  // Return number[] or null. Do not throw for ordinary provider unavailability.
}
```

Required behavior:

- query embeddings use `context.mode === "query"`
- stored note/task/document embeddings use `context.mode === "document"`
- dimensions must match `embeddingMeta(config).dimensions`
- provider failures return `null` so lexical fallback remains available
- vectors must be stored with `vecMeta` / `vecsMeta` / `taskVecMeta`

## Vector identity and invalidation

Search must ignore stale vectors whose metadata does not match the active
embedding identity. A provider swap, model swap, dimension change, tuned model
change, adapter change, quantization change, or encoding change requires fresh
vectors.

Model-swap invalidation is scoped to the dense vector layer and semantic derived
artifacts. The planning helper reports stale `vecMeta`, `vecsMeta`,
`taskVecMeta`, knowledge `_vecMeta`, code/entity vector metadata, and
`autowire-semantic` edges. It must not clear or rewrite unrelated task graph
state such as status, summaries, dependencies, git/review metadata, or metrics.

Downstream migration controls should:

- compare active config identity against stored vector metadata
- report stale counts before swap
- re-embed notes, tasks, code nodes, and knowledge sidecars in document mode
- avoid mixing vector spaces in semantic scoring
- keep MiniLM vectors valid only under the MiniLM default identity

## Operational evaluation

Provider rollout choices, benchmark procedure, and the current provider matrix
are documented in [Embedding provider evaluation](embedding-provider-evaluation.md).

## Child task boundaries

This task intentionally does not implement hosted multimodal payload formats,
vector migration UI, or additional provider adapters. Future local Jina work
must first add or select a runtime that can actually execute the Jina v5 omni
retrieval models, then flip the runtime gate with tests that exercise real local
embedding calls.
