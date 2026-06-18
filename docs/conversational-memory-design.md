# Zonoid Conversational-Memory Layer — Design (Zep/Graphiti-referenced)

> **Status:** strategic design only. NO code in this doc. The thesis: Zonoid already owns the
> *temporal substrate* a Zep-class memory layer needs — bi-temporal note fields, a supersession
> chain, subsumption/decay, as-of retrieval. What is missing is the *conversational front end*
> (a distiller) and the *entity layer* (typed entity nodes + relationship edges). Bolt those two on
> and Zonoid is a temporal knowledge-graph memory that does what Zep/Graphiti do for conversation
> **plus** what neither does: it unifies the conversational graph with the task/execution graph.

## 1. Zep / Graphiti architecture (cited)

Zep is a memory service for agents; its engine is **Graphiti**, an open-source temporally-aware
knowledge-graph framework. The architecture, from the Zep paper and Graphiti docs:

**Ingestion = episodes → entities + facts.** Raw input (a message, a JSON blob, a doc) enters as an
**episode**. An LLM extraction pass pulls **entity nodes** (people, orgs, things) and **edges**
(facts/relationships between entities) out of the episode text. Entities and facts are not raw chunks —
they are distilled, deduplicated graph elements, each retaining episode-level provenance back to the
source message. [1][2][5]

**Bi-temporal model.** Every node and edge tracks **two independent time axes**: *event time* `t`
(when the fact was true in the world — `t_valid` … `t_invalid`) and *ingestion / transaction time* `t'`
(when Zep learned it — `t'_created` … `t'_expired`). Four timestamps in total. This lets the system
reason over retroactive corrections, backdated facts, and "what did we believe at time T" queries
distinctly from "what was true at time T". [1][3][4]

**Fact invalidation via contradiction.** When a new edge is ingested, an LLM compares it against
semantically related **existing** edges to detect contradictions. On a temporally-overlapping
contradiction, the old edge's validity window is **closed** (`t_invalid` / "valid to" is set) rather
than deleted — the fact is retired, not erased, so history stays queryable. New fact supersedes old;
both survive. [2][6]

**Hybrid retrieval, no LLM in the read path.** Search fuses three signals: **semantic** (vector cosine
over entity/edge embeddings), **keyword** (BM25 full-text over names/summaries), and **graph traversal**
(breadth-first expansion from seed nodes along relationships). Results from the parallel methods are
combined with **Reciprocal Rank Fusion (RRF)**; optional cross-encoder and graph-distance rerankers
add precision. Retrieval avoids LLM summarization entirely, hitting ~P95 300 ms. [5][7]

**Mem0 (secondary reference).** Mem0 takes the LLM-extraction idea without the heavy temporal graph:
each turn, an LLM extracts candidate memories, then a second LLM pass decides ADD / UPDATE / DELETE /
NOOP against existing memories (a learned dedup+conflict step). It is the cheapest credible version of
"distill conversation into atomic facts," and a useful floor for our Phase-1 distiller. [8]

Sources: [1] Zep paper (arXiv 2501.13956); [2] Graphiti DeepWiki (getzep/graphiti); [3] Zep "Temporal
Knowledge Graph" definition; [4] "Beyond Static Knowledge Graphs" (Zep blog); [5] Neo4j "Graphiti:
knowledge graph memory" blog; [6] Graphiti README (getzep/graphiti); [7] Zep "Searching the Graph"
docs; [8] Mem0 architecture (LLM fact-extraction + ADD/UPDATE/DELETE).

## 2. Gap analysis — Graphiti capability → Zonoid mechanism (HAVE vs MISSING)

The point this table makes: **the temporal substrate is already built.** The Graphiti capabilities
that are hard (bi-temporal storage, non-destructive supersession, as-of queries, soft-retirement) are
*shipped and load-bearing* in Zonoid. The gaps are at the two ends — input (a distiller) and structure
(entities) — plus a fusion upgrade in the read path.

