# Handoff schemas

Versioned JSON Schema definitions for the dispatcher↔worker contract. One file,
[`handoff.v1.schema.json`](./handoff.v1.schema.json), bundles two definitions under a single
major version so the outbound envelope and the inbound result stay coupled.

These are **definitions only** — no behavior change. T2 (daemon validation) and T3 (dispatch
envelope) consume them.

## `handoff_envelope` — outbound (dispatcher → worker)

What a dispatcher hands a worker subagent at dispatch. The worker **copies slotted fields**
(`task_key`, `agent_id`, `branch`, `target_repo`) into its
`subconscious_assignment accept` / `complete` calls instead of parsing them back out of prose, and
reads `context_deps` as pre-resolved Tier-1 base context.

- **Plugs into:** the Agent-tool `schema` option at dispatch (**T3**). The dispatcher builds the
  envelope (resolving `context_deps` from `get_dependency_summaries` + note summaries) and passes
  it as the structured input the worker receives.
- `return_contract` is a `$ref` to `task_result`, so the worker is told the exact return shape.

## `progressive_disclosure_context` — additive live-agent context

Subconscious-provided live-agent context is layered. The implementation target is an optional
`progressive_disclosure_context` object added under `assignment.context` and, for Agent-tool handoff
envelopes, mirrored as `handoff_envelope.progressive_disclosure_context`. Existing fields stay in
place: `context.parent_task_keys`, `context.context_task_keys`, `context.dependency_summaries`,
top-level `context_deps`, and `agentic_search_context` are still valid.

Layer order is fixed:

1. `layer1`: the default brief. It contains `task`, `why`, `next_action`,
   `must_know_constraints`, and `blockers`. This is the only layer that should be copied into
   compact foreground prompts by default.
2. `layer2`: required base context. It contains dependency/context summaries needed to start work.
   Blocking summaries appear first in graph order; context summaries follow by descending relevance
   weight. This maps to existing `/task/context` and `get_dependency_summaries` behavior.
3. `layer3`: optional drill-down handles. It contains handles for related notes, related tasks,
   related files, prior attempts, and full trace. Handles point to existing deep surfaces such as
   `get_task_detail`, `search_knowledge`, local file reads, or transcript/diff routes; they do not
   embed deep payloads.

Naming rules:

- Use snake_case field names to match the current envelope shape.
- Use `task.key` for task ids inside the progressive object, but do not rename legacy `task_key`.
- Use `why` for the plan/context rationale and `next_action` for the immediate expected worker step.
- Use `must_know_constraints` only for constraints that materially affect execution; put general
  background in `layer2.dependency_summaries`.

Truncation rules:

- `layer1` is small enough for every agent-facing surface. Each string should be clipped before it
  reaches a prompt-sized consumer; recommended budgets are about 280 chars for `why` and
  `next_action`, 5 constraints, and 5 blockers.
- `layer2.dependency_summaries` should default to the same cheap budget as `/task/context`: enough
  summaries to start, not raw knowledge. Recommended defaults are 10 items and 500 chars per summary.
- `layer3` should default to handles only, capped per kind. Recommended default is 5 handles per
  kind, with optional `summary` clipped to about 280 chars.
- When anything is omitted, set `truncation.truncated: true` and increment
  `truncation.omitted_counts` by handle kind or summary bucket.

Compatibility rules:

- The schema change is additive and optional in `v1`; consumers must tolerate its absence.
- Producers must keep all existing assignment/handoff fields stable while progressive disclosure
  rolls out.
- Do not expand `/state` frontier defaults with this object. Frontier remains a cheap graph digest.
- Keep `/task/context` cheap and summary-only. Populate `layer2` from that surface or equivalent
  in-memory data, but put deep payloads behind Layer 3 handles.
- Use `/task/detail`, transcript/diff routes, `include_internal`, or `debug` only for explicit
  drill-down/debug flows. Deep traces should not be copied into default assignment envelopes.
- `agentic_search_context` may be used to select and justify Layer 2/3 items, but raw search steps
  remain behind `include_internal`/`debug` unless a caller explicitly requests diagnostics.

## `task_result` — inbound (worker → daemon)

What a worker returns via `subconscious_assignment complete` → `POST /overlay/status` terminal write.

- **Plugs into:** `/overlay/status` terminal validation (**T2 will enforce it**) on the
  `tested`/`failed` write. See `docs/adapter-contract.md` → the `/overlay/status` "Task complete"
  row.
- `metric_measurements` mirrors the overlay measurement shape (`{ value, guardrails }`, see
  `lib/overlay.js` `setMeasurement`). It is **required only when the task carries a metric spec**
  (`overlay.metrics[key]`, set via `configure_task` metric). The requirement is expressed as a
  JSON Schema conditional: T2 injects `has_metric_spec: true` from `overlay.metrics[key]` before
  validating, and the `allOf`/`if`/`then` makes `metric_measurements` required in that case.
  `has_metric_spec` is a validation-time discriminator, not persisted result data.
- `decisions[].wires_to` carries note provenance — always includes the current `task_key`
  (the one wiring only the worker knows).

## Versioning

Both definitions carry `version: 1` (a `const`) and the file is `*.v1.schema.json` with a
`v1` `$id`. A breaking change ships as `handoff.v2.schema.json`; consumers reject mismatched
`version`.
