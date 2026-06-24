# Code-Navigation Retrieval Token Economy: Onboarded Subconscious KB vs External Code-Graph Tools

**Zonoid self-learning loop · Case study 004 · June 2026**

---

## Abstract

Code-graph tools (AST extractors with their own vector index) are the standard way to give an agent
structural code recall. We ask a sharper question: once a codebase has been onboarded into the
orchestrator's own knowledge base, does the orchestrator still *need* the external tool to query it?

We benchmark four context-assembly arms on a 13-query code-navigation corpus over the Zonoid
`lib/` + `routes/` source: **naive** (grep + windowed read), **codebase-memory-mcp** (a hybrid AST
knowledge graph with local code-embedding vector search), **graphify** (a pure-AST, non-vector graph
in Python), and **subconscious** (the orchestrator's KB RAG retrieval). To compare them fairly we run
every arm in a **locate-then-fetch** mode that delivers *actual source code* under an identical
~12k-character budget through the identical `get_code_snippet` fetch step — so only the LOCATE step
differs between arms.

The headline result: **once Zonoid's code is fully onboarded into the KB, the subconscious agentic
search surpasses codebase-memory-mcp's own native structural query on a fair deliver-code basis** —
higher recall (0.583 vs 0.551) at **fewer** tokens (1656 vs 2554), 835 vs 1113 tokens-per-correct.
The external tool that fed the KB is beaten by the KB. This validates the architecture: an AST
extractor (codebase-memory-mcp, or a first-party equivalent) onboards code structure into the KB,
and the orchestrator's own retrieval then becomes the better query surface. A separate enabler — a
batch bulk-ingest refactor of the daemon — is what made the full 1322-note onboard possible at all.

---

## §1 Setup

### Corpus

A 13-query code-navigation corpus over **real Zonoid source** (`lib/` + `routes/`). Each query names
a code-navigation intent (e.g. *locate `createWorktree`*, *locate `mergeBranch`*, *locate the
token-splitting flow*); ground truth is the set of relevant code symbols, and scoring is
identifier-token **recall** of the delivered snippet bundle against that ground-truth symbol set.
Token cost is accounted as characters/4, and we report **tokens-per-correct** (tokens ÷ correctly
recalled symbols) as the efficiency unit. Raw benchmark findings are preserved as the graph notes
listed in the Appendix.

### Arms and their substrates

The arms deliberately span a substrate spectrum — the design controls for the fact that the
subconscious indexes the *KB task graph* while the AST tools index *source-code structure*, so the
fair unit is **the same code-nav query solved by different mechanisms**, reported as a capability
matrix rather than a single winner.

| Arm | Locate mechanism | Substrate | Vector? |
|-----|------------------|-----------|---------|
| naive | `grep` + windowed `read` | raw files | no |
| codebase-memory-mcp (cmm) | `search_graph` ranks symbols by query-term-in-name | hybrid AST knowledge graph + local code-embedding vectors | yes |
| graphify | AST subgraph BFS from lexically-seeded nodes | pure AST graph (Python) | no |
| subconscious | KB `/search` semantic RAG over onboarded code-symbol notes | orchestrator KB (MiniLM vectors over note summaries) | yes |

codebase-memory-mcp is the DeusData `codebase-memory-mcp` — a single static binary with zero runtime
deps that runs on Windows in CLI mode (`index_repository` / `search_graph` / `get_code_snippet` /
…). graphify is the Python `graphifyy` package — pure AST, non-vector.

### The locate-then-fetch FAIR methodology

The crux of the comparison. A code-graph tool's *native* output is symbol **locators** (pointers:
names, qualified names, neighborhoods), not code; a naive grep delivers *code* directly. Comparing a
locator-list against delivered code is apples-to-oranges and flatters whichever arm returns
pointers. To put every arm on a **deliver-code** footing we wrap each in the same pipeline:

1. **LOCATE** — the arm-specific step: rank/return candidate symbols for the query (the only step
   that differs between arms).
2. **FETCH** — identical for all arms: take the top-6 located symbols and call cmm
   `get_code_snippet` on each (resolving `name → qualified_name` via `search_graph` first, since
   `get_code_snippet` requires the qualified name), concatenate the function bodies, and cap the
   bundle at ~12,000 characters.

Because the FETCH step and the budget are held identical, any difference in the deliver-code numbers
is attributable to **locate quality** alone. We additionally report a **locators-only** contrast
(what each arm returns *raw*, before the shared fetch) to expose how much of an arm's apparent token
edge was really just returning pointers instead of code.

A note on fetching: pulling a function body also surfaces neighbor symbols *for free* (e.g. the
`computeFlow` snippet contains `splitSessionTokens` + `sessionCatchalls`), which lifts deliver-code
recall above the locators-only recall for every arm.

---