| Graphiti capability | Zonoid mechanism that already provides it | Verdict |
|---|---|---|
| **Episode ingestion** (raw input persisted with provenance) | Sessions/transcripts exist (`transcript` pointer on every task node; `.jsonl` event log per node in `lib/graph-store.js`). Notes carry `created_by`/`created_at` provenance. | **PARTIAL** — raw material is captured, but nothing distills a *session* into facts. |
| **Entity extraction** (typed entity nodes) | — none. Node kinds are `task`, `note`, `system`, feature-record. Grep of `lib/` for `entity` finds zero entity modelling. | **MISSING** |
| **Relationship edges** (typed entity↔entity facts) | Edge kinds are `blocking`, `context`, `supersede` only (`lib/overlay.js` addDependency). No typed semantic relations (`works_at`, `prefers`, `located_in`). | **MISSING** |
| **Fact / atomic-statement nodes** | **Note nodes** (`record_decision` → `overlay.js createNote`) — title+summary+knowledge, embedded (384-float `vec`), this is exactly a "fact" node. | **HAVE** (for hand-authored facts) |
| **Bi-temporal — valid time** | `validFrom` / `validTo` on every note (`overlay.js` createNote, lines ~619-624). `validTo==null` ⇒ current. | **HAVE** |
| **Bi-temporal — transaction time** | `created_at` (always real insertion instant, never backdated) vs backdatable `validFrom`; retrieval exposes BOTH `asOf` (valid-time) and `knownAsOf` (transaction-time). Code comment literally calls this "the Zep gap" being closed (`overlay.js` ~611-617, `routes/graph.js` ~116-121). | **HAVE** |
| **As-of / point-in-time query** | `/search?asOf=T` returns the note current at T; `?knownAsOf=T` recorded-by-T; `?history=1` full timeline; `temporalOk()` window filter (`routes/graph.js` ~264-270). MCP `search_knowledge` exposes `as_of` + `history`. | **HAVE** |
| **Fact invalidation — supersession (non-destructive)** | `supersedeNote(old,new)` (`overlay.js` ~642-663): stamps `validTo` on old = new's `validFrom`, links `supersededBy`/`supersedes` both ways, **never deletes**. Emits `note_superseded`/`note_supersedes` events. `noteChain()` walks oldest→newest. | **HAVE** |
| **Fact invalidation — *contradiction detection*** | Closest is **subsumption** (`judge.js findSubsumedNotes`, cosine ≥ 0.92): a newer note that semantically *covers* an older one auto-retires the older. But that is **similarity-driven, not contradiction-driven** — it fires when notes are *alike*, not when they *conflict*. A new fact that contradicts an old one at moderate cosine (e.g. "lives in Berlin" vs "lives in Paris") is NOT caught. | **PARTIAL** — supersession *mechanism* exists; the contradiction *trigger* is missing. |
| **Dedup of facts** | Dup-cluster detection (`judge.js dupClusters`, cosine ≥ 0.80 union-find) + write-time dup-guard (`pendingDup`, 0.70-0.80 band) + judge consolidation into a keeper. | **HAVE** |
| **Confidence / forgetting** | Decay slow-lane (`isDecayCandidate`: age + opportunity + win-rate gated soft-retire) and reinforce-lane (`computeNoteBoost`) — outcome-grounded, driven by the recall-outcome journal. **Zep has no equivalent**; this is a Zonoid edge, not a gap. | **HAVE (+ surplus)** |
| **Hybrid retrieval — semantic** | Cosine over note `vec` / multi-`vecs` (`scoreHybrid`, `maxCosine`). | **HAVE** |
| **Hybrid retrieval — keyword/BM25** | Lexical token-overlap (`scoreNodeAgainstTokens`) — but as an **either/or fallback** when no vector exists, **not fused** with cosine. No BM25, no RRF. | **PARTIAL** — a lexical signal exists but is not blended. |
| **Hybrid retrieval — graph traversal** | `structBoost` (+0.1 × max neighbor score over DAG deps/context_deps) + `bfsPath` provenance + optional cross-encoder rerank (`routes/graph.js` ~440-472, ~391-431). Graph influences *ranking via boost*, not first-class graph-walk recall. | **PARTIAL** — graph signal present, as a reranker not a retriever. |
| **Episode → fact provenance edge** | `wires_to` on `record_decision` creates a DAG context edge note→task at authoring time; `bfsPath` surfaces the path. | **HAVE** (task-provenance; not yet message-provenance) |

