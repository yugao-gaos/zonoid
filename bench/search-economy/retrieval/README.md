# Search-economy retrieval bench (Phase 1)

Measures the **token economy of context assembly** for code-navigation queries over the
zonoid repo: for the *same* code-nav query, how many context tokens does each retrieval
mechanism spend, and how many of the ground-truth symbols does that context actually
surface? The headline metric is **tokens-per-correct-symbol** — cost normalized by useful
recall, so a cheap-but-empty bundle and an expensive-but-complete bundle are compared on
equal footing.

This is the **retrieval-first** slice of the 3-arm plan. It runs **now, in pure Node**.
The `graphify` (AST subgraph) and `terminal-bench` (end-to-end) arms are **scaffolded but
deferred** — they need Python, which is not installed here.

## Run it

```bash
node bench/search-economy/retrieval/run.js
```

Writes one JSON line per `(query, arm)` to `results.jsonl` and prints a per-arm summary
table (mean tokens, mean recall, mean precision, mean tokens-per-correct-symbol).

Environment overrides (all optional):

- `ORCH_DAEMON_URL` — daemon base URL for the subconscious arm (default `http://localhost:8787`)
- `ORCH_SEARCH_WORKSPACE` — workspace passed to `/search` (default `D:\zonoid`)

## Files

| File          | Purpose |
|---------------|---------|
| `corpus.json` | 13 code-navigation queries with **real, verified** ground-truth files + symbols (derived by reading the actual `lib/`, `routes/`, `mcp-graph.js` source). Spans easy single-file lookups (q01–q07) to multi-hop call/import chains (q08–q13). |
| `arms.js`     | `assembleContext(query, armName)` → `{ bundleText, tokens, hitSymbols }`. Arm registry with two live arms + two deferred stubs. |
| `tokens.js`   | Token estimator (chars/4). Pluggable: if a real tokenizer is wired in via `{ tokenizer }`, it is used instead. No hard dependency. |
| `run.js`      | Driver: assemble × score × write `results.jsonl` × print summary. |
| `results.jsonl` | Per-`(query, arm)` rows (regenerated each run). |

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

## Metrics (per query × arm)

- `tokens` — context bundle size (via `tokens.js`).
- `recall` = |hitSymbols ∩ relevant_symbols| / |relevant_symbols|
- `precision` = |hitSymbols ∩ relevant_symbols| / |hitSymbols| (0 if the bundle has no
  identifiers). Precision is intentionally low for both arms — bundles contain *many*
  incidental identifiers; precision here is a denominator sanity check, not a headline.
- `tokens_per_correct_symbol` = tokens / correct (null when 0 correct) — **the headline:
  cost per unit of useful recall.**

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
