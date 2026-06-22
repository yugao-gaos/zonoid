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