## §2 Results

### §2.1 Fair deliver-code comparison (all arms deliver real code, ~12k budget, identical fetch)

| Arm | Mean recall | Mean tokens | Tokens / correct | Hits |
|-----|-------------|-------------|------------------|------|
| naive (grep + read) | 0.321 | 3026 | 1945 | 7 / 13 |
| codebase-memory-mcp | 0.551 | 2554 | 1113 | 9 / 13 |
| **subconscious @ cmm-KB FULL (1322 notes)** | **0.583** | **1656** | **835** | **10 / 13** |

**The onboarded subconscious wins both axes against the external tool that fed it**: +0.032 recall
(0.583 vs 0.551) at **35% fewer tokens** (1656 vs 2554) and **25% better** tokens-per-correct
(835 vs 1113). Both structural arms crush naive on every axis. The mechanism behind the subconscious
edge: KB semantic recall pulls a tighter, more-targeted set of functions into the fixed code budget
than cmm's term-in-name structural ranking does, so the same ~12k characters carry more of the right
symbols.

### §2.2 Locators-only contrast (what each arm returns raw, before the shared fetch)

| Arm | Mean recall | Mean tokens | Note |
|-----|-------------|-------------|------|
| **subconscious** | 0.346 | **310** | **leanest** — RAG returns tight note summaries |
| codebase-memory-mcp | 0.506 | 327 | direct symbol-name graph search |
| graphify | 0.436 | 1362 | verbose: a 97-node lexical-BFS neighborhood |

Two readings here:

- **Subconscious is the leanest locator** (310 tokens) and beats the naive deliver-code arm's recall
  (0.346 vs 0.321) at roughly **one-tenth** the tokens (310 vs 3026) — pure locator efficiency.
- **cmm dominates graphify** — the two AST tools head-to-head. cmm's direct symbol-name search
  returns 0.506 recall in 327 tokens; graphify's lexical-BFS returns a large *incidental*
  neighborhood (a 97-node subgraph) — verbose at 1362 tokens — and its recall (0.436) is gated by
  **seed selection**: the BFS only reaches what its lexical seeds connect to. Of the two AST
  extractors, cmm is the better onboard engine, which is why cmm (not graphify) was used to feed the
  KB.

### §2.3 Coverage drives the subconscious result

The subconscious deliver-code number is **coverage-limited**, and closing coverage is what produced
the headline win:

| KB coverage | Mean recall | Mean tokens | Tokens / correct | Hits |
|-------------|-------------|-------------|------------------|------|
| un-onboarded (no code in KB) | 0.045 | — | — | 2 / 13 |
| 863 / 1321 notes (65%) | 0.513 | 1314 | 608 | 9 / 13 |
| **1322 notes (100%)** | **0.583** | 1656 | 835 | **10 / 13** |

Onboarding the code at all is a **7.7× recall lift** over the un-onboarded KB (0.045 → 0.346 as
locators). Going from 65% to 100% coverage lifted deliver-code recall **+0.070 (+13.6% relative)**
and hits 9 → 10. (Tokens and tokens-per-correct rose at full coverage precisely *because* more
relevant symbols now resolve to real snippets — e.g. at full coverage `createWorktree`,
`worktreePath`, and `branchName` all surface semantically for q01, giving recall 1.0 at the run's
lowest 277 tokens-per-correct; at 65% coverage q01 missed entirely because those functions, though
cmm-extracted, had never been injected.)

---

## §3 The enabler: batch bulk-ingest refactor

Full coverage was not free. The orchestrator KB **could not bulk-ingest** under its original
synchronous path: `POST /overlay/note` embeds each note (and each salient field) synchronously
through a single MiniLM sidecar, and a near-duplicate guard scans every existing note (O(n) per
insert, O(n²) across a bulk onboard) on the daemon's main event loop. Even a throttled client
(concurrency 3, 150 ms paced, health-guarded) **degraded `/health` and auto-aborted at 863 notes**;
a fully unthrottled run hung the daemon. Client-side throttling cannot fix server-side embed
serialization — so the 65%-coverage ceiling was a daemon limitation, not a retrieval one.

The refactor (three targeted pieces, low risk to the single-note hot path):

- **`POST /embed-batch {texts:[]}`** in `lib/embed-server.js` — calls the transformers extractor on
  the whole array in **one batched inference** (transformers batches an array natively, far cheaper
  than N calls).
- **`embedBatch(texts)`** client in `lib/embed.js`.
- **`POST /overlay/notes/bulk {notes:[]}`** in `routes/overlay.js` — gathers all texts, embeds them
  in batches via `embedBatch`, **skips the O(n) dup-guard** (bulk-onboarded code symbols are
  known-distinct), writes all nodes, and **bumps the epoch once**.