**Net:** 7 HAVE, 1 HAVE-with-surplus, 5 PARTIAL, 2 MISSING. Every "hard temporal" row is HAVE. The
work is concentrated in: **(MISSING)** a distiller and an entity layer; **(PARTIAL→HAVE)** a
contradiction trigger and a fused hybrid-retrieval read path.

## 3. Proposed architecture

Four components, each landing on an existing seam so the task path is never disturbed.

### 3.1 The distiller (session → atomic facts + entities)

A post-session pass — NOT retrieval-time, NOT inline in the hot path. Triggered on session close (or a
`distill_session` MCP call / a follow-up task). Input: the session transcript (already pointed-to by the
task node's `transcript` field). The distiller is an LLM pass (the agent is the intelligence; the
daemon stays dumb — same division as the judge and KB learners) that emits:

- **Atomic facts** → note nodes via the existing `createNote` path. Atomic = one subject-predicate-object
  claim per note ("user prefers squash-merge for orch/attempt branches"), embedded, `validFrom` = the
  fact's event time (parsed from the transcript when stated; else session time), `created_at` = now.
  This reuses `record_decision` semantics wholesale — a distilled fact is just a note the *machine*
  authored instead of the user. `category:"preference"` is set when the fact is a standing user
  preference, so it flows straight into the existing ask-gate corpus (`lib/ask-gate.js`).
- **Entities** → new `entity` node kind (§3.2).
- **Provenance** → an `episode` edge from each distilled fact/entity back to the source (the task node
  and a transcript offset), so a fact is always traceable to the message that produced it. This extends
  `wires_to` from task-provenance to message-provenance.

Distillation is **idempotent per (session, transcript-offset)**: a watermark (mirroring the judge's
`judgedAtEpoch` / cluster-signature pattern) prevents re-distilling the same span. Mem0's
ADD/UPDATE/DELETE/NOOP decision is the reference for the per-fact "is this new, an update, or a dup"
call — but UPDATE routes to `supersedeNote` and dup routes to the existing dup-guard, so we inherit
Zonoid's non-destructive history instead of Mem0's destructive overwrite.

### 3.2 Entity nodes + relationship edges (the wiring)

A new node kind **`entity`** (alongside `task` / `note` / `system`). An entity node is light:
`{ id, kind:'entity', name, type (person|org|place|thing|concept), aliases[], vec, validFrom, validTo,
supersededBy }`. Entities reuse the **same bi-temporal fields as notes** — so entity merge/rename is
just supersession (`supersedeNote` generalised), and "who was the lead on T as-of March" is an as-of
query for free.

Two new edge roles (carried as `kind:'context'` sub-typed by a `relation` field, so the existing
context-edge machinery — weight, judged, structBoost, neighborhood walk — applies unchanged; the daemon
need not learn a new edge kind):

- **entity → note** ("this fact is about this entity"). Lets retrieval pivot: a query mentioning an
  entity pulls every fact wired to it via one graph hop.
- **entity → entity** ("works_at", "prefers", "located_in" — the `relation` field names it). This is the
  Graphiti "fact edge." It is bi-temporal because it is a context edge between two bi-temporal nodes; a
  contradicting relation supersedes the old one (§3.3).

Crucially, an entity is wired to **notes AND tasks**: the same `entity` node that appears in a distilled
preference fact can be wired to a task that touches that entity's subsystem. This is the unification
(§4) — entities are the join key between the conversational graph and the execution graph.

