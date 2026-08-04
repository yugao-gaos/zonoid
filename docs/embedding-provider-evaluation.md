# Embedding Provider Evaluation

Status: operational evaluation and rollout runbook. This document complements
the architecture contract in [Embedding provider contract](embedding-provider-contract.md).

## Recommendation

Keep MiniLM as the default compatibility provider until a live provider
benchmark is run with credentials in the target deployment. The best first swap
candidate is Voyage `voyage-multimodal-3.5` when hosted credentials and outbound
network access are acceptable. Cohere `embed-v4.0` is the alternate hosted
candidate. `local-instruct` is useful for text-only local experiments, but it
does not satisfy the multimodal provider-swap gate. Gemini remains disabled for
provider-swap eligibility until the implementation verifies a multimodal
embedding endpoint. Jina v5 omni remains disabled until a supported local runtime
is available.

The reason for the conservative default is operational, not architectural:
provider swaps change vector identity, invalidate existing dense vectors, and
require a re-embed pass before semantic scoring can be trusted.

## Provider Matrix

| Provider | Placement | Model | Dimensions | Credentials / runtime | Cost considerations | Provider-swap status |
|---|---|---|---:|---|---|---|
| MiniLM sidecar | local | `Xenova/all-MiniLM-L6-v2` | 384 | Bundled local sidecar | No hosted bill; small vectors; legacy quality and no query/document mode | Default compatibility fallback only |
| Voyage AI | hosted | `voyage-multimodal-3.5` | 256, 512, 1024, 2048 | `VOYAGE_API_KEY` | Metered text tokens and image pixels; cache document vectors aggressively; lower dimensions can reduce vector storage | Preferred eligible hosted candidate |
| Cohere Embed | hosted | `embed-v4.0` | 256, 512, 1024, 1536 | `COHERE_API_KEY` | Metered embed tokens; production keys are paid; lower dimensions and batch planning matter for large re-embeds | Eligible hosted alternate |
| Gemini | hosted | `gemini-embedding-001` | 768, 1536, 3072 | `GEMINI_API_KEY` | Metered input tokens; 3072-d default increases vector storage | Text-only adapter; not provider-swap eligible |
| Local instruct | local | `qwen3-embedding:*`, `bge-m3`, `embeddinggemma:300m`, `intfloat/e5-large-v2` | 768-4096 by model | `ZONOID_EMBED_LOCAL_BASE_URL` or `OLLAMA_HOST`; optional `ZONOID_EMBED_LOCAL_API_KEY` | No hosted bill; local CPU/GPU latency and ops cost; large dimensions increase storage | Text-only experiment; not provider-swap eligible |
| Jina v5 omni | local candidate | `jinaai/jina-embeddings-v5-omni-*-retrieval` | 32-1024 by model | Disabled in current Node runtime | No hosted bill if run locally; requires a new verified runtime before cost is meaningful | Registered but runtime-unsupported |

Pricing is intentionally expressed as operational shape instead of hard-coded
budgets. Provider prices change; check the provider pricing page before any
production re-embed. As of June 29, 2026, the upstream docs describe Voyage
multimodal billing by text tokens and image pixels, Cohere embed billing by
embedded tokens, and Gemini embedding billing by input tokens.

## Benchmark Status

This worker environment had no `VOYAGE_API_KEY`, `COHERE_API_KEY`,
`GEMINI_API_KEY`, `ZONOID_EMBED_LOCAL_BASE_URL`, or `OLLAMA_HOST`, so live
provider comparison could not be run here. Existing mocked integration coverage
does verify:

- registry validation rejects generic OpenAI embeddings and non-eligible
  modalities
- Voyage sends query/document `input_type` and multimodal payloads
- Cohere sends `search_query` / `search_document` request shape
- Gemini fails soft for unverified image modality
- Jina v5 omni fails soft while the local runtime is unsupported
- non-default vector metadata is required before semantic scoring accepts a
  vector