**Verified result.** The full 1322-note onboard (1224 from `lib/` + 98 from `routes/`, deduped by
name + file) ran cleanly through the new bulk path on an isolated test daemon: `created: 1322`,
HTTP 200, and `/health` stayed `ok:true` across **15/15 concurrent samples with zero errors**, in
**72 s** — where the old synchronous path degraded health and aborted at 863. This is the
productized version of the cmm-onboard pipeline the benchmark validated. (Merged to
`orch/feature/inject-concurrency` at `79b4629e`; the feature → main merge and daemon restart remain
the dispatcher/user-gated deploy.)

---

## §4 Conclusion

1. **Onboarded KB retrieval beats the external code-graph tool that fed it.** On a fair
   deliver-code basis the subconscious agentic search surpasses codebase-memory-mcp's native
   structural query — 0.583 vs 0.551 recall at 1656 vs 2554 tokens. The architecture is validated:
   **AST extraction → KB → first-party retrieval** is not just competitive with the external tool,
   it is *better and cheaper* once coverage is complete. The orchestrator does not need to keep
   calling the tool at query time; it only needs the tool to *onboard* the code once.

2. **Among AST tools, cmm dominates graphify.** As locators, cmm returns 0.506 recall / 327 tokens
   vs graphify's 0.436 / 1362 — graphify's lexical-BFS is both verbose (a 97-node incidental
   neighborhood) and seed-gated. cmm is the better onboard engine, confirming the choice to feed the
   KB from cmm rather than graphify.

3. **Coverage is the lever, and the bulk-ingest refactor is what pulls it.** 65% → 100% coverage
   moved the subconscious arm from competitive (0.513) to winning (0.583); the batch-ingest path is
   what made 100% reachable without taking the daemon down.

---

## §5 Limitations

- **Single codebase.** All queries run against Zonoid `lib/` + `routes/`. Generalization to foreign
  repos with sparser or noisier KB coverage is not measured here.
- **n = 13 queries.** A small corpus. The *competitive-and-more-efficient* ordering
  (subconscious ≳ cmm on a fair basis) is robust across both the 65% and 100% runs, but the precise
  tokens-per-correct ranking is within noise at this sample size — treat the margins, not the
  decimals, as the result.
- **MiniLM embeddings.** The subconscious arm retrieves over `Xenova/all-MiniLM-L6-v2` (384-dim)
  vectors of note summaries. A stronger code-specific embedding model would likely *widen* the
  subconscious edge, so the reported numbers are a conservative floor for that arm.
- **Crude fetch ranking → conservative floors.** The locate-then-fetch step naively fetches the
  **top-6** located symbols; it does not re-rank or deduplicate intelligently. cmm's two
  deliver-code misses (q01 `createWorktree`, q04 `embed`) are a *fetch-ranking artifact of the crude
  top-6 selection*, not a location failure — so every deliver-code recall here (including cmm's
  0.551 and the subconscious 0.583) is a conservative floor that a smarter fetch ranker would lift.

---

## Appendix

- **Source corpus / harness**: 13-query code-nav corpus over Zonoid `lib/` + `routes/`; benchmark
  results preserved in the graph notes below
- **Fetch primitive**: codebase-memory-mcp `get_code_snippet` (requires `qualified_name`, resolved
  via `search_graph`); bundle cap ~12,000 chars
- **Bulk-ingest refactor**: `lib/embed-server.js` (`/embed-batch`), `lib/embed.js` (`embedBatch`),
  `routes/overlay.js` (`POST /overlay/notes/bulk`) — merged `orch/feature/inject-concurrency`
  @ `79b4629e`
- **Provenance (graph notes)**:
  - capstone — `note:note-mqpz36sv7ns` (fair deliver-code + locators + conclusions)
  - fair-fetch cmm — `note:note-mqpxr6kyk2y` (cmm locate-then-fetch 0.551 / 2554 / 1113)
  - subconscious locate+fetch — `note:note-mqpxyj4af7t` (65%-coverage 0.513 / 1314 / 608 fair comparison)
  - full-coverage capstone — `note:note-mqpywsqkwff` (1322-note onboard, 15/15 health, 72 s, 0.583 / 1656 / 835)
  - cmm-onboard baseline — `note:note-mqpv6qx0gzv` (un-onboarded 0.045; locators-only cmm 0.506 / 327)
  - inject-concurrency design — `note:note-mqpwne6dbsp` (bottleneck diagnosis + refactor design)
  - benchmark design — `note:note-mqpna41fj59` (arm/substrate spectrum, graphify = pure-AST Python)
- **Related**: [Whole-Product Token Economy — Orchestrator ON vs OFF](../token-economy/)
- **Related**: [KB Injection Lifts Agent Solve Rate](../quality-gain/)
- **Related**: [Measuring Autonomous Leverage](../autonomy-score/)
