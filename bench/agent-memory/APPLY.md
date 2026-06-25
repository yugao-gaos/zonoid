# APPLY — run the agent-memory benchmark end-to-end

Drop-in instructions for the Windows eval box. No external clone needed — all
harness code lives in `bench/agent-memory/`. You only need to supply the
licensed dataset files (not committed) and ensure the Zonoid daemon is running.

---

## 0. Prerequisites checklist

| Item | Check |
|------|-------|
| Zonoid daemon running (`http://localhost:8787`) | `curl http://localhost:8787/health` |
| Embeddable Python 3.12 at full path | `C:\Users\Imyu\AppData\Local\py312embed\python.exe --version` |
| `claude` CLI on PATH | `claude --version` |
| `ANTHROPIC_API_KEY` set (or `claude login` completed) | `claude -p --help` |
| Dataset files in a local directory (not committed) | see section 1 |

---

## 1. Obtain datasets

### LoCoMo (CC BY-NC 4.0 — non-commercial only)

```
# Clone the repo (or download the file directly)
git clone https://github.com/snap-research/locomo.git
# The file is data/locomo10.json inside the repo
```

Place `locomo10.json` in a local directory, e.g. `C:\bench-data\locomo\`.
Do NOT commit it — the CC BY-NC 4.0 license forbids redistribution in a
commercial project.

### LongMemEval (MIT)

```
git clone https://github.com/xiaowu0162/LongMemEval.git
# Files are in LongMemEval/data/
#   longmemeval_oracle.json
#   longmemeval_s.json
#   longmemeval_m.json
```

Place the JSON files in a local directory, e.g. `C:\bench-data\longmemeval\`.

---

## 2. Start the daemon + warm the embedder

```
# From the repo root (not the bench dir):
node daemon.js
```

The embedding model loads lazily on the first `/search` call (~10-90 s).
`run.py` pre-warms it before the eval loop. If the daemon is not running,
`smoke.py` exits with code 2 and prints `DAEMON UNREACHABLE`.

---

## 3. Run the acceptance smoke test

Always run this first. It uses a self-contained toy conversation (no licensed
data) and verifies all four pipeline properties end-to-end:

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/smoke.py
```

All 4 assertions must print `[PASS]` and `OVERALL: PASS` before proceeding.
If any assertion fails, investigate before running the full bench.

---

## 4. Run the benchmark

### LoCoMo (10 conversations, all arms)

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/run.py ^
    --benchmark locomo ^
    --data-dir  C:\bench-data\locomo ^
    --workspace-root C:\bench-workspaces\locomo ^
    --arms our-way,search,cold ^
    --daemon http://localhost:8787 ^
    --model sonnet ^
    --output-dir bench/agent-memory
```

### LongMemEval Oracle (sample run, limit 5 conversations)

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/run.py ^
    --benchmark longmemeval-oracle ^
    --data-dir  C:\bench-data\longmemeval ^
    --workspace-root C:\bench-workspaces\lme-oracle ^
    --limit 5 ^
    --daemon http://localhost:8787 ^
    --model sonnet ^
    --output-dir bench/agent-memory
```

### Quick smoke (1 conversation, 1 probe per conversation)

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/run.py ^
    --benchmark locomo ^
    --data-dir  C:\bench-data\locomo ^
    --limit 1 ^
    --max-probes 1 ^
    --output-dir bench/agent-memory
```

---

## 5. Resume interrupted runs

`run.py` is resumable by default. A done-marker is written after each
conversation completes at `<output-dir>/checkpoints/<conv_id>.done`.
Re-running with the same `--output-dir` skips already-completed conversations.

To force a full re-run:

```
# Delete the checkpoint directory:
rmdir /s /q bench/agent-memory/checkpoints

# Or pass --no-resume to override:
... run.py ... --no-resume
```

---

## 6. Read the results

After the run, `report.json` and `report.md` are written to `--output-dir`:

```
bench/agent-memory/report.json   -- structured accuracy + F1 per arm
bench/agent-memory/report.md     -- markdown table with competitor bars
```

These files are generated artifacts and are excluded from the repo via
`.gitignore`. Do not commit them.

The raw probe records are in `bench/agent-memory/results.jsonl` (one line per
probe-arm pair). Also excluded from the repo.

---

## 7. Score-only (re-score an existing results.jsonl)

```
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/scorer.py ^
    bench/agent-memory/results.jsonl ^
    --benchmark locomo ^
    --output-dir bench/agent-memory
```

Pass `--no-llm-judge` to compute token-F1 only (deterministic, no API calls):

```
... scorer.py results.jsonl --no-llm-judge
```

---

## 8. Probe mechanism in brief

See `README.md` for the full probe -> DAG walkthrough. Key points:

1. Sessions ingested as notes via `POST /overlay/note` (no `force`).
2. Probe minted as a TASK via file-drop stub; daemon adopts it in ~1.5 s.
3. `POST /overlay/status` with `not_ready` + summary fires the embed + autowire
   funnel, seeding weight-0 candidate edges.
4. Blind `claude -p` judge selects which sessions hold the evidence (no gold).
5. `POST /judge/verdict` with `createEdge` (not `keepEdge`) asserts judged edges
   at weight 0.5 for kept sessions.
6. `GET /task/context` returns only weight->0 edges (unkept candidates filtered).
7. Answer produced from ONLY the returned dependency summaries.

**createEdge vs keepEdge**: use `createEdge` (routes/judge.js `addEdge` UPSERT)
NOT `keepEdge` (lib/judge.js promote-only). `keepEdge` silently no-ops if the
session's cosine was below the 0.55 autowire threshold and no candidate edge was
seeded. `createEdge` creates or promotes, so a kept session always surfaces.
(Finding `note-mqh0gwz1mxc`.)

**Isolated workspace**: never call `pruneEdge` on an isolated workspace - pruned
edges do not reliably clear. Use KEEP-ONLY: leave unkept candidates at weight 0
and let the graph builder filter them. (Finding `note-mqgwrh5a63x`.)

---

## 9. Dependency summary

No pip installs required. The harness is stdlib-only (Python 3.12 embeddable).
The only external dependency is the `claude` CLI (for the blind judge + answerer)
and the Zonoid daemon (for note/search/context HTTP calls).

| Component | Requirement |
|-----------|-------------|
| Python runtime | Embeddable Python 3.12 at full path (no pip) |
| Daemon | `http://localhost:8787` up + embedding model warm |
| LLM inference | `claude` CLI on PATH, `ANTHROPIC_API_KEY` |
| Datasets | Downloaded locally, NOT committed (see section 1) |