### 3.3 Temporal consistency (contradiction → supersede)

The supersession mechanism is **already correct and non-destructive**; what is missing is the
*contradiction trigger* that fires it for facts. Add a **contradiction check at fact-write time**,
slotting into the same write-time hook that already runs the dup-guard and subsumption in
`record_decision`/`createNote`:

1. On a new fact about entity E, gather **current facts wired to E** (one graph hop — cheap, bounded).
2. Run an LLM contradiction adjudication (or a learned classifier shadow, mirroring `judge.js`'s
   `shadowFields` pattern) over the new fact vs each related current fact. This is the **one LLM call
   Graphiti also pays**; it is off the hot path (write-time, not read-time).
3. On a confirmed temporally-overlapping contradiction, call the existing `supersedeNote(old, new)` —
   `validTo` closes on the old fact at the new fact's `validFrom`, history preserved, as-of retrieval
   recovers the prior belief. No new storage primitive; the trigger is the only new code.

This deliberately **separates the trigger from the mechanism**: subsumption (similarity) and
contradiction (conflict) become two write-time gates that both terminate in the same `supersedeNote`.
Subsumption already exists; contradiction is the gap.

### 3.4 Hybrid retrieval (fuse semantic + lexical + graph traversal)

Two upgrades to `routes/graph.js`, both extending the existing pipeline rather than replacing it:

- **Fuse instead of fall back.** Today `scoreHybrid` is `cosine` *or* `lexical`. Replace with an RRF
  (or convex-blend) of cosine rank and a real BM25 rank over note/entity name+summary, so the keyword
  signal contributes even when a vector exists — matching Graphiti's RRF. The cross-encoder rerank stage
  already present (`ORCH_RERANK`, α-blend) stays as the precision layer on top.
- **Graph traversal as a first-class retriever, not just a boost.** `structBoost` already propagates
  neighbor scores over DAG edges; `expandNeighborhood` (`judge.js`) already does a relevance-decayed
  best-first walk over judged context-edge weights. Promote that walk into the **read path**: from the
  query's seed nodes (DAG anchors + any entity matched by name), expand 1-2 hops along entity↔note /
  entity↔entity edges and fold the reached facts into the candidate set *before* ranking. This is the
  Graphiti "graph traversal" leg — and Zonoid already has the walk implemented, just not wired into
  `/search`.

Net read path becomes: **DAG tier (1.0) → entity-seeded graph expansion → temporal filter (asOf) →
RRF(semantic, BM25) → cross-encoder rerank → structBoost → confidence floor → path provenance** — a
strict superset of today's pipeline.

## 4. The differentiation — one temporal graph, conversation **and** execution

Zep/Graphiti model **conversation only**: their graph is messages → entities → facts. Zonoid's existing
graph models **execution**: tasks, dependencies, decisions, attempts, outcomes, judged edges. The
strategic move is to put **both in the same bi-temporal graph**, joined by entities and by the shared
note substrate — something neither Zep nor Mem0 can do because they have no execution graph to unify
with.

Concretely:

- A distilled conversational fact ("user prefers X") is a note node — the **same kind** the orchestrator
  already reads as Tier-1 task context and as the ask-gate preference corpus. So a fact learned in
  conversation **immediately steers task execution** (preference prediction at the `request_guidance`
  seam) and **shows up in the DAG** with provenance. Zep facts can't do that — they live in a separate
  store with no task graph.
- An `entity` node is the **join key**: the user, a service, a subsystem can each be one entity wired to
  conversational facts *and* to the tasks that act on them. "Show everything we know and everything we've
  done about the auth service" becomes one graph query spanning both halves.
- The temporal substrate is **shared**: as-of retrieval, supersession, decay, the recall-outcome journal
  all already operate over notes; entities and distilled facts inherit them by construction. We are not
  building a second temporal engine — we are pointing the conversational front-end at the one that exists.

**How it plugs in without breaking the task path:**

