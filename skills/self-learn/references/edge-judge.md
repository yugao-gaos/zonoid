
# Self-learn edge judge

The orchestrator's note graph used to be a cached, staler copy of a RAG query: the daemon blindly
attached a context edge to every note pair above a cosine threshold. Similarity ≠ a real structural
edge. This skill is the **precision** half of the fixed design:

> **RAG generates CANDIDATES (recall); the AGENT adjudicates whether each candidate is a sound DAG
> edge (precision), and of what type.** The edge that lands is a *reasoned assertion*, not a cosine
> score.

The daemon stays dumb (it computes embeddings + runs `/search`, never an LLM). All reasoning lives
here. You add NO new daemon behavior — you call `/judge/next` and `/judge/verdict`.

## The loop (heartbeat-compatible)

Each tick:

1. **Pull work.** `GET /judge/next?budget=N` (default N = `config.judge.budgetPerRun` ≈ 6). It returns
   up to N items from a PERSISTED cursor that advances + wraps across ticks, so you NEVER re-walk the
   whole graph and never re-judge an item until the cursor laps or the epoch grows. `idle:true` ⇒
   nothing to judge right now — stop until the epoch grows (a note/task was added).

2. **Reason each item** (criteria below) and build a verdict object.

3. **Apply.** `POST /judge/verdict { verdicts: [...] }`. Resume from the cursor next tick.

Respect the budget — at most N items per tick, no fan-out. The cursor + epoch survive a daemon
restart, so a long backlog (e.g. the ~273 blind note edges from the old autowire pass) is chewed
through incrementally, a handful per tick, across many ticks.

## Item kinds

`/judge/next` returns these kinds:

- **`edge`** — an UNVERIFIED blind similarity edge (`{judged:false, by:'autowire'}`) anchor(`from`)
  → candidate `N`(`to`), with both endpoints' `{title, summary, key, kind}`. Decide **keep** or
  **prune** — but judge it WITH STRUCTURE, not the endpoint pair alone (see "Neighborhood" below):
  - **`neighborhood[]`** — N's surrounding context, assembled by the daemon as a relevance-decayed
    best-first walk over JUDGED context-edge weights: `relevance = product(edge weights) × decay^depth`,
    visited highest-first, stopped at a relevance floor or a size budget (so strong chains reach
    deeper, diffuse ones stop ~1 hop). Each entry `{key, title, summary, depth, relevance, via}`.
    `neighborhoodTruncated:true` means the budget capped it. **Use it:** an edge whose endpoint pair
    looks thin can still be a sound `keep` if N sits in a strong chain that makes anchor genuinely
    need it; conversely a topically-near pair with an empty/weak neighborhood is the usual prune.
  - **`supersedeChain[]`** — the notes N replaced (bitemporal: `{key, title, summary, validFrom,
    validTo, current}`, oldest→newest, N excluded). If N supersedes an older fact, judge against the
    CURRENT fact, not the retired one.
  - **`taskTask:true`** — both endpoints are tasks. Additionally classify KIND and DUPLICATE (below).
- **`orphan`** — an under-connected note with `candidates[]`: its top semantic neighbors (looser
  RECALL threshold — recall, not precision), each `{key, title, summary, score, status}`. Decide,
  for each candidate, whether to **create** an edge — and in almost all cases, do NOT.
- **`dup-cluster`** — a set of CURRENT notes whose embeddings cluster above a cosine RECALL bar
  (~0.80), carrying `keys[]` + `notes[]` (`{key, title, summary, created_at}`). RECALL is loose by
  design (it WILL over-merge a related series into one cluster); YOU supply precision: decide whether
  the cluster is genuinely ONE fact and **consolidate** it, or **surface** an ambiguous/distinct one.
- **`decay`** — a CURRENT note that passed the age/opportunity necessity gate and correlated with
  losing outcomes. The daemon only surfaces high-confidence retire candidates here; low-confidence
  and borderline rows stay in preview/diagnostics. If the evidence still looks sound, emit
  **`retireNote`** for a soft retire. This appends `note_superseded` with `validTo` and no
  `supersededBy`; it never deletes the note, so history/as-of recovery still works.
- **`reinforce`** — a CURRENT note with enough successful recall evidence to receive a positive
  boost. Emit `boostNote` with the provided boost/winRate/total when the evidence is coherent.

## Reasoning criteria (CONSERVATIVE — default is NO edge)

