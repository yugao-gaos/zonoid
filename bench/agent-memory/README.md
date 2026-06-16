# Agent-Memory Benchmark

"Their test, our DAG read" — runs LoCoMo and LongMemEval QA probes through
three arms: Zonoid's DAG-read pipeline (our-way), retrieval-time search
(search), and a no-memory floor (cold).

---

## What the bench measures

Standard memory-QA benchmarks (LoCoMo, LongMemEval) ask: given a long
multi-session conversation, can the system answer a question that requires
remembering a fact from a specific session?

This harness tests Zonoid's approach against those same questions:

1. **our-way** (DAG read — the headline): sessions are ingested as note nodes;
   a blind LLM judge selects which sessions contain the evidence (no gold
   answer shown); only those sessions become context edges on the probe task;
   the answer is read from `GET /task/context`. This is the Zonoid lifecycle
   end-to-end.

2. **search** (retrieval-time control): same ingested graph, same question —
   `GET /search?q=<question>` top-k — then answer. The standard RAG-memory
   baseline for an apples-to-apples comparison.

3. **cold** (floor / rigging guard): answer with NO memory. If the floor
   matches the memory arms, the probe was answerable from world knowledge
   and the result is contaminated.

Competitor bars for reference (LongMemEval, Wu et al. 2024 Table 2):
- Mem0: 92.5% (Oracle) / 94.4% (S)
- Zep:  91.6% (Oracle) / 94.8% (S)

---

## Datasets

### LoCoMo

- Paper: "LoCoMo: Large-Scale Multi-Session Conversations" (Maharana et al., 2024)
  https://arxiv.org/abs/2402.17753
- Source: https://github.com/snap-research/locomo
- License: **CC BY-NC 4.0** — non-commercial use only.
- File needed: `locomo10.json`
- **Data files MUST NOT be committed to this repo.**
  Download from the source and point `--data-dir` at the containing directory.

### LongMemEval

- Paper: "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory"
  (Wu et al., 2024)  https://arxiv.org/abs/2410.10813
- Source: https://github.com/xiaowu0162/LongMemEval
- License: **MIT** — free use and redistribution with attribution.
- Files needed: `longmemeval_oracle.json`, `longmemeval_s.json`, `longmemeval_m.json`
- Data files are NOT committed; download from the source and place in `--data-dir`.

Only the hand-authored synthetic fixtures in `bench/agent-memory/fixtures/` are
committed to the repo.

---

## Prerequisites

### 1. Zonoid daemon

The daemon must be running and the embedding model warm before any bench run.
Start it from the repo root:

```
node daemon.js
```

The default URL is `http://localhost:8787`. Pass `--daemon <url>` to override.

The first `/search` call lazy-loads the local embedding model (~10-90 s).
`run.py` calls `warm_up()` once before the eval loop so no single probe eats
the cold-start latency.

### 2. Python runtime

This harness uses the **embeddable Python 3.12** runtime — stdlib only, no pip,
no site-packages. Always invoke with the full path:

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe <script>
```

See runtime note `note-mqgz977tbqe` for background. The harness never calls
`pip install` and will fail if you try to use a virtualenv that installs
third-party packages.

### 3. Claude CLI

The `claude` CLI must be on PATH (or set `ZONOID_BENCH_CLAUDE` to its absolute
path). The blind judge and answerer are headless `claude -p` calls. On Windows
`claude` is a `.cmd` shim; `shutil.which` resolves it correctly via PATHEXT.

Auth: `ANTHROPIC_API_KEY` or the CLI's own login (`claude login`).

---

## Acceptance smoke test

Before running the full bench, run the acceptance smoke test. It uses a
self-contained toy conversation (no licensed data required) and asserts all
four key properties of the pipeline end-to-end:

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/smoke.py
```

Expected output:

```
[smoke] checking daemon reachability + embedder warm-up ...
[smoke] daemon reachable + embedder warm-up OK
[smoke] workspace root: ...

[smoke] ingesting toy conversation (3 sessions) ...

[A] ConversationIngester - one note per session
  [PASS] [A] ingest: 1 note per session  - sessions=3, notes_written=3, all_covered=True
[smoke] 3 session candidate(s): sid=0, sid=1, sid=2

[B+C] our-way arm (DAG read: blind keep -> /task/context -> answer) ...
  [PASS] [B-i] our-way: /task/context includes evidence session (idx=1)
  [PASS] [B-ii] our-way: /task/context excludes distractor session (idx=2)
  [PASS] [C] our-way: answer contains the planted fact ('37')

[D] cold arm (floor - must NOT contain '37') ...
  [PASS] [D] cold: rigging guard - answer does NOT contain '37' (no-memory floor)

============================================================
OVERALL: PASS
============================================================
```

If the daemon is down, the smoke test exits with code 2 and prints
`DAEMON UNREACHABLE`. Do not fake a pass; fix the daemon first.

---

## Run procedure

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/run.py \
    --benchmark locomo \
    --data-dir  <abs-path-to-dir-containing-locomo10.json> \
    --workspace-root <abs-path-for-per-conv-workspaces> \
    --arms our-way,search,cold \
    --daemon http://localhost:8787 \
    --model sonnet \
    --limit 3
