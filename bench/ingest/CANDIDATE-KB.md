# Candidate Knowledge-Base — review before injection

Synthesized from three ingest sources mined out-of-band. **Nothing here has touched the
live orchestrator graph.** This doc is for your keep/drop approval; `inject.js` (in this
dir) performs the actual injection only when run with `--confirm`.

📊 Dashboard: http://localhost:8787/graph

## 1. Counts

| Source | Items | Recommended keep |
|---|---|---|
| `git-notes.json` (commit-mined) | 16 notes | **9** (drop 7) |
| `doc-notes.json` (README/CLAUDE.md/SKILL.md-mined) | 33 notes | **33** |
| `structure.json` nodes (static module graph) | 13 nodes | **13** |
| `structure.json` edges (`depends-on`) | 9 edges | **9** (as context edges) |

**Total candidate graph delta: 55 note nodes + 9 context edges.**
(9 kept git + 33 doc + 13 struct nodes = 55; the 9 struct edges become `kind:context` edges
between the struct nodes.)

## 2. Dedup pass

The doc-notes are the **distilled, durable** form of knowledge; the git-notes are the raw
**commit-message** form. Where a commit's lesson already landed in the README, the doc-note
wins (cleaner, deduped, provenance-neutral). Specific overlaps flagged:

| git-note (drop) | covered by doc-note (keep) |
|---|---|
| `docs(README): benchmark findings — work parity, cache_read is the cost, lean=parity` | `Context cost is entirely payload size; lean payload → cost parity` + `Measure work by output_tokens, not gross-minus-plumbing` |
| `test(bench): v3 lean-consult run …` | same two doc-notes above (this is the run that produced them) |

### The benchmark-study git-notes (v1–v4) are TRANSIENT, not durable

Seven git-notes are about the *benchmark study itself* — its harness, run checkpoints, and
metric decomposition (`v1 baseline`, `lazy-context tooling`, `v3 lean-consult run`,
`v4-hard task`, `v4 decomposition metric`, `v4 NO-WIN checkpoint`, `README findings commit`).
These are **study process / lab-notebook** entries. The *conclusions* they reached already
live as clean doc-notes (cost = payload size; measure by output_tokens; benefit unproven).
Keeping the per-run checkpoints would inject point-in-time noise into the graph.

**Recommendation: DROP all 7 study-process git-notes** (they are dropped by SHA in
`inject.js`'s `GIT_DROP_SOURCES`). The durable findings survive via the doc-notes.

## 3. Quality / noise assessment

### High-signal — KEEP (precise gotcha / decision with a reason)
- **All 33 doc-notes.** Each is a crisp decision or constraint with a rationale: ghost
  edges store on the consumer; native task IDs must be namespaced `session/id`; mkcert is
  required because TLS validates the issuer not locality; the PreToolUse gate checks task
  *existence* not match; planner only ADDs nodes; etc. This is exactly the durable
  decision/constraint knowledge note nodes are for.
- **9 kept git-notes** — genuine architecture decisions/findings not otherwise captured:
  `ORCH_WORKSPACE env` (dogfood-finding #1 about workspace-pointer hijack), `hold-merge mode`,
  `learnings-aware planner / rejected ledger`, `agent-liveness cascade fix (#11)`, the
  `metric-driven loop` build, the two checkpoint/initial-commit snapshots, and the project
  CLAUDE.md commit.
- **13 struct nodes + 9 edges** — accurate static module-dependency map; low-noise,
  high-orientation value for future tasks (which file depends on what).

### Low-signal — DROP
- The **7 benchmark-study git-notes** (section 2). Transient run-state, conclusions already
  deduped into doc-notes.

A couple of the *kept* git-notes are borderline (the two "Checkpoint"/"Initial commit"
snapshots are coarse) — they're retained as durable provenance anchors but you may prefer to
drop them too; say the word and I'll add their SHAs to `GIT_DROP_SOURCES`.

## 4. Representative sample (best candidate notes)

1. **Ghost edges store on the consumer; resolve foreign status on demand** — a cross-workspace
   dep lives in the consumer's overlay; foreign status resolved lazily (cached, cycle-guarded).
2. **Cross-session task IDs must be namespaced `session/id`** — native IDs are local-only;
   any cross-session reference must be `{session-uuid}/{id}`.
3. **Self-signed certs cannot shortcut local HTTPS; mkcert is required** — TLS validates the
   issuer against the trust store regardless of localhost; `mkcert -install` adds a trusted CA.
4. **The PreToolUse gate enforces task existence, not status truth** — `orch-gate.sh` denies
   inline Write/Edit without a claimed in_progress task; honest limit: a rubber-stamp task
   passes it; fails OPEN when the daemon is unreachable.
5. **Measure work by output_tokens, not gross-minus-plumbing** — MCP token attribution buckets
   cache_read into "plumbing", producing a spurious "65% less work" artifact.
6. **Planner only ADDs nodes; never touches in-flight work** — caused a runaway once; never
   cancel/supersede in-flight, never duplicate an open task, cap at 1–3 initiatives, else STOP.
7. **feat(mcp): ORCH_WORKSPACE env** (git) — `mcp-graph.js` posted `cwd` as the workspace on
   startup, so a headless worktree agent hijacked the global workspace pointer; honor
   `ORCH_WORKSPACE` when set. Dogfood-finding #1.
8. **A stuck optimization escalates to a human, never self-drops** — K no-winner rounds raise
   `request_guidance` and halt rather than quietly dropping or replanning.

## 5. What injecting this WOULD and WOULD NOT add

**WOULD add:** 55 durable note nodes (decisions/constraints/findings + the static module map)
plus 9 context edges mirroring the module `depends-on` graph, so future related tasks inherit
this knowledge via `suggest_links` context edges. Every node is titled `[ingest] …` so the
batch is distinguishable and reversible (filter by prefix to remove).

**WOULD NOT add (future work):** these three sources are all **same-repo, text-derived** (git
history, in-repo docs, static module graph). It does **not** include the planned **cross-modal**
ingest sources — tickets/issues, external assets, or runtime/telemetry — those remain future.
No ticket links, no asset references, no cross-workspace ghost edges are produced here.

## 6. Reversibility

Every injected node carries the `[ingest]` title prefix and `created_by:'ingest'`. To undo,
filter graph nodes by that prefix and remove them (and their `kind:context` edges). `inject.js`
is idempotent-ish: re-running with `--confirm` reads `GET /state`, skips any `[ingest]` title
that already exists, and only adds the missing remainder.