Run the focused test chain after any provider or migration change:

```sh
node test/embed-provider-config.test.js && \
node test/embedding-store.test.js && \
node test/search-knowledge.test.js && \
node test/search-activation.test.js && \
node test/search-pure-read.test.js
```

## Manual Benchmark Runbook

Use the existing retrieval benchmark so provider evaluation measures the same
`search_knowledge` route agents use.

1. Capture the MiniLM baseline in a clean workspace:

```sh
ZONOID_WORKSPACE=/path/to/workspace \
node scripts/retrieval-bench.js --heldout --isolated --k=3,5,10 --no-write
```

2. Dry-run the target provider swap and inspect stale-vector counts:

```sh
node scripts/reembed-embeddings.js \
  --workspace /path/to/workspace \
  --provider voyage \
  --model voyage-multimodal-3.5 \
  --dimensions 1024 \
  --dry-run
```

3. Apply the swap and force re-embedding only after credentials are present:

```sh
VOYAGE_API_KEY=... \
node scripts/reembed-embeddings.js \
  --workspace /path/to/workspace \
  --provider voyage \
  --model voyage-multimodal-3.5 \
  --dimensions 1024
```

4. Re-run the same retrieval benchmark:

```sh
ZONOID_WORKSPACE=/path/to/workspace \
node scripts/retrieval-bench.js --heldout --isolated --k=3,5,10 --no-write
```

5. Compare the scorecards on recall@5, MRR@5, provider latency, re-embed
   duration, stale-vector count after migration, and hosted bill estimate.

For Cohere, substitute `--provider cohere --model embed-v4.0 --dimensions 1536`
and set `COHERE_API_KEY`. For `local-instruct`, start the local embedding
endpoint first, then use `--provider local-instruct --model <supported-model>`.

## Swap Controls

Use `--dry-run` before every provider change. The swap endpoint reports the
previous identity, target identity, and invalidation plan without mutating
config or vectors. A non-dry-run swap stores `config.embedding`, re-embeds note
and task vectors in document mode, and rejects stale vector metadata during
search.

Do not mix vector spaces. If a provider call returns `null`, search falls back
to lexical behavior; it should not reuse MiniLM or previous-provider vectors
under the new identity.

Dimension choice is an operational decision:

- Use 1024 for the first Voyage run to balance quality, cost, and storage.
- Use Cohere 1536 for a full-quality comparison, then test 1024 if storage cost
  matters.
- Avoid 3072-d Gemini as a swap target until the multimodal adapter gate is
  resolved.
- Keep local instruct experiments isolated from provider-swap rollout decisions
  because they are text-only.

## Rollout Checklist

- Confirm outbound network access or local runtime availability.
- Set only the credential for the provider under test.
- Run provider config tests before mutating a workspace.
- Dry-run `scripts/reembed-embeddings.js` and record stale counts.
- Run the swap on a disposable or backed-up workspace first.
- Run held-out retrieval benchmark before and after the swap.
- Promote only if recall/MRR improve or operational constraints justify the
  tradeoff, and stale-vector count is zero after migration.
- Keep MiniLM as the emergency fallback config until the new provider has passed
  at least one full retrieval benchmark and one re-embed migration.

## Source Notes

The provider metadata in this repo is enforced by `lib/embed-providers.js` and
covered by `test/embed-provider-config.test.js`. Current public provider docs
consulted for this evaluation:

- Voyage pricing: https://docs.voyageai.com/docs/pricing
- Cohere pricing model: https://docs.cohere.com/docs/how-does-cohere-pricing-work
- Cohere Embed v4 model details: https://docs.cohere.com/docs/cohere-embed
- Gemini embedding availability and pricing note: https://developers.googleblog.com/gemini-embedding-available-gemini-api/
- Jina v5 omni model overview: https://jina.ai/models/jina-embeddings-v5-omni-small/
