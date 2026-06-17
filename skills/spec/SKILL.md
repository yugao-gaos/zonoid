---
name: spec
description: >
  Create or update the workspace durable spec — a system node in the KB that every agent
  always sees, regardless of what it is searching for. Use to record standing goals,
  constraints, interfaces, invariants, and known bugs for the project.
  Use when user says "update the spec", "record this in the spec", "add to spec", or invokes /spec.
---

The workspace durable spec lives in the KB as a note with category="system". It is always
injected into every search_knowledge call, so every agent sees it at session start.

## Structure (caveman encoding — keep it tight)

Use these sections. Omit empty ones.

- **§G Goal** — what this project is and its primary objective
- **§C Constraints** — hard constraints (tech, scale, compliance, non-goals)
- **§I Interfaces** — key integration points (APIs, ports, data contracts)
- **§V Invariants** — things that must always be true (the rules the codebase enforces)
- **§B Bugs** — known open bugs (pipe table: `| key | description | severity |`)

Use caveman encoding: fragments, symbols (→ for leads-to, = for is, + for and), pipe tables
for repeating records. No prose filler. Aim for ≤400 chars per section.

## How to create/update the spec

1. Call `mcp__orchestrator-graph__search_knowledge` with `q="system spec"` to find the existing spec note (if any).
2. If one exists (note with `category:"system"` and title starting with "SPEC:"), draft the updated content incorporating the user's change.
3. Call `mcp__orchestrator-graph__record_decision` with:
   - `title`: `"SPEC: <project-name>"` (e.g. "SPEC: zonoid")
   - `summary`: the full spec content in the structured §-section format above
   - `category`: `"system"`
   - `supersedes`: the old spec note key (if updating an existing one)
4. Confirm the note was recorded and tell the user the note key.

## Reading the spec

Any agent can retrieve the current spec by calling:
```
search_knowledge(q="system spec SPEC:", k=1)
```
Because `category="system"` notes are always injected first in search results, the spec
will appear at score 1.0, tier="system" regardless of the query.

## What NOT to put in the spec

- Task-specific context (goes in task summaries or knowledge items)
- Ephemeral decisions that only apply to one session
- Large code blocks (keep it tight — agents read this every turn)
