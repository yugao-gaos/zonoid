# Search-economy retrieval bench — Phase 1b combined comparison

**Generated** by `node bench/search-economy/retrieval/report.js` from
`retrieval/results.jsonl`. Do not hand-edit — re-run `run.js` then `report.js`.

Corpus: **13 code-navigation queries** over the zonoid repo
(`corpus.json` v1). Arms: **3** live.

The question: for the same code-nav query, how many context tokens does each
retrieval substrate spend, and how much of the ground-truth answer does that
context actually contain? Headline is **pooled tokens-per-correct-symbol**.

## Headline

| arm | n | mean tokens | mean recall | perfect | zero-recall | correct/total | POOLED tok/correct |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `naive` | 13 | 3025.7 | 0.321 | 2/13 | 6/13 | 14/41 | 2809.6 |
| `subconscious` | 13 | 1047.2 | 0.045 | 0/13 | 11/13 | 2/41 | 6806.5 |
| `codebase-memory` | 13 | 1887.7 | 0.641 | 5/13 | 1/13 | 24/41 | 1022.5 |

**Winner: `codebase-memory`** — 2.75x better token economy than the
`naive` grep baseline (1022.5 vs 2809.6 tokens per
correct symbol), while spending only 62% of naive's total tokens and
recovering 24 ground-truth symbols to naive's 14.

> **Why pooled, not the per-query mean.** A per-query `tokens/correct` mean can only
> be averaged over queries that scored at least one correct symbol, so an arm that
> fails a query outright has its most expensive failure *excluded* from its own
> average. Pooling (`sum(tokens) / sum(correct)`) charges every query. `run.js`
> prints both; this report leads with the pooled figure.

## Per-query detail

Each cell is `tokens` / `correct-of-relevant`. Bold = every ground-truth symbol found.

| query | intent | `naive` | `subconscious` | `codebase-memory` |
| :--- | :--- | ---: | ---: | ---: |
| q01 | single-file lookup | 3026t · 0/3 | 1128t · 0/3 | **1068t · 3/3** |
| q02 | single-file lookup | 3020t · 2/4 | 1022t · 0/4 | 1104t · 1/4 |
| q03 | single-file lookup | 3027t · 0/2 | 941t · 0/2 | **2575t · 2/2** |
| q04 | single-file lookup | **3028t · 3/3** | 1094t · 1/3 | 1534t · 2/3 |
| q05 | single-file lookup | 3024t · 1/3 | 1036t · 0/3 | 2916t · 1/3 |
| q06 | single-file lookup | **3039t · 3/3** | 963t · 0/3 | **952t · 3/3** |
| q07 | single-file lookup | 3025t · 3/4 | 1051t · 0/4 | 2039t · 3/4 |
| q08 | multi-hop | 3022t · 0/2 | 1131t · 0/2 | **866t · 2/2** |
| q09 | multi-hop | 3027t · 1/4 | 1061t · 1/4 | 3157t · 3/4 |
| q10 | multi-hop within git.js | 3023t · 0/4 | 1041t · 0/4 | 1692t · 0/4 |
| q11 | multi-hop | 3023t · 0/2 | 1022t · 0/2 | **2187t · 2/2** |
| q12 | multi-hop | 3027t · 0/4 | 1115t · 0/4 | 3080t · 1/4 |
| q13 | multi-hop | 3023t · 1/3 | 1008t · 0/3 | 1370t · 1/3 |

## Where each arm loses

- `naive` — zero-recall on q01, q03, q08, q10, q11, q12
- `subconscious` — zero-recall on q01, q02, q03, q05, q06, q07, q08, q10, q11, q12, q13
- `codebase-memory` — zero-recall on q10