The bar is: **would a reader/worker of one node genuinely NEED the other node's fact to understand or
act correctly?** Topical nearness is not enough.

### OVERRIDE / SPEC IS INCOMPLETE notes — stronger prior toward KEEP

Notes whose **title starts with `OVERRIDE:`** or whose **summary starts with `SPEC IS INCOMPLETE:`**
are high-signal by convention (see CLAUDE.md KB authoring rules). They exist precisely because a
worker following only the spec or the code would produce a wrong result. When evaluating an edge
involving such a note:

- **Raise the prior toward KEEP.** The note asserts a correction or gap that a spec-following worker
  will miss. If the adjacent task or note is topically related (same function, same subsystem, same
  scenario), that is usually sufficient — treat it as a genuine prerequisite, not merely topical
  overlap.
- **The bar is still semantic.** An OVERRIDE note about `resolveOwner` is not a prerequisite for a
  task about `lru-cache`. Topic mismatch still prunes. But within the same topic area, lean KEEP.

- **NO edge (MAJORITY outcome).** The two notes are near in topic but neither is *needed* to
  understand or act on the other. Two findings about "the gate", two unrelated benchmarks, two notes
  that merely share vocabulary → no edge. When in doubt, NO edge.
- **`context` (+ direction).** One note's fact is a genuine PREREQUISITE to correctly understand or
  use the other. `from` = the prerequisite PROVIDER, `to` = the consumer. (A root-cause finding →
  the task that fixes exactly that root cause is the canonical keep.)
- **UNVERIFIED edge:** keep ONLY if it clears the `context` bar above; otherwise prune. A dangling
  edge (an endpoint whose note no longer exists — `kind` comes back undefined / title falls back to
  the key) is always a prune.

### task→task edges (`taskTask:true`): classify KIND and DUPLICATE

When both endpoints are tasks, a `keep` is not the whole verdict — also decide:

- **KIND — does anchor REQUIRE N?** If anchor genuinely cannot proceed until N is done (a true
  prerequisite, not just useful background), keep it as **blocking** (`keepEdge` with
  `kind:"blocking"`). If N is merely relevant context anchor benefits from, keep it as plain
  `context`. Default to `context`; reserve `blocking` for real prerequisites.
- **DUPLICATE — does anchor RE-PLAN N?** If anchor is a newer plan that subsumes/replaces the older
  task N (same work, re-scoped), that is a dup: emit **`supersedeTask`** `{old:N, new:anchor}` so N is
  retired (canceled + supersede edge) and a replan reconciles cleanly instead of leaving an orphan
  duplicate. Use the `neighborhood`/`supersedeChain` to confirm they're the SAME work, not two real
  steps. Conservative: when unsure it's a dup, keep the edge as `context` and do NOT supersede.

### Dedup criteria (dup-cluster items)

The bar is **same FACT**, not same topic. Two notes that merely cite the same subject, or two
measurements from different runs/regimes, are DISTINCT — do NOT consolidate them.

- **`consolidate` (CONFIDENT same-fact).** The notes assert the SAME fact (e.g. three near-identical
  `[ingest]` re-statements of one finding, or a raw note + its explicit correction). Pick the
  **keeper** = newest by `created_at` (tie-break: most complete summary); `supersede` the rest. This
  is SAFE and reversible — `supersedeNote` stamps `validTo` (it does NOT delete; as-of retrieval
  recovers the note) and the daemon re-points the cluster's context edges onto the keeper.
- **Mixed cluster (false-positive merge).** Recall clustered a related SERIES of distinct facts (e.g.
  benchmark v2/v3/v4/v5 verdicts). Consolidate ONLY the true-duplicate subset (e.g. a raw verdict and
  its explicit correction) and `surfaceCluster` the residual distinct notes — ONE cluster-level
  guidance item, never per-pair.
- **Ambiguous cluster — message the dispatcher (RARE).** Only when notes express plausibly DIFFERENT
  facts that share vocabulary and you genuinely cannot tell which is authoritative without user context.
  **Do NOT surface repeated-ingestion duplicates** — `[ingest]` notes with near-identical content are
  a confident `consolidate`, not an ambiguous case. The bar is: "a human seeing only these notes would
  be unsure which to keep AND the wrong choice has real consequences."
  When you hit this bar: call `mcp__ccd_session_mgmt__send_message` with `to=DISPATCHER_SESSION`
  (provided in your task context) and a message like:
  `"Dup-cluster needs decision: keys=[…], titles=[…]. Reply 'consolidate <keepKey>' or 'distinct'."`.
  Do NOT call `surfaceCluster` — that creates a dashboard guidance item, which is the wrong path.
  The dispatcher (`orchestrator-loop` in the main session) will ask the user inline and call `/judge/verdict`
  to record the decision. Still stamp the cluster via `markJudged` on each key so the cursor doesn't
  re-offer it before the dispatcher resolves it.

