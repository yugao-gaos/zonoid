# Search-economy retrieval bench (Phase 1 + 1b)

Measures the **token economy of context assembly** for code-navigation queries over the
zonoid repo: for the *same* code-nav query, how many context tokens does each retrieval
mechanism spend, and how many of the ground-truth symbols does that context actually
surface? The headline metric is **tokens-per-correct-symbol** — cost normalized by useful
recall, so a cheap-but-empty bundle and an expensive-but-complete bundle are compared on
equal footing.

This is the **retrieval-first** slice of the plan. It runs **now, in pure Node**, with
**three live arms** (`naive`, `subconscious`, `codebase-memory`). The `graphify` (AST
subgraph) and `terminal-bench` (end-to-end) arms are **scaffolded but deferred** — they
need Python, which is not installed here.

**Phase 1b result:** `codebase-memory` wins — **2.75× better token economy than the grep
baseline** (1022 vs 2810 pooled tokens per correct symbol) on 62% of the tokens. See
[`../REPORT-phase1b.md`](../REPORT-phase1b.md).

## Run it

```bash
node bench/search-economy/retrieval/run.js     # measure -> results.jsonl + summary table
node bench/search-economy/retrieval/report.js  # render  -> ../REPORT-phase1b.md
```

`run.js` writes one JSON line per `(query, arm)` to `results.jsonl` and prints a per-arm
summary. `report.js` regenerates the combined cross-arm markdown report from that file —
the report is **generated, never hand-edited**, so it cannot drift from the measurements.

Environment overrides (all optional):

- `ORCH_DAEMON_URL` — daemon base URL for the subconscious arm (default `http://localhost:8787`)
- `ORCH_SEARCH_WORKSPACE` — workspace passed to `/search` (default `D:\zonoid`)
- `ORCH_CMM_BIN` — path to the `codebase-memory-mcp` executable (default: the installed
  location under `%LOCALAPPDATA%`, then `PATH`)
- `ORCH_CMM_PROJECT` — force a specific indexed project name instead of auto-resolving
  the one whose root matches the repo

## Files

| File          | Purpose |
|---------------|---------|
| `corpus.json` | 13 code-navigation queries with **real, verified** ground-truth files + symbols (derived by reading the actual `lib/`, `routes/`, `mcp-graph.js` source). Spans easy single-file lookups (q01–q07) to multi-hop call/import chains (q08–q13). |
| `arms.js`     | `assembleContext(query, armName)` → `{ bundleText, tokens, hitSymbols }`. Arm registry with three live arms + two deferred stubs. |
| `tokens.js`   | Token estimator (chars/4). Pluggable: if a real tokenizer is wired in via `{ tokenizer }`, it is used instead. No hard dependency. |
| `run.js`      | Driver: assemble × score × write `results.jsonl` × print summary. |
| `report.js`   | Renders `../REPORT-phase1b.md` from `results.jsonl`. |
| `results.jsonl` | Per-`(query, arm)` rows (regenerated each run). |
| `../adapters/codebase-memory-mcp.js` | Thin adapter over the `codebase-memory-mcp` binary (project resolution + `search_graph` / `get_code_snippet` / `query_graph`). Bench-agnostic. |

## Arms

### `naive` (live)
Greps the repo for the query's key terms (ripgrep, falling back to `git grep`), ranks
candidate files by how many distinct query terms hit them, then reads **windows around the
actual term matches** in the top files (so mid-file symbols are surfaced, not just file
heads), capped at ~12k chars total. Generated/state dirs (`.graph/`, `data/`, `node_modules/`,
`public/`) are excluded so the char budget isn't wasted on daemon-state JSON. This is the
"just assemble raw source" baseline. Its characteristic weakness — visible in the results —
is that *generic* query terms ("git", "task", "branch") rank `daemon.js`/`mcp-core.js`/docs
ahead of the precise definition file, so some deep-call-chain queries miss; that is a true
property of grep+read, which is exactly what the bench is here to quantify.

### `subconscious` (live)
Queries the running daemon's agentic/RAG memory bundle via `GET /search?workspace=…&q=…&k=8`
(the same path `search_knowledge` uses) and assembles the `title + summary` of each recalled
note in rank order. Measures the token economy of the **subconscious memory substrate**:
typically a *much* smaller bundle than naive (it returns distilled note summaries, not raw
files).

> **Onboarding caveat (important).** The live KB currently holds **orchestrator
> self-knowledge notes** (decisions, findings about the daemon itself), **not chunks of the
> repo's source code**. So against a code-symbol-keyed corpus the subconscious arm recalls
> few of the ground-truth symbols and its mean recall is near zero — **this is expected**,
> not a harness bug. The proper setup is to onboard the repo's code into the KB first:
>
> ```bash
> node scripts/onboard-loop.js --repo <repo-path> --workspace <repo-path>
> ```
>
> Phase 1 deliberately does **not** block on a long onboarding run. It exercises the arm
> end-to-end against the current KB so the harness is proven correct; the *win* (subconscious
> beating naive on tokens-per-correct-symbol) is a Phase-1.5 result that lands once code is
> onboarded. **Harness correctness is the Phase-1 deliverable, not the win.**

