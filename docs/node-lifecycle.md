# Node lifecycle

Developer reference for the unified `ingestNode()` pipeline introduced in task `unify/ingest-node-unify`.

---

## Overview

Every task node passes through a four-step pipeline at birth:

```
embed(title+summary)
  → setTaskVec          (store dense vector on overlay)
  → autowireNewTaskWholeGraph  (seed weight-0 candidate context edges)
  → markEagerJudge      (stamp judgingSince; gate task to not_ready until edges are adjudicated)
```

The pipeline is null-safe and best-effort: if the active embedding provider is unavailable, `embed()` returns `null`, the remaining steps are skipped, and the node falls back to lexical-only retrieval. Errors never propagate to the caller.

---

## Entry points

`ingestNode(overlay, g, key, { title, summary })` is called from two places:

### 1. `buildGraph` — adopt-on-first-sight (daemon.js ~L1541)

When `buildGraph` encounters a native, followup, or file-drop task it has never seen before, it calls `adoptNativeTask`, which copies the task's metadata into the overlay snapshot. Tasks newly adopted in this build are collected into `newlyAdopted[]`. After the synchronous graph build returns, an async fire-and-forget loop calls `ingestNode` for each new adoptee, rebuilding the recall graph per node so each adoption sees siblings adopted earlier in the same batch.

This path covers:
- **Native Claude tasks** (files under `~/.claude/tasks/<session>/`)
- **Followup tasks** (`followup/<slug>` keys backed by overlay snapshots, surfaced via `aggregateWorkspace`)
- **File-drop stub tasks** (tasks under designated drop folders, merged in `aggregateCached`)

### 2. `POST /overlay/status` — first in_progress claim (routes/overlay.js ~L204)

When a task receives its first `in_progress` status write and has no vector yet (`!_hasVec`), the route calls `ingestNode` with the task's title and current summary. This catches any remaining tasks that reach this route without having been ingested at birth (e.g. tasks created while the sidecar was down).

On subsequent status updates where the summary changes but a vector already exists, only `embed` + `setTaskVec` fire — no re-autowire, no re-mark. Candidate seeding is a one-shot operation at birth; edge evolution thereafter is owned by the judge.

---

## Pipeline steps

### Step 1 — `embed(taskEmbedText({ title, summary }))`

Calls the active provider through `lib/embed.js` to produce a dense vector from the concatenated title and summary. MiniLM is the default compatibility provider; configured alternatives must be instruction-aware for retrieval and tunable/customizable. Returns `null` if the provider is unavailable; the remaining steps are skipped.

### Step 2 — `setTaskVec(overlay, key, vec, meta)`

Stores the raw vector in `overlay.taskVecs[key]` and the provider/model/dimension identity in `overlay.taskVecMeta[key]`. Idempotent: re-embedding a task overwrites the prior vector and metadata. Semantic search ignores vectors whose metadata does not match the active provider identity, except legacy 384-dim MiniLM vectors under the default MiniLM provider.

### Step 3 — `autowireNewTaskWholeGraph(overlay, g, key, title, summary, vec)`

Scans every current note node and task node in the graph. For each candidate whose cosine similarity to the new node exceeds `SEMANTIC_AUTOWIRE_THRESHOLD` (~0.55), it inserts a weight-0, `judged:false`, `by:'autowire'` context edge. These are **candidate** edges only — unverified scaffolding for the judge to keep or prune. Returns the count of edges seeded.

Notes are providers, so note→task edges are added (mirroring `autowireNoteProvider`'s direction). Task→task candidates are also seeded when relevant.

### Step 4 — `markEagerJudge(overlay, key)`

Called only when `seeded > 0`. Stamps `overlay.eagerJudge[key]` and `overlay.judgingSince[key]` (wall-clock ms). The eagerJudge mark signals the daemon heartbeat to dispatch a node-scoped judge immediately (via `eagerJudgeDirective` → `/judge/next?node=<key>`).

---

## Edge judgment

After `markEagerJudge`, the node enters the **judging** lifecycle phase:

- `buildGraph` reads `judgingState(overlay, key)` for each task. The gate is **strict and clockless** (P6): readiness depends solely on whether unjudged candidate edges remain.
- A task with any unresolved weight-0 autowire edge reports `judging:true` and its effective status is forced to `not_ready` — it cannot be claimed yet. There is **no time-based auto-release**: the task holds until the candidate set actually drains (`provisional` is therefore always false).
- The heartbeat calls `eagerJudgeNodes(overlay)` to find pending marks and dispatches a judge agent per node (budget-clamped). The judge calls `/judge/next?node=<key>` to receive the node's unverified edge batch, then issues verdict calls to keep or prune each edge.
- Once all candidate edges are adjudicated, the `judging` flag clears and the task becomes `ready`.
- **Recovery (no deadlock):** if the eager judge stalls, the node never releases on its own — drain it on demand with `node scripts/judge-drain-once.js --node <key> --workspace <ws>` (or `POST /judge/drain?node=<key>`), which runs the same in-process judge synchronously to idle. Both the eager judge and this CLI can always drain a held node, so no node is ever stuck not-ready with no way to judge it.
- *(Separate, unchanged):* the **per-call** judge timeout that SIGKILLs a hung judge round keeps the surviving candidate edges unjudged/provisional for the next drain to re-judge — that is the edge-level retry behavior, distinct from this node-readiness gate.

---

## Note nodes

Note nodes (`POST /overlay/note`) do **not** go through `ingestNode`. They have their own birth path:

1. `embed(noteEmbedText({ title, category, tags, summary }), { mode: 'document' })` is called inline in the route handler.
2. The vector is stored directly on the note object (`n.vec`) with `n.vecMeta`; field-level vectors use `n.vecs` plus `n.vecsMeta`.
3. `markEagerJudge(overlay, 'note:' + id)` is called unconditionally — the mark self-prunes if the note carries no unverified edges, so it is a no-op for hand-wired notes.

Task-side `ingestNode` seeds note→task edges at task birth via `autowireNewTaskWholeGraph`; the note POST handler does not run `autowireNoteProvider` (that function is now a demoted no-op; the judge queue subsumes its role).

---

## Known bypass sites

| Site | What fires | Missing |
|------|------------|---------|
| `POST /overlay/backfill-embeddings` | document-mode `embed` + vector metadata refresh for stale/missing notes, knowledge, and tasks | no re-autowire, no re-mark |
| Note vec retry (~L358) | document-mode `embed` + `n.vec`/`n.vecMeta` patch | no autowire, no mark |
| `POST /overlay/reembed` | document-mode `embed` + vector metadata refresh for notes and task vectors | no pipeline steps |

All three are admin/migration paths, not runtime hot paths. No known runtime bypass exists for the standard task birth path as of `unify/ingest-node-unify`.
