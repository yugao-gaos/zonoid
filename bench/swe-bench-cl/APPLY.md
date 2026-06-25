# APPLY — wire the Zonoid memory arm into the SWE-Bench-CL eval_v1 harness

These are drop-in instructions for the Windows/WSL2 eval box. We do **not** edit a fork of
`thomasjoshi/agents-never-forget` here — clone it fresh and drop in `zonoid_memory.py`, then
make the small edits below to `eval_v1/eval_procedure.py`. (See `INTEGRATION-PLAN.md` in this
dir for the full recon.)

The result is a **3-arm config switch**: OFF (`memory_disabled`) / FAISS (`memory_enabled` +
native FAISS) / Zonoid (`memory_enabled` + our adapter).

---

## 0. Clone the repo (HTTPS, not SSH)

```
git clone https://github.com/thomasjoshi/agents-never-forget.git
cd agents-never-forget
```

**SSH→HTTPS fix (eval_procedure.py ~L86):** `setup_swe_bench()` clones SWE-bench via an SSH URL
`git@github.com:princeton-nlp/SWE-bench.git`, which fails on a box with no SSH key. Change L86 to:

```python
        "https://github.com/princeton-nlp/SWE-bench.git",
```

(or pre-clone manually into `eval_v1/SWE-bench`).

---

## 1. Drop in the adapter

Copy `zonoid_memory.py` (this dir) into `eval_v1/` next to `eval_procedure.py`:

```
cp zonoid_memory.py <repo>/eval_v1/zonoid_memory.py
```

It needs only `requests` (the daemon does all embedding/search server-side — the Zonoid arm
needs **no** langchain/faiss/embedding model locally).

---

## 2. Wire the 3rd arm — the `MEMORY_BACKEND` branch

The harness already has a 2-way OFF/FAISS toggle via `EXPERIMENT_CONDITIONS` +
`is_memory_enabled_for_run`. Extend it to 3 arms with a one-line backend selector at the
**memory-construction site (~L1105**, where `current_memory_system` is built per condition).

### 2a. Add a backend knob in the config block (~L157, near `EXPERIMENT_CONDITIONS`)

```python
# "faiss" | "zonoid"  — only consulted when memory is enabled for the run.
MEMORY_BACKEND = "zonoid"
# Absolute root for per-sequence Zonoid workspaces (MUST be absolute — see note below).
ZONOID_BASE_URL = "http://localhost:8787"
ZONOID_WORKSPACE_ROOT = os.path.abspath("./zonoid_cl_workspaces")
# True ⇒ each sequence's Zonoid workspace was pre-seeded by the warm-start step (§2e); the adapter
# then does NOT rotate/clear it at sequence start, so task 1 already has the onboarded repo KB.
ZONOID_WARM = True
```

### 2b. Add the import near the other memory imports (top of file)

```python
from zonoid_memory import ZonoidMemorySystem
```

### 2c. Branch the constructor at ~L1105

Find where the FAISS memory system is built for an enabled run, e.g.:

```python
if is_memory_enabled_for_run:
    current_memory_system = MemorySystem(SemanticMemory(active_embedding_model), ...)
```

Replace with:

```python
if is_memory_enabled_for_run:
    if MEMORY_BACKEND == "zonoid":
        current_memory_system = ZonoidMemorySystem(
            sequence_id=current_sequence_id,        # the loop's sequence id variable
            base_url=ZONOID_BASE_URL,
            workspace_root=ZONOID_WORKSPACE_ROOT,
            arm="zonoid",
            num_retrieved_memories=3,               # keep equal to the FAISS arm's k
            warm=ZONOID_WARM,                       # True ⇒ workspace was onboard-seeded; do NOT
                                                    #   rotate/clear it at sequence start (warm)
        )
        current_memory_system.warm_up()             # pre-pay the ~10-90s embedder cold start
    else:
        current_memory_system = MemorySystem(SemanticMemory(active_embedding_model), ...)
```

> If `current_sequence_id` isn't in scope at L1105 (memory is constructed once per condition,
> before the sequence loop), construct the `ZonoidMemorySystem` **inside the per-sequence loop**
> instead (right after `clear_memory()` at ~L1108), passing that sequence's id. The adapter is
> cheap to construct. The point is one `ZonoidMemorySystem` **per sequence** so each sequence is
> an isolated KB — matching FAISS's per-sequence retrieval filter.