- **graph-store.js**: `entity` is just another node kind in the event log; `entity_created` joins the
  existing `node_created`/`note_created` switch. No change to task replay.
- **overlay.js**: entities live in a new `overlay.entity_nodes` map parallel to `note_nodes`, reusing
  `supersedeNote`/`noteChain` (generalised to accept either map). Entity↔note/entity↔entity edges are
  `kind:'context'` with a `relation` field — `addDependency` already handles context edges; `relation`
  is additive metadata the blocking/scheduling path ignores.
- **judge.js**: the contradiction trigger is a new write-time gate beside subsumption; the entity-edge
  walk reuses `expandNeighborhood`/`buildContextAdjacency` verbatim. The judge's keep/prune over
  entity-edges is the *same* unverified-context-edge adjudication it already runs — entity edges seed
  weight-0 judged:false and get promoted exactly like autowire edges. **No new judge lane.**
- **routes/graph.js**: retrieval gains an entity-seed expansion step and an RRF fusion, both *additive*
  to the existing tiered pipeline; `task_key`-anchored DAG-tier behavior is untouched, so every existing
  task-context read is byte-for-byte unchanged unless it opts into entity expansion.
- **The task/blocking/readiness path never sees any of this**: entities and facts are context-kind only;
  no `blocking` edge, no readiness gate, no scheduler change. The execution DAG is a strict subgraph.

## 5. Phased build plan

**Phase 0 — measurement harness (prereq, smallest, no engine change).** Wire LoCoMo / LongMemEval as a
bench arm that pre-learns the conversation into the graph at write time and answers QA probes over the
edge-read path (the "our way" approach already noted in the graph; builds on task `/1` which registered
these as bench targets, and on `docs/bench-sdk-design.md`). This is the scoreboard — it must exist before
any phase claims a number. **Move-the-needle test:** establishes the baseline LoCoMo/LME score with
*today's* note substrate + hand-authored facts.

**Phase 1 — the distiller alone (smallest increment that moves the bench).** Add `distill_session`:
LLM-extract atomic facts from a transcript → `createNote` (no entities yet, no contradiction trigger).
Facts are notes; retrieval is today's pipeline. This *alone* should lift LoCoMo/LME because the bench's
QA probes now hit distilled atomic facts instead of raw chunks — the single highest-leverage change, and
it touches **zero** existing engine code (pure additive write path). Mem0's ADD/UPDATE/NOOP is the
reference for the per-fact dedup decision; UPDATE → existing `supersedeNote`, dup → existing dup-guard.
**Gate to Phase 2:** measured LoCoMo/LME delta vs Phase-0 baseline.

**Phase 2 — entity layer + contradiction trigger.** Introduce the `entity` node kind, entity↔note /
entity↔entity edges, and the write-time contradiction gate (→ `supersedeNote`). Now multi-hop questions
("where does X work *now* vs *then*") and contradiction-heavy LongMemEval categories (knowledge updates,
temporal reasoning) become answerable. This is where Zonoid reaches Graphiti **feature parity** on the
conversational axis.

**Phase 3 — hybrid-retrieval fusion.** Replace `scoreHybrid` either/or with RRF(semantic, BM25); promote
`expandNeighborhood` into the read path as entity-seeded graph traversal. Precision/recall upgrade across
all categories; closes the last PARTIAL row.

**Phase 4 — the unification payoff (the differentiator, not a bench item).** Wire entities across the
conversation/execution boundary: the same entity node bridges distilled facts and the tasks that touch
that subsystem. Surface "everything known + everything done about E" as one query. This is the strategic
moat — it doesn't move LoCoMo (LoCoMo is conversation-only) but it is the thing **no competitor can copy
without a task graph**, and it compounds the outcome-grounded decay/reinforce edge Zonoid already has.

**Ordering rationale:** Phases 0-1 are cheap, additive, and independently bench-moving; ship them first
and let the number justify Phase 2-3 engine work. Phase 4 is the bet — gated behind parity so we don't
spend the differentiation budget before the table-stakes are in.