### `codebase-memory` (live, Phase 1b)
Queries a **precomputed code graph** built by [`codebase-memory-mcp`](https://github.com/)
v0.8.1: `search_graph` ranks symbol nodes (Function/Class/Variable/Route) for the query,
then `get_code_snippet` pulls **the full source of each matched symbol**. So the bundle is
a list of whole definitions, not byte windows (naive) and not note prose (subconscious).

Reached through `../adapters/codebase-memory-mcp.js`, which drives the binary's
single-shot `codebase-memory-mcp cli <tool> '<json>'` mode — one process per call, no MCP
stdio session. The indexed project is auto-resolved by matching an indexed `root_path`
against the repo root.

**Two deliberate fairness decisions**, both symmetric with the naive arm:

1. **Same query preprocessing.** `search_graph` is BM25 over symbol *names*, and v0.8.1
   silently ignores its `search_mode` argument (it always runs bm25 — verified). Handed a
   raw sentence, stopwords like "which"/"what"/"does" dominate scoring and rank `Route`
   and doc nodes above the real definition. The arm therefore searches
   `queryTerms(query)` — **the identical stopword-stripped term list the naive arm greps
   for**. Neither arm sees the raw sentence.
2. **Same retrieval scope.** Both arms filter candidates through the one shared
   `isExcludedPath()` predicate (`node_modules/`, `.git/`, `.graph/`, `data/`, `public/`,
   and `bench/` — the harness's own tree). Neither arm can spend budget on generated
   daemon state or on the bench's own fixtures.

Nodes with no `file_path` (Route pseudo-nodes) are dropped: they carry no source, so they
would consume rank depth without contributing to the bundle.

**Known asymmetry (not corrected — deliberately).** `codebase-memory` indexes the repo
polyglot (it surfaces symbols from `test/smoke.sh`, for example), while `naive` greps only
`*.{js,json,md}`. Narrowing the graph arm to `.js` would tune it to this corpus rather
than measure it, so the wider scope stands and is reported here instead. It costs the
graph arm rank depth on some queries; it never helps it, since every ground-truth symbol
is in a `.js` file.

**Where it fails.** Its one zero-recall query, q10 ("…**acquiring** and **releasing** its
per-path lease" → wants `acquireLease`, `releaseLease`), is the failure mode in miniature:
BM25 over symbol names does **no stemming and no semantics**, so the gerunds never reach
the infinitive symbol names, and it returns `leasePath` instead. The arm is excellent when
the query's nouns *are* the symbol names (q01/q03/q06/q08/q11 → perfect recall) and weak
when the query describes behaviour in natural-language morphology (q05/q10/q12). A
stemming or embedding pass over the query is the obvious next lever.

## Metrics (per query × arm)

- `tokens` — context bundle size (via `tokens.js`).
- `recall` = |hitSymbols ∩ relevant_symbols| / |relevant_symbols|
- `precision` = |hitSymbols ∩ relevant_symbols| / |hitSymbols| (0 if the bundle has no
  identifiers). Precision is intentionally low for both arms — bundles contain *many*
  incidental identifiers; precision here is a denominator sanity check, not a headline.
- `tokens_per_correct_symbol` = tokens / correct (null when 0 correct) — per-query cost
  per unit of useful recall.
- **`POOLED tok/correct` = Σtokens / Σcorrect across all queries — the headline.**
  Prefer it over the *mean* of the per-query ratios: that mean can only be taken over
  queries scoring ≥1 correct symbol, so an arm that fails a query outright gets its most
  expensive failure **excluded from its own average** — i.e. it is rewarded for failing.
  Pooling charges every query's tokens. `run.js` prints both columns; the pooled one is
  what `REPORT-phase1b.md` leads with.

### Reproducibility caveat
`naive` and `codebase-memory` read fixed substrates (the checkout, a built index) and are
deterministic run-to-run. **`subconscious` is not**: it queries the *live* daemon KB, which
other agents write to continuously, so its token and recall figures drift by a few percent
between runs. Treat its row as a moving snapshot, not a fixed measurement.

Symbol matching is **case-insensitive, whole-token**: each arm extracts identifier-like
tokens from its bundle; `run.js` lowercases both sides and intersects as sets.

## Extending (the registry is the only seam)

`arms.js` exposes an `ARMS` registry. To add an arm, add one entry:

```js
ARMS['my-arm'] = {
  implemented: true,
  describe: 'what it does',
  run: (query, counter, opts) => ({ bundleText, tokens: counter(bundleText), hitSymbols }),
};
```

`run.js` automatically runs every arm whose `implemented` is `true` and lists the rest as
deferred. No driver changes needed.

## TODO: graphify + terminal-bench arms (deferred, need Python)

Both are registered in `arms.js` as `implemented: false` stubs so they slot in without a
refactor:

- **`graphify`** — assemble context from an **AST subgraph** (def/ref/call/import edges)
  rather than text grep or note summaries. Different substrate (code structure), same fair
  unit (same code-nav query). Needs the Python graphify toolchain.
- **`terminal-bench`** — promote these queries to **end-to-end Terminal-Bench tasks** and
  measure full-task token economy, not just retrieval. Needs the Python Terminal-Bench
  harness.

When Python is available: implement each arm's `run()` to produce `{ bundleText, tokens,
hitSymbols }`, flip `implemented: true`, and re-run `run.js` — the 2×2 (query × mechanism)
matrix extends to 4 arms automatically.