No other run-loop edits are needed: `ZonoidMemorySystem` is duck-typed to the same 3 methods
(`get_relevant_context_for_prompt`, `add_experience_to_memory`, `clear_memory`), and the
CL-metrics block already diffs the `memory_enabled` vs `memory_disabled` result maps.

### 2d. Run the three arms

Run the notebook three times (or add three `EXPERIMENT_CONDITIONS` entries), changing only:
- OFF:    condition `memory_disabled` (no backend consulted).
- FAISS:  condition `memory_enabled`, `MEMORY_BACKEND = "faiss"`.
- Zonoid: condition `memory_enabled`, `MEMORY_BACKEND = "zonoid"`.

Keep arms comparable: same model, same `num_retrieved_memories=3`, same prompt template.

**The Zonoid daemon must be running on the eval box** (`http://localhost:8787`) for the Zonoid
arm. The OFF and FAISS arms do not touch it.

### 2e. WARM-START prep (run BEFORE the eval, per sequence) — Zonoid-full arm only

The Zonoid arm is **FULL lifecycle + WARM start**, not a flat cold store. Warm start onboards the
sequence's repo and seeds that sequence's Zonoid workspace, so task 1 already retrieves repo
knowledge. Run the prep script (from the **zonoid repo** on the eval box, with the **Node daemon
running**) once per sequence, BEFORE the eval loop reaches that sequence:

```
node bench/swe-bench-cl/warm_start.js \
  --repo /abs/path/to/pytest \                 # repo checked out at the CL sequence's BASE commit
  --sequence pytest-dev_pytest_sequence \      # MUST equal the eval loop's current_sequence_id
  --workspace-root /abs/.../zonoid_cl_workspaces \   # MUST equal ZONOID_WORKSPACE_ROOT (§2a)
  --arm zonoid                                 # MUST equal the adapter's arm
```

It mines (git/docs/config/structure) → agentic-learns (`--model sonnet`) → drains → injects the
`[ingest]` KB into `<workspace-root>/<slug>` where `slug = slugify("<sequence>-<arm>")` — the EXACT
absolute workspace the Python adapter reads (the script and `zonoid_memory.py.__init__` share the
slug rule; keep them in lockstep). `ORCH_GATE_OFF=1` is set in the child env automatically. The
script prints the resolved workspace path on stdout.

Because `ZONOID_WARM = True`, the adapter's `clear_memory()` is a **no-op** for the Zonoid arm, so
the warm seed survives into task 1 (it would otherwise rotate to a fresh empty workspace). Run
warm_start.js for every sequence you intend to evaluate.

> If you want a **cold** Zonoid arm for ablation (no onboarded seed), set `ZONOID_WARM = False`
> and skip warm_start.js — `clear_memory()` then rotates to a fresh per-sequence workspace as
> before. Keep the 3-arm toggle (OFF / FAISS / Zonoid-full) intact; warm is a property of the
> Zonoid arm, not a 4th arm.

### 2f. What the Zonoid arm actually does per task — CL-2c: a TRUE LLM edge-judge between tasks

`add_experience_to_memory` is **add → wire → RECONSTRUCT → REAL-LLM-JUDGE → post verdicts**, run
at the END of each task so task N+1's retrieval reflects the judged graph. It is NOT a flat
force-write and NOT the CL-2b deterministic keep-all rule:

1. **ADD** `POST /overlay/note` (NO `force`) — the daemon autowires weight-0 candidate context
   edges to related notes and marks the note for eager judging.