```

### Key arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--benchmark` | `locomo` | `locomo`, `longmemeval`, `longmemeval-oracle`, `longmemeval-s`, `longmemeval-m` |
| `--data-dir` | required | Directory containing dataset JSON files |
| `--arms` | `our-way,search,cold` | Comma-separated subset of arms to run |
| `--daemon` | `http://localhost:8787` | Daemon URL |
| `--workspace-root` | temp dir | Parent for per-conversation workspace dirs (must be absolute) |
| `--model` | `sonnet` | Claude model alias for probe answerer + judge |
| `--limit` | none | Cap number of conversations (for quick smoke/sampling) |
| `--max-probes` | none | Cap probes per conversation |
| `--output-dir` | script dir | Directory for `results.jsonl` + report files |
| `--no-resume` | false | Re-run all conversations (default: skip done-markers) |
| `--skip-score` | false | Skip post-run scorer |
| `--no-llm-judge` | false | Score with token-F1 only (skip LLM judge calls) |

### Resumable runs

`run.py` writes a done-marker at `<output-dir>/checkpoints/<conv_id>.done` after
each conversation completes. Re-runs skip conversations whose done-marker exists.
Delete the `checkpoints/` directory (or individual `.done` files) to re-run from
scratch.

### Output files

| File | Description |
|------|-------------|
| `results.jsonl` | One record per (probe, arm): arm, conv_id, qid, question, gold, predicted, diagnostics |
| `report.json` | Aggregated accuracy + F1 per arm and category |
| `report.md` | Markdown report with competitor bars |

These are **generated artifacts** and are excluded from the repo via `.gitignore`.

---

## Probe -> DAG mechanism

(From spike note `note-mqgwr63ms7q`)

For each probe in the `our-way` arm:

1. Sessions are ingested as note nodes via `POST /overlay/note` (no `force` — lets
   autowire + dup-guard run). Each session becomes one or more note keys.

2. The probe is minted as a TASK node via a file-drop stub written to
   `<CLAUDE_PLUGIN_DATA|~/.claude/orchestrator>/tasks/<workspaceKey>/<harness>/<id>.json`.
   The daemon adopts it within ~1.5 s.

3. `POST /overlay/status` with `status:"not_ready"` + `summary:<question>` fires
   the ingest funnel: embed -> autowireNewTaskWholeGraph -> markEagerJudge.
   Autowire seeds note->probe candidate edges at weight 0 / judged:false for
   sessions above `SEMANTIC_AUTOWIRE_THRESHOLD` (0.55).

4. A **blind LLM judge** (`claude -p`) receives ONLY the question and the candidate
   session transcripts — no gold answer, no dataset evidence labels. It returns
   which session ids to keep.

5. For kept sessions, `POST /judge/verdict` with `createEdge` (NOT `keepEdge` — see
   the createEdge-not-keepEdge finding below) promotes the edge to weight 0.5 and
   marks it `judged:true`.

6. `GET /task/context?key=<probe>&workspace=<ws>` -> `dependencySummaries`.
   Weight-0 edges are filtered out by the graph builder, so unkept candidates
   simply do not appear. The answer is produced from ONLY those summaries.

### Honesty bar (non-negotiable)

The gold answer and the dataset `evidence`/`answer_session_ids` labels are used
ONLY by the scorer. They NEVER enter any retrieve/keep/answer step of any arm.
The blind judge sees ONLY the question and candidate session summaries.

### Key findings baked into the implementation

**createEdge, not keepEdge** (from `note-mqh0gwz1mxc`):

  `keepEdge` (lib/judge.js) only promotes a PRE-EXISTING weight-0 autowire
  candidate. If a kept session's cosine fell below `SEMANTIC_AUTOWIRE_THRESHOLD`
  (0.55), no candidate edge was seeded, so `keepEdge` no-ops and the session
  never surfaces in the read. `createEdge` (routes/judge.js) calls
  `addEdge('context', weight)` which UPSERTS: it promotes an existing candidate
  AND creates a missing one, `judged:true`. A kept session ALWAYS becomes
  retrieval-visible regardless of its autowire score.

**Isolated-workspace prune caveat** (from `note-mqgwrh5a63x`):

  On an isolated workspace a pruned edge does NOT reliably clear. The harness
  uses KEEP-ONLY: unkept candidates stay at weight 0 and are filtered out of the
  read. We NEVER call `pruneEdge`. The DAG-read surface (`GET /task/context`) is
  robust because it drops weight-0 edges.

**Candidate source**: freshly-autowired candidate edges are weight 0 and are
  filtered out of `GET /task/context`. We cannot poll for candidates there;
  the blind judge's candidate list comes from the ingester's note map, not from
  the daemon.

**HONEST caveat — embedding still runs at write-time**:

  The `our-way` arm is NOT embedding-free. Candidate-generation still uses
  embedding — we change WHEN it runs (at write-time, frozen into DAG edges)
  not WHETHER it runs. The headline is that the blind LLM judge, not cosine
  similarity, makes the final keep/discard decision at query time.

### Windows claude -p quirks (from `note-mqh0h2hktq7`)

  On Windows `claude` is a `.cmd` shim. A long/multi-line positional prompt
  (with apostrophes, braces, quotes) gets mangled by cmd.exe arg parsing.
  `probe_runner._run_claude` delivers the prompt on STDIN (`input=` arg to
  `subprocess.run`), which is byte-clean regardless of length or special chars.
  Encoding is forced to `utf-8` (the box default is cp1252 -> mojibake/errors).

---

## Scorer

After all probes complete, `run.py` automatically invokes `scorer.py` to produce
`report.json` and `report.md`. Run the scorer standalone:

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/scorer.py \
    results.jsonl \
    --benchmark locomo \
    --output-dir bench/agent-memory
```

Two metrics:

- **LLM-judge accuracy** (headline): one `claude -p` per (probe, arm) -> correct/incorrect.
  Comparable to Mem0 92.5/94.4 and Zep 91.6/94.8 (LongMemEval Oracle/S).
- **Token-level F1** (secondary, diagnostic): deterministic, no LLM calls.

Pass `--no-llm-judge` to compute token-F1 only (fast offline mode).