## Verdict shapes (POST /judge/verdict)

```jsonc
{ "verdicts": [
  // keep an unverified edge that meets the bar:
  { "keepEdge":  { "from": "note:…", "to": "…" } },
  // task→task keep where anchor REQUIRES N — reclassify the kept edge as a blocking prerequisite:
  { "keepEdge":  { "from": "<anchor task>", "to": "<N task>", "kind": "blocking" } },
  // task→task DUPLICATE — anchor re-plans N: retire N (cancel + supersede edge):
  { "supersedeTask": { "old": "<N task>", "new": "<anchor task>", "reason": "anchor re-scopes the same work" } },
  // prune an edge that doesn't (near-topic-only, or dangling):
  { "pruneEdge": { "from": "note:…", "to": "…" } },
  // create a REASONED edge from an orphan's candidate (note is the PROVIDER = from):
  { "createEdge": { "from": "note:…", "to": "…", "weight": 0.6 } },
  // CONSOLIDATE a confirmed duplicate cluster: keep newest, supersede the rest (auto-applied, reversible):
  { "consolidate": { "keep": "note:…", "supersede": ["note:…", "note:…"], "why": "three re-statements of one fact; keep newest" } },
  // SURFACE one ambiguous/distinct cluster as a SINGLE guidance item (never per-pair):
  { "surfaceCluster": { "keys": ["note:…", "note:…"], "why": "related benchmark series of DISTINCT verdicts, not duplicates" } },
  // SOFT-retire a decay candidate; no deletion, no supersededBy:
  { "retireNote": { "noteKey": "note:…", "reason": "low-win-rate after age/opportunity gate" } },
  // apply a positive usage-derived boost:
  { "boostNote": { "noteKey": "note:…", "boost": 0.12, "winRate": 0.9, "total": 10 } },
  // a 'NO edge' verdict for an orphan still marks it judged so it isn't re-pulled until epoch grows:
  { "markJudged": "note:…" }
] }
```

Every verdict that resolves an ORPHAN item should carry `markJudged: "<that note key>"` (even a pure
"no edge" outcome) so the daemon stamps `judgedAtEpoch = epoch` and the cursor doesn't re-offer it
until a new node bumps the epoch. Edge items don't need `markJudged` — keep/prune resolves them
directly. The verdict endpoint is idempotent.

## Worked example (real verdicts)

- KEEP `note:"git substrate is workspace-bound (root-cause finding)" → task:"Let the git substrate
  target a code repo distinct from the daemon workspace"` — the note IS the root cause the task fixes;
  a worker needs it. Context, correct direction.
- PRUNE `note:"git substrate is workspace-bound" → task:"Fix mcp-graph.js workspace hijack"` — same
  broad topic ("workspace targeting") but a different file + mechanism; the git finding isn't needed
  to do the mcp-graph fix. Near-topic, not a prerequisite.
- PRUNE any edge whose `from` note is gone (dangling) — no provider to flow context.

## Guardrails

- **Conservative bias.** Most candidates and most unverified edges should be NO edge / prune. A graph
  of a few load-bearing edges beats a similarity clique. If you're keeping the majority, you're too
  loose.
- **Same fact, not same topic.** Consolidate only genuine duplicates; a related SERIES of distinct
  measurements/verdicts is NOT a duplicate — consolidate the true-dup subset and surface the rest.
  Consolidation is reversible (supersede stamps `validTo`, never deletes), but a wrong merge still
  hides a distinct fact until a human notices — so when unsure, `surfaceCluster` instead.
- **Budget discipline.** ≤ N items/tick. The cursor handles continuity — don't try to drain it in one
  pass.
- **No new daemon behavior.** Only `/judge/next` + `/judge/verdict`. All intelligence is here.
- **Decay is soft-retire only.** Never delete a note or mutate files directly. For `decay`, the only
  retire action is `retireNote`, which preserves temporal recoverability through `note_superseded`.