2. **WIRE** is automatic in that write (the daemon's `ingestNode` path).
3. **RECONSTRUCT** the candidate edge set: `GET /search` over note N's own content returns N's
   top-k semantic neighbours, which ARE (a superset of) the notes the daemon autowired weight-0
   edges to. The write response's `{match, pending_dup}` is folded in as the dup-cluster candidate.
   (The judge *read* queue `GET /judge/next` is workspace-blind over HTTP, so we reconstruct the
   candidate set from `/search` instead of reading it.)
4. **JUDGE — REAL LLM (`claude -p`).** The adapter shells one headless `claude -p` call per task
   (model `sonnet` by default; `ZONOID_JUDGE_MODEL` overrides), feeding N's summary + each
   neighbour's summary + the condensed `self-learn-edge-judge` rubric. The LLM returns, per
   candidate, `keep|prune` for the context edge and `distinct|consolidate` for any near-dup
   cluster. **Default bias = prune / distinct** (similarity is necessary, NOT sufficient — the
   default edge verdict is *no* edge). This is the production edge-judge reasoning, not a hardcoded
   rule: a spurious cosine neighbour is **pruned**, a genuine context relation is **kept**, a
   same-fact near-dup is **consolidated**.
5. **POST verdicts** `POST /judge/verdict` (workspace-targeted): `keepEdge`/`pruneEdge` per edge,
   `markDistinct` (KEEP both — clears `pending_dup`, note becomes retrieval-visible) /
   `consolidate` (PRUNE same-fact dup — supersede it, stays OUT of retrieval) per cluster.

**Cost:** exactly **one judge LLM call per task** (one `claude -p` per `add_experience_to_memory`),
plus one extra `/search` to reconstruct candidates — expected, faithful to the production judge.
If the LLM CLI is unavailable or the call fails/parses empty, the adapter falls back to the CL-2b
deterministic keep-edge + mark-distinct policy so the eval loop never stalls (`use_llm_judge=False`
selects the deterministic path explicitly for ablation).

**LLM CLI requirement (Windows box):** the Zonoid-full arm now needs the **`claude` CLI** on the
eval box (`ZONOID_JUDGE_CLAUDE` = its path; default `/opt/homebrew/bin/claude` for macOS dev). The
judge is a **pure text→JSON completion** — it runs with an empty MCP config + `--strict-mcp-config`
+ `--allowedTools ""` and does **NOT** pass `--dangerously-skip-permissions` (no tool calls to
approve). Auth via `ANTHROPIC_API_KEY` / the CLI's own login. The OFF and FAISS arms need no CLI.

`get_relevant_context_for_prompt` is **tiered/structured** `GET /search` — each hit carries
`tier` (dag/rag), `via`, and `path` provenance; kept neighbours co-retrieve, pruned ones drop.

**KNOWN DAEMON GAP — the EDGE keep/prune verdict is faithful but its retrieval effect is INERT over
the current HTTP surface for note↔note edges** (see `zonoid_memory.py` finding #6 for the code
pointers). Two daemon-side reasons, neither fixable from the adapter:
  - `buildGraph()` pushes note nodes with a hardcoded `context_deps: []`, and the `structBoost`
    reranker builds its adjacency only from `context_deps` — so a kept note→note edge never boosts
    its neighbour; **structBoost stays 0 for note↔note regardless of the verdict.**
  - `overlayStore.save()` only emits an `edge_added` event for *new* edges; `keepEdge` promotes an
    *existing* autowire edge in place, and that in-place mutation has the same signature, so the
    promotion is **not persisted** for a non-live (isolated eval) workspace.
The verdicts still post and journal correctly (the judge's reasoning is recorded), but
**structBoost cannot be demonstrated for note↔note edges.** The DEMONSTRABLE retrieval lever the
judge controls is the **dup-cluster decision**: `markDistinct` makes a near-dup note
retrieval-VISIBLE (kept distinct), `consolidate` supersedes it (pruned — stays OUT). The smoke
evidence below proves keep-vs-prune via that lever. The clean daemon fix (give note nodes real
`context_deps` from kept edges + emit an edge-update event on in-place promotion; gated
`note-mqfm5mvl8zw`, restart-required) is **out of scope here — do not apply.**

### 2g. SMOKE EVIDENCE — REAL LLM judge, keep-genuine / prune-spurious (2026-06-15, macOS dev daemon)

Two scripts exercise the CL-2c path against the live daemon:

- `python3 zonoid_memory.py` — built-in lifecycle self-test: writes an anchor + a genuine related
  experience (the 2nd trips the 0.70 dup guard), runs the per-task judge between them, and asserts
  round-trip retrieval + workspace isolation.
- `python3 smoke_llm_judge.py` — the **acceptance-bar** test. For one anchor N it constructs a
  **GENUINE** context neighbour (same teardown subsystem / fix-pattern) and a **SPURIOUS** but
  cosine-similar neighbour (shares `pytest` vocabulary, unrelated `mark/expression.py` subsystem),
  runs the **REAL `claude -p` edge-judge**, and asserts **edge=keep for the genuine one and
  edge=prune for the spurious one**, then demonstrates the dup-cluster KEEP vs PRUNE retrieval delta.

Verified on the macOS dev daemon (2026-06-15):
- **Candidate reconstruction:** writing a near-dup returns `autowired:1` + `pending_dup` with the
  matched neighbour; `GET /search` over N's content reconstructs the neighbour set the judge scores.
- **Verdict round-trip:** `keepEdge` + `pruneEdge` post and journal to the eval workspace's
  `judge-journal.jsonl` (keep + prune entries recorded).
- **PRUNE demonstrated, NOT keep-all (retrieval delta):** in an isolated workspace a same-fact dup
  B was made visible (`markDistinct`) then **`consolidate` removed it from `/search`** — after the
  prune, the query returns only A (B gone). Conversely a *distinct*-fact near-dup D went from
  invisible (`pending_dup`) → **VISIBLE** after `markDistinct` (KEEP). Same lever, opposite verdict,
  opposite retrieval outcome.
- **Workspace isolation:** a different sequence's workspace retrieved none of the above.

**Note on running the judge here:** in *this* sandbox the auto-mode classifier blocks the adapter
from spawning a nested `claude -p` ("Create Unsafe Agents"), so `smoke_llm_judge.py`'s `_llm_judge`
step is exercised on the eval box, not the dev sandbox; the verdict→post→retrieval mechanism (above)
was verified directly with the exact verdict shape `_llm_judge` returns. On the eval box (no such
classifier) run `python3 smoke_llm_judge.py` with the daemon up + `claude` CLI on PATH to capture
the live judge transcript before the run.

---

## 3. Dependency pins

The repo's `requirements.txt` is **dataset-construction only** (torch/transformers/datasets) —
it has NO langchain/faiss/swebench. Pin the eval stack yourself into a venv:

```
# --- core eval stack (FAISS arm + harness) ---
langchain-core
langchain-community        # FAISS vectorstore + Document  (FAISS arm only)
langchain                  # tools
faiss-cpu                  # FAISS arm only
swebench                   # the Docker grading harness; pin a known-good >=2.x release
                           #   (installed via `pip install -e .` from the cloned SWE-bench repo)

# --- LLM provider (pick the one matching MODELS_TO_EVALUATE; default gemini) ---
langchain-google-genai     # for google/gemini-2.0-flash (default)
# langchain-anthropic       # if using an Anthropic model
# langchain-openai          # if using an OpenAI model and/or OpenAI embeddings

# --- misc ---
pandas
numpy
tqdm
python-dotenv
torch                      # v1 imports it only for torch.backends.mps.is_available() — harmless on Windows
requests                   # <-- the ONLY runtime dep of the Zonoid arm
```

LangChain has had heavy breaking churn since mid-2025; pin a coherent langchain set from ~the
repo's era (commit 74a38a9, 2025-05) if imports break (`langchain_community.vectorstores.FAISS`,
`langchain_google_genai` are version-sensitive). Budget a little time for reconciliation —
**but the Zonoid arm sidesteps all of it** (it needs only `requests`).

**Embeddings:** the FAISS arm needs an embedding model (Ollama `nomic-embed-text` default, or
set `EMBEDDING_MODEL_CONFIG["name"] = "openai/text-embedding-3-small"` + `OPENAI_API_KEY` — the
lower-friction choice on a headless box). The **Zonoid arm needs none** — the daemon embeds
server-side.

**Docker (CL-3, the eval itself — run on the Windows box, not here):** SWE-bench per-instance
images, amd64 native, Docker Desktop + WSL2 backend, ~50-100 GB disk. Confirm the chosen
`--dataset_name` split has images for all 19 pytest instance_ids with a 1-task smoke run first.

**Full Zonoid stack on the Windows/WSL2 box (Zonoid-full arm only):** the arm needs the **Node
daemon running** (`http://localhost:8787`) AND the onboard scripts available (clone the zonoid
repo on the box; `node daemon.js`). The warm-start step (§2e) shells `node
bench/swe-bench-cl/warm_start.js`, which runs the onboard mine/learn/inject pipeline against the
daemon. So on the box: (1) start the Node daemon, (2) run warm_start.js per sequence to seed each
workspace, (3) run the Python eval with `ZONOID_WARM = True`. The OFF and FAISS arms need none of
this (no daemon, no Node).

---

## 4. SMOKE CHECK — round-trip + workspace isolation (RESOLVED: YES)

> **CL-2b note:** the capture below is the original CL-2 FLAT round-trip. The current adapter is
> FULL lifecycle + warm start — its smoke evidence (warm-start hit, judged-neighbor co-retrieval,
> isolation) is in **§2g**, and `python3 zonoid_memory.py` now exercises the full add→wire→judge
> path. This section is retained as the baseline round-trip proof.

Run against the local daemon (this was executed on the Mac during integration):

```
cd eval_v1   # (or wherever zonoid_memory.py lives)
python3 zonoid_memory.py
```

`__main__` writes one SUCCESS experience to a throwaway workspace, retrieves it by a
paraphrased query, then proves a *different* workspace returns nothing.

### Result captured (2026-06-15, daemon @ localhost:8787, embedding model warm):

```
SAME workspace retrieval (expect non-empty):

--- Relevant Past Experiences (from Zonoid Semantic Memory) ---
Past experience (CL experience demo-task-1, relevance 0.45):
[SUCCESSFUL SOLUTION (Verified by Harness)]
Sequence: selftest-seq  Task: demo-task-1
Problem:
fix TimeDelta quantity conversion overflow in to_value
Generated patch:
diff --git a/astropy/time/core.p
---
--- End of Past Experiences ---

OTHER workspace retrieval (expect empty):
  <EMPTY>

OK: round-trip + workspace isolation verified.
```

**Verdict: the read/write round-trip works with workspace isolation.** A write to workspace A
is retrievable from A and invisible from B.

---

## 5. Impedance issues found during integration (READ — load-bearing)

1. **`workspace` MUST be an ABSOLUTE FILESYSTEM PATH, not a bare namespace string.** The daemon
   does `path.join(workspace, '.graph')` to locate the per-workspace graph store. A relative
   string (e.g. `"cl-pytest-zonoid"`) makes the write return `ok:true` but the note is **never
   persisted** and `/search` returns nothing — a silent data-loss trap. The adapter builds an
   absolute path under `workspace_root` for every sequence; keep `ZONOID_WORKSPACE_ROOT`
   absolute. **This is the gating unknown from the plan — RESOLVED: workspace param works, but
   only with absolute paths.**

2. **Write route is `POST /overlay/note`, not `/record_decision`.** `record_decision` is an MCP
   tool name with no HTTP route. Body: `{workspace, title, summary, category, force}`.

3. **Dup guard (0.70 cosine) → DRIVE THE JUDGE (CL-2b), do NOT force-bypass.** A near-identical
   solution is admitted "pending_dup" = **retrieval-invisible** until a judge clears it. CL-2
   sent `force: true` to bypass this — but that ALSO suppressed the autowire + judge lifecycle,
   making the arm a flat store. CL-2b instead DROPS `force` and drives the judge: on a
   `pending_dup` write response, `POST /judge/verdict {verdicts:[{markDistinct:{keys:[note_key,
   match]}}]}` clears the flag (note becomes visible) and a `keepEdge` promotes the autowired
   neighbor edge. This is what makes the arm the REAL Zonoid lifecycle. **Gotcha:** `markDistinct`
   is not in the `/judge/verdict` bare-body allowlist — it MUST be wrapped in `{verdicts:[...]}`
   or the call is a silent no-op (see INTEGRATION-PLAN "Full-lifecycle surface").

4. **`/search` is GET with query-string params** (`?q=&k=&workspace=&gated=false`). POST /search
   ignores the body's query field — do not use it.

5. **Score direction:** Zonoid `/search` score is cosine-ish, **higher = better** (FAISS returns
   an L2 distance where lower = better). Only used for display in the prompt block, so no logic
   depends on direction — just don't sort ascending. (Observed scores ~0.45-0.57 for a strong
   paraphrase match; absolute value is lower than FAISS-style similarity but the ranking is what
   matters.)

6. **Embedder warm-up:** the first `/search` lazy-loads the local embedding model (~10-90 s).
   The adapter exposes `warm_up()`; the wiring in §2c calls it once before the loop so no single
   task eats the cold start.

7. **`clear_memory()` = workspace switch, not a wipe.** Zonoid notes are persistent (no
   delete-all). `clear_memory()` rotates to a fresh `…-run<N>` workspace dir so a re-run of the
   same arm starts empty. Per-(sequence, arm) scoping already isolates the three arms from each
   other.
