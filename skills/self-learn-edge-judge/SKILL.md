---
name: self-learn-edge-judge
description: Adjudicate whether RAG-recalled note neighbors are SOUND context edges in the task graph (precision), and prune the blind similarity edges the old autowire pass left behind. The daemon is dumb — it only RECALLS candidates (semantic /search) and surfaces UNVERIFIED edges via /judge/next; YOU are the reasoning that decides keep/prune/create/surface. Use when the daemon has unjudged note edges or orphan notes (GET /judge/next returns items), or as a heartbeat loop step. Conservative by default: similarity is necessary but NOT sufficient — the default verdict is NO edge.
effort: high
---

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

`/judge/next` returns two kinds:

- **`edge`** — an UNVERIFIED blind similarity edge (`{judged:false, by:'autowire'}`), with both
  endpoints' `{title, summary, key, kind}`. Decide **keep** or **prune**.
- **`orphan`** — an under-connected note with `candidates[]`: its top semantic neighbors (looser
  RECALL threshold — recall, not precision), each `{key, title, summary, score, status}`. Decide,
  for each candidate, whether to **create** an edge — and in almost all cases, do NOT.

## Reasoning criteria (CONSERVATIVE — default is NO edge)

The bar is: **would a reader/worker of one node genuinely NEED the other node's fact to understand or
act correctly?** Topical nearness is not enough.

- **NO edge (MAJORITY outcome).** The two notes are near in topic but neither is *needed* to
  understand or act on the other. Two findings about "the gate", two unrelated benchmarks, two notes
  that merely share vocabulary → no edge. When in doubt, NO edge.
- **`context` (+ direction).** One note's fact is a genuine PREREQUISITE to correctly understand or
  use the other. `from` = the prerequisite PROVIDER, `to` = the consumer. (A root-cause finding →
  the task that fixes exactly that root cause is the canonical keep.)
- **`surface-supersede`.** The two state the SAME fact but one is newer/corrected (not merely
  similar). Do NOT apply it — `surfaceSupersede` raises a guidance item for a human to confirm.
  NEVER stamp `validTo` / mutate the timeline yourself.
- **UNVERIFIED edge:** keep ONLY if it clears the `context` bar above; otherwise prune. A dangling
  edge (an endpoint whose note no longer exists — `kind` comes back undefined / title falls back to
  the key) is always a prune.

## Verdict shapes (POST /judge/verdict)

```jsonc
{ "verdicts": [
  // keep an unverified edge that meets the bar:
  { "keepEdge":  { "from": "note:…", "to": "…" } },
  // prune an edge that doesn't (near-topic-only, or dangling):
  { "pruneEdge": { "from": "note:…", "to": "…" } },
  // create a REASONED edge from an orphan's candidate (note is the PROVIDER = from):
  { "createEdge": { "from": "note:…", "to": "…", "weight": 0.6 } },
  // propose-and-surface a supersede for human confirmation (NEVER auto-applied):
  { "surfaceSupersede": { "old": "note:…", "new": "note:…", "why": "newer measurement corrects the old figure" } },
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
- **Never auto-supersede.** `surfaceSupersede` is propose-only; the human stamps the timeline.
- **Budget discipline.** ≤ N items/tick. The cursor handles continuity — don't try to drain it in one
  pass.
- **No new daemon behavior.** Only `/judge/next` + `/judge/verdict`. All intelligence is here.
