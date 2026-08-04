# Artifact Provider Contract

Status: architecture contract only. No runtime ingestion behavior is defined here.

Artifact providers turn external material into structured graph evidence. They do
not decide current truth, durable identity, belief state, or supersession. Those
decisions live above provider output in the memory substrate. Provider output is
immutable evidence with replayable provenance.

## Scope

This contract defines the shape providers must emit so future PDF, document,
conversation, code, and image providers can integrate with the graph consistently.
The companion schema is [`artifact-provider.v1.schema.json`](../schemas/artifact-provider.v1.schema.json).

Non-goals:

- no runtime ingestion pipeline
- no concrete AST node, symbol, parser, or code-index schema
- no provider-specific extraction algorithm
- no truth resolution, entity merge, or belief update policy

## Provider identity and versioning

Each emission names the provider with:

- `provider.id`: stable reverse-DNS or slug-style identifier
- `provider.version`: provider implementation version
- `provider.contract_version`: schema major version, currently `1`
- `provider.artifact_types`: artifact families the provider can emit

Changing emitted IDs, category semantics, or relation semantics requires a
provider version bump. Breaking contract changes require a new schema major
version.

## Emission envelope

A provider emits one deterministic batch:

- `emission_id`: deterministic id for the provider, source set, and provider
  version
- `sources`: source records with content digests and replayable origin metadata
- `nodes`: logical graph evidence nodes
- `relations`: evidence edges between emitted nodes

The same provider version over the same source bytes should emit the same
logical IDs and equivalent content.

## Source provenance

Every node and relation must point back to one or more source records. A source
record identifies the artifact family, media type when known, origin URI or
repository path when allowed, and a content digest when bytes are available.

Locators should be replayable in the source's native coordinate system: page
range, character range, line range, timestamp range, image region, message range,
cell range, DOM path, or a provider-native locator. Locators are evidence
addresses, not canonical identity.

## Logical node IDs

`node.logical_id` is deterministic and provider-owned. It should be derived from
stable source identity, provider id/version, and a replayable locator or content
digest. IDs must not depend on ingestion time, process ids, database ids, array
position alone, or any mutable display label.

Use IDs for idempotency only. Higher layers may resolve two provider nodes into
the same durable identity, but providers do not assert that identity directly.

## Node categories

Providers emit generic evidence categories:

| Category | Meaning |
|---|---|
| `artifact` | Whole source artifact or logical artifact root. |
| `container` | Provider-neutral grouping such as page, section, slide, sheet, thread, file, or frame. |
| `segment` | Addressable span, region, message, row, cell, range, or other bounded part. |
| `observation` | Extracted text, label, claim, table value, visual finding, summary, or other observed evidence. |
| `mention` | Mention of a person, place, symbol, file path, topic, or other candidate referent without resolving identity. |
| `reference` | Pointer to an external or cross-artifact target. |

Code providers must stay at these categories until the separate AST graph work
lands. For example, a code provider may emit repository, file, line range, and
mention evidence; it must not define function/class/module AST node shapes here.

## Relation edges

Relations describe evidence between emitted nodes. The base relation vocabulary is:

- `contains`
- `derived_from`
- `observed_in`
- `mentions`
- `references`
- `supports`
- `contradicts`
- `duplicates`
- `related_to`

Relations may carry confidence and provenance. They are still observations; a
`duplicates` or `contradicts` relation is evidence for higher-level resolution,
not a command to merge, delete, or supersede graph state.

## Boundaries

Hierarchy is represented with `contains` relations. Providers should avoid
encoding hierarchy only in display labels or metadata.

Provenance is mandatory for nodes and relations. If a provider creates a derived
observation, the relation chain must be enough to trace it back to source bytes
or source-native coordinates.

Idempotency is bounded by provider id, provider version, source digest, and
logical id. Consumers may reject or quarantine batches with duplicate logical
ids, dangling relation endpoints, missing source provenance, or unstable IDs.

## Validation expectations

At minimum, a consumer should verify:

- the JSON parses and validates against the v1 schema
- provider identity and contract version are present
- source ids are unique and referenced by all provenance records
- node logical ids are unique within the batch
- relation logical ids are unique within the batch
- every relation endpoint refers to an emitted node
- required provenance exists for every node and relation
- provider output is deterministic across repeated runs on unchanged sources

Schema validation handles field shape. Cross-reference and determinism checks are
consumer responsibilities.
