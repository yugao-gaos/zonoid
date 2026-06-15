# SWE-Bench-CL → Zonoid Integration Plan (CL-1 recon)

Recon of `https://github.com/thomasjoshi/agents-never-forget` (pinned at commit `74a38a9`,
2025-05-17). Mac-only READ/analysis — no Docker eval run. Goal: assess whether a 3-arm
(OFF / FAISS / Zonoid) continual-learning pilot on ONE chronological sequence is a clean
integration or a research slog.

**Verdict up front: CLEAN integration, with one rewrite caveat.** The FAISS memory seam is a
tiny, well-isolated `MemorySystem` class with exactly two methods (write-after-task,
retrieve-before-task) and a boolean toggle already wired through the run loop. Swapping in
Zonoid is a ~1-file adapter. BUT: the runnable code is a jupytext *notebook-as-script*
(`eval_v1/eval_procedure.py`), not a CLI; the `Makefile`/`scripts/*` entry points are
**dead/aspirational** (they reference files that do not exist in the repo). Plan around the
notebook, not the Makefile.

---

## 0. Which eval version to use — use `eval_v1`, NOT v2/v3

The repo has three eval implementations. Only **`eval_v1/eval_procedure.py`** is the right base
for a *graded* pilot:

| Version | Memory | Grading | Verdict for pilot |
|---|---|---|---|
| `eval_v1/eval_procedure.py` (1421 LoC) | Full FAISS `MemorySystem` keyed on **harness-verified** pass/fail | **Real SWE-bench Docker harness** (`swebench.harness.run_evaluation`), per-task | **USE THIS** — only version with real Docker grading |
| `eval_v2_agent/eval_procedure.py` (1877 LoC) | FAISS `MemorySystem` (cleaner LangGraph ReAct agent: plan→execute→reflect→solve) | **NO Docker** — `tests_passed` is the agent self-reporting after running `run_tests` in-repo; the `SWEBenchCLEvaluator` orchestrator is a **broken stub** (calls `memory_system.add_task` / `.add_solution` / `.clear_task_context` — methods that don't exist on `MemorySystem`) | Reference only — agent design is nicer but grading is unsound + orchestrator broken |
| `eval_v3_swe-agent/eval_procedure.py` (2804 LoC + `.ipynb`) | SWE-agent-inspired | Mostly notebook; uses a `_dummy.json` dataset | Skip for pilot |

The **single biggest design fact**: `eval_v1` grades by writing a one-line prediction
(`instance_id` + `model_patch`) to a temp `.jsonl` and shelling out to the SWE-bench Docker
harness **once per task**, then reading the pass/fail back. That pass/fail is what gets written
to memory — so memory stores *verified* outcomes. This is exactly the loop we want for a CL
pilot, and the memory backend is the only thing we swap.

---

## 1. Harness run path (how ONE sequence runs end-to-end)

`eval_v1/eval_procedure.py` is a **jupytext notebook-as-script** (31 `# %%` cells, no
`if __name__ == "__main__"` guard). It runs **top-to-bottom** — most logic is at *module level*,
not inside functions. Run it with `jupytext --to notebook + papermill`, `jupyter nbconvert
--execute`, or `ipython eval_procedure.py`. There is no argparse CLI.

End-to-end flow (cells execute in order):

1. **Setup** — `setup_swe_bench(SWE_BENCH_REPO_PATH)` (L54) clones `princeton-nlp/SWE-bench`
   into `eval_v1/SWE-bench` and `pip install -e .`. (The repo ships an empty `eval_v1/SWE-bench/`
   dir; clone uses an **SSH** URL `git@github.com:...` — switch to HTTPS on Windows or it fails.)
2. **Config block** (L119–175): paths, models, embedding config, experiment conditions.
   - `SWE_BENCH_CL_DATASET_PATH = "../data/SWE-Bench-CL-Curriculum.json"`
   - `MODELS_TO_EVALUATE = ["google/gemini-2.0-flash"]` (default; provider/model split on `/`)
   - `EXPERIMENT_CONDITIONS = {"memory_enabled": {...True}, "memory_disabled": {...False}}`
   - `SEQUENCES_TO_RUN = None` (None ⇒ all 8; **set to one sequence id for the pilot**)
   - `TASKS_PER_SEQUENCE_LIMIT = None` (set to e.g. 15 to cap the pilot)
3. **LLM + embedding init** (L249–319): `get_llm()` builds `ChatAnthropic/ChatOpenAI/
   ChatGoogleGenerativeAI/ChatOllama`; embeddings via `OllamaEmbeddings("nomic-embed-text")`
   (default) or `OpenAIEmbeddings`.
4. **Memory classes** `SemanticMemory` + `MemorySystem` (L360–498) — the swap seam (§2).
5. **Main orchestration loop** (L1067–1300+): for each model → for each condition
   (`memory_enabled`/`memory_disabled`) → `clear_memory()` → for each sequence → for each task:
   - **retrieve** memory context (if enabled) →
   - **generate** patch via one LLM call (`prompt_template_str_with_memory`, L562) →
   - **write** prediction jsonl →
   - **run Docker harness** for that one task (`run_swe_bench_harness`, L647) →
   - **parse** pass/fail (`parse_harness_results`, L749) →
   - **write to memory** the verified outcome (L1268–1273) →
   - checkpoint `eval_state.json` (resumable — skips already-evaluated instance_ids, L1172).
6. **CL metrics** (L1315+): success rate, AULC, forward/backward transfer, forgetting, CL-Score —
   computed by diffing the `memory_enabled` vs `memory_disabled` result maps.

**Dataset/sequence file structure** (`data/SWE-Bench-CL-Curriculum.json`, 5.6 MB):
`{ metadata, evaluation_metrics, sequences: [ {id, repo, num_tasks, tasks: [ {metadata:
{instance_id, base_commit, difficulty}, task: {problem_statement, hints_text}, evaluation:
{patch (gold), test_patch, FAIL_TO_PASS, PASS_TO_PASS}, continual_learning: {dependencies:[...]}}
] } ] }`. 8 sequences, one per repo (django 50, sympy 50, sphinx 44, matplotlib 34, sklearn 32,
astropy 22, xarray 22, **pytest 19**). Tasks within a sequence are chronological + curriculum-
ordered (easy→hard) with explicit cross-task `dependencies`.

**Where Docker images are pulled/run:** inside `run_swe_bench_harness` (L692–701), which shells:
```
python -m swebench.harness.run_evaluation \
  --predictions_path <temp.jsonl> \
  --dataset_name princeton-nlp/SWE-bench --split test \
  --report_dir <log dir> --timeout 900 --max_workers 4 --run_id <id>
```
The SWE-bench harness itself pulls the per-instance Docker images (`sweb.eval.x86_64.<instance>`)
from Docker Hub / builds them, applies the gold `test_patch`, applies our `model_patch`, runs
`FAIL_TO_PASS`/`PASS_TO_PASS`, and emits a `<model>.<run_id>.json` report. Note it grades against
**`princeton-nlp/SWE-bench` (full), split `test`** — NOT `SWE-bench_Verified`. SWE-Bench-CL
instance_ids are drawn from Verified, which is a subset of full SWE-bench `test`, so the
instance_ids resolve — but if we want Verified images specifically, change `--dataset_name` to
`princeton-nlp/SWE-bench_Verified` (one-line edit at L695).

---

## 2. FAISS memory interface (the exact seam we swap)

Two classes in `eval_v1/eval_procedure.py`. `MemorySystem` (L465–498) is the façade the run loop
talks to; `SemanticMemory` (L360–463) wraps LangChain-community FAISS underneath.

**The entire seam is two methods + one toggle:**

**WRITE (called after each graded task, L1268–1273):**
```python
MemorySystem.add_experience_to_memory(
    task_id: str, sequence_id: str, problem_statement: str,
    generated_patch: str, harness_result: Optional[bool]) -> None
```
→ delegates to `SemanticMemory.add_entry(...)` (L369), which prefixes the doc with
`[SUCCESSFUL SOLUTION (Verified by Harness)]` / `[FAILED ATTEMPT ...]` and **rebuilds the whole
FAISS index** via `FAISS.from_texts(...)` (L390) on every write (cheap at pilot scale).

**RETRIEVE (called before each patch generation, L1191–1195):**
```python
MemorySystem.get_relevant_context_for_prompt(
    current_task_problem_statement: str, current_sequence_id: str,
    num_memories: int) -> str            # returns a ready-to-paste prompt block
```
→ `SemanticMemory.retrieve_relevant(query, sequence_id_filter, num_results)` (L396) does
`index.similarity_search_with_score(query, k)`, **filters to the same `sequence_id`**, dedups by
`task_id`, returns top-`k` (default 3). `get_relevant_context_for_prompt` formats them into a
`--- Relevant Past Experiences (from Semantic Memory) --- ...` string that is interpolated into
the prompt template as `{retrieved_context}`.

**TOGGLE / lifecycle:** `MemorySystem.clear_memory()` (L498); called at the start of each
condition (L1108). `is_memory_enabled_for_run` (from `EXPERIMENT_CONDITIONS`) guards both the
retrieve (L1191) and write (L1269) calls. Memory is **per-condition** scoped (one FAISS index
that accumulates across the whole sequence, reset between conditions) and **filtered per-sequence**
on retrieval — i.e. it compounds within the chronological sequence. Exactly the CL behavior we
want to compare Zonoid against.

So the swap surface is literally: **one class implementing two methods + `clear_memory()`**,
returning a string from retrieve and accepting `(task_id, sequence_id, problem, patch, bool)` on
write. No other call sites touch memory.

---

## 3. Zonoid swap points (concrete)

Replace the FAISS `MemorySystem` with a drop-in `ZonoidMemorySystem` exposing the **same three
methods** (duck-typed; the run loop only calls those). No run-loop edits needed except choosing
the class at L1105 (`current_memory_system = ZonoidMemorySystem(...)`).

**Daemon HTTP is the right transport** (the eval is a separate Python process, not an MCP-aware
agent — it cannot call `mcp__orchestrator-graph__*` tools directly). Use the daemon on
`http://localhost:8787`:

```python
import requests
class ZonoidMemorySystem:
    def __init__(self, base="http://localhost:8787", workspace_key="cl-pilot-<seq>"):
        self.base, self.ws = base, workspace_key
    def get_relevant_context_for_prompt(self, problem, sequence_id, num_memories) -> str:
        r = requests.post(f"{self.base}/search", json={
            "query": problem, "k": num_memories, "gated": False})  # ungated = always return ranked hits
        hits = r.json().get("results", [])
        if not hits: return ""
        block = "\n\n--- Relevant Past Experiences (Zonoid KB) ---\n"
        for h in hits:
            block += f"Past (Task {h.get('task_id','?')}, score {h.get('score',0):.2f}):\n{h['summary']}\n---\n"
        return block + "--- End of Past Experiences ---\n"
    def add_experience_to_memory(self, task_id, sequence_id, problem, patch, harness_result):
        status = "SUCCESS (harness-verified)" if harness_result else "FAILED (harness-verified)"
        requests.post(f"{self.base}/record_decision", json={
            "title": f"CL solution {task_id}",
            "summary": f"[{status}] {sequence_id}/{task_id}\nProblem: {problem[:500]}\nPatch:\n{patch[:1000]}",
            "category": "cl-experience", "wires_to": []})
    def clear_memory(self):  # per-condition reset — use a fresh per-sequence workspace instead
        pass
```

**Mapping FAISS → Zonoid:**
- retrieve `similarity_search_with_score` → daemon `POST /search` (semantic, the same engine
  behind `mcp__orchestrator-graph__search_knowledge`). Use **ungated** (`gated:false`) so it
  always returns ranked hits regardless of the context-need gate — the CL prompt always wants the
  top-k, the gate is for agent token economy, not for a fixed-k eval.
- write `FAISS.from_texts` → daemon `POST /record_decision` (creates a note node; same path as
  the MCP `record_decision`). KB compounds across the sequence automatically.

**Impedance mismatches to handle:**
1. **Workspace isolation / `clear_memory`.** FAISS `clear_memory()` wipes the in-process index
   between conditions. Zonoid notes are persistent in the graph — there is no cheap "wipe". Fix:
   use a **per-(sequence, condition) workspace key** (e.g. `cl-pilot-pytest-zonoid`) and a fresh
   one per run, so the OFF arm and a re-run never see prior notes. The daemon must support a
   workspace/namespace scope on `/search` + `/record_decision`; **VERIFY the daemon exposes a
   workspace param** (the MCP tools imply per-workspace graphs — confirm the HTTP endpoints accept
   it, else run each arm against a fresh daemon/workspace dir). This is the one real integration
   unknown — see §7.
2. **Sync/async + embedding lazy-load.** First `/search` lazy-loads the local embedding model
   (~90 s per the MCP `search_knowledge` note). The eval is synchronous and per-task, so do **one
   warm-up `/search` before the loop**. All calls are sync HTTP — fine.
3. **Sequence filtering.** FAISS retrieval is `sequence_id`-filtered. With a per-sequence
   workspace the whole KB *is* that sequence, so the filter is implicit — no extra work.
4. **Return shape.** FAISS returns an L2 distance `score` (lower=better); Zonoid `/search`
   returns a cosine-ish score (higher=better). Only used for display in the prompt block — no
   logic depends on the direction, so no normalization needed. Just don't sort-ascending.
5. **What reaches the prompt.** FAISS stores `problem + patch` and returns the stored doc text.
   Zonoid `record_decision` stores a `summary`; ensure we pack the patch + verified-status into
   `summary` (done above) so the agent sees the same signal. Note Zonoid's **dup guard (0.70
   cosine)** may reject near-identical notes — for a CL pilot we *want* every attempt recorded, so
   pass `force:true` on `record_decision` if the daemon rejects as duplicate.

**Arm 3 ("Zonoid") = this adapter.** It additionally gets us the thing FAISS can't: the daemon's
judged/curated KB (edge precision, dedup) — but for a clean first pilot, the plain
search/record swap is the apples-to-apples comparison against FAISS.

---

## 4. Pilot sequence pick

**`pytest-dev_pytest_sequence` — pytest-dev/pytest, 19 tasks.**

Rationale:
- **Size fits the 10–20 task target exactly** (19 tasks). Use all 19, or cap at 15 via
  `TASKS_PER_SEQUENCE_LIMIT`.
- **Curriculum spread**: 8 easy (<15 min) / 8 medium (15 min–1 h) / 3 hard (1–4 h) — enough
  difficulty gradient to expose learning/forgetting, unlike django (all 50 trivially easy).
- **High dependency density (37%, 7/19 tasks have `continual_learning.dependencies`)** — second
  only to xarray; dependencies are what make *knowledge transfer* (the thing Zonoid should win)
  measurable. xarray (22 tasks, 59% deps) is the alternative if we want max transfer signal, but
  pytest's smaller size + lower Docker-image weight makes it the cleaner *first* pilot.
- **Docker cost**: pytest images are comparatively light vs django/sympy/matplotlib (numpy/scipy
  build chains). ~19 task-grades × (LLM gen + one Docker harness run each).

**Est. runtime/task:** dominated by the Docker harness, not the LLM. Per SWE-bench norms with a
warm image cache: ~2–6 min/task to apply patch + run `FAIL_TO_PASS`/`PASS_TO_PASS` (harness
`--timeout 900`, `--max_workers 4`). Cold (first pull/build per instance): +5–15 min/image the
first time. So **first run ~1.5–3 h wall for 19 tasks × 1 arm** (image build-dominated), then
~1 h/arm warm. Three arms (OFF/FAISS/Zonoid) ≈ a half-day with a warm cache.

---

## 5. Windows / WSL2 run requirements

The eval host is native x86 Windows/WSL2 (amd64 Docker native). Requirements:

**Python deps (NONE are pinned anywhere in the repo — `requirements.txt` is dataset-construction
deps only: torch/transformers/datasets/etc.; it contains NO langchain/faiss/swebench).** You must
pin these yourself. Install into a venv:
- `langchain-core`, `langchain-community` (FAISS vectorstore, `Document`), `langchain` (tools)
- `langchain-openai`, `langchain-anthropic`, `langchain-google-genai`, `langchain-ollama`
  (only the one you use is needed — pilot can use one provider)
- `langgraph` (only needed for v2's agent; **v1 does NOT import langgraph** — skip for v1 pilot)
- `faiss-cpu` (for the FAISS arm)
- `swebench` (the grading harness — installed via `pip install -e .` from the cloned SWE-bench
  repo, per `setup_swe_bench`; pin a known-good SWE-bench release, e.g. ≥ 2.x)
- `pandas`, `numpy`, `tqdm`, `python-dotenv`, `torch` (v1 imports torch only for
  `torch.backends.mps.is_available()` — on Windows MPS is False, harmless)
- `requests` (for the Zonoid arm adapter)
- embeddings: either **Ollama** running locally with `nomic-embed-text` pulled (default), or set
  `EMBEDDING_MODEL_CONFIG["name"]` to `openai/text-embedding-3-small` + `OPENAI_API_KEY`. On a
  headless Windows box, the OpenAI embedding is the lower-friction choice; FAISS arm needs *some*
  embedding model, Zonoid arm uses the daemon's own embedder so needs none.

**Docker images:** SWE-bench per-instance eval images, pulled/built by the harness on demand from
`princeton-nlp/SWE-bench` `test` split (or switch to `SWE-bench_Verified`). amd64 native on the
Windows/WSL2 box (no emulation — this is the whole reason for the x86 host). Ensure Docker Desktop
+ WSL2 backend, generous disk (SWE-bench images are GBs each; `--max_workers 4` + 19 instances →
budget ~50–100 GB). The repo's `scripts/warm_docker_cache.py` exists and may help pre-pull.

**Dataset download:** none external — `data/SWE-Bench-CL-Curriculum.json` ships in the repo (5.6 MB).
The SWE-bench *grading* dataset (`princeton-nlp/SWE-bench`) is pulled by the harness from HF
Datasets at run time (needs network + possibly `HF_TOKEN`).

**API keys (`.env` at repo root, loaded via `python-dotenv`):** one LLM key
(`GEMINI_API_KEY`/`GOOGLE_API_KEY`, or `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`) + optionally
`OPENAI_API_KEY` for embeddings. Default config targets `google/gemini-2.0-flash`.

**LangGraph version pins:** N/A for the v1 pilot (v1 doesn't use langgraph). If we ever use v2,
langgraph + langchain are tightly coupled and unpinned — would need version reconciliation.

**Path/SSH gotcha:** `setup_swe_bench` clones via `git@github.com:` (SSH). On a fresh Windows box
without an SSH key, change L86 to the HTTPS URL `https://github.com/princeton-nlp/SWE-bench.git`,
or pre-clone manually into `eval_v1/SWE-bench`.

---

## 6. 3-arm toggle (OFF / FAISS / Zonoid as a config switch)

The harness already has a 2-way toggle; extend it to 3 arms with a one-line backend selector.

- **Existing 2-way:** `EXPERIMENT_CONDITIONS` (L157) + `is_memory_enabled_for_run` gives
  **OFF** (`memory_disabled`) vs **FAISS** (`memory_enabled` with the current FAISS
  `MemorySystem`). The OFF arm needs no work — it's `memory_disabled`.
- **Add the 3rd arm** by making the *backend class* a config knob at the memory-construction site
  (L1105, where `current_memory_system` is built). Add:
  ```python
  MEMORY_BACKEND = "faiss"   # "faiss" | "zonoid"  (only consulted when memory_enabled)
  ...
  if is_memory_enabled_for_run:
      if MEMORY_BACKEND == "zonoid":
          current_memory_system = ZonoidMemorySystem(workspace_key=f"cl-{sequence_id}-zonoid")
      else:
          current_memory_system = MemorySystem(SemanticMemory(active_embedding_model), ...)
  ```
- **Three runs** of the notebook (or three `EXPERIMENT_CONDITIONS` entries):
  `{memory_disabled}` → OFF, `{memory_enabled, backend=faiss}` → FAISS,
  `{memory_enabled, backend=zonoid}` → Zonoid. Each writes a separate
  `parsed_harness_results_data[model][condition]` map; the CL-metrics block already diffs them.
- Because `ZonoidMemorySystem` is duck-typed to the same 3 methods, **no run-loop edits beyond
  the constructor branch.** Keep arms comparable: same model, same `num_retrieved_memories=3`,
  same per-sequence scope, identical prompt template.

---

## 7. Risks / unknowns

**Runnable as-is?** *Partly.* `eval_v1/eval_procedure.py` is coherent and complete, but:
- **The `Makefile` + `scripts/*.py` eval entry points are DEAD.** `make eval-memory` /
  `eval-zero-shot` call `scripts/process_data.py`, `scripts/evaluate_memory.py`,
  `scripts/generate_embeddings.py`, etc. — **none of which exist** — and read `SWE-Bench-CL.json`
  at repo root (also absent; only `data/SWE-Bench-CL-Curriculum.json` exists). **Ignore the
  Makefile.** The real path is running the v1 notebook directly. (Low risk, just don't waste time
  on `make`.)
- **No dependency pins** for the eval stack (langchain/faiss/swebench). LangChain has had heavy
  breaking churn since 2025-05; `langchain_community.vectorstores.FAISS` and the
  `langchain_google_genai` import (the code even comments "Corrected import") are version-
  sensitive. **Medium risk: dependency rot.** Mitigation: pin a known-good langchain set from
  ~mid-2025 and pin a specific `swebench` release. Budget a day for dependency reconciliation.

**Docker image availability:** SWE-bench Verified/test images are large and occasionally drift on
Docker Hub. **Medium risk.** Mitigation: amd64 native host (already planned), pre-pull via
`scripts/warm_docker_cache.py`, ample disk. Confirm the chosen `--dataset_name` split has images
for all 19 pytest instance_ids before the full run (a 1-task smoke run first).

**Zonoid daemon workspace isolation (the one genuine integration unknown):** the FAISS arm gets a
clean in-process `clear_memory()` between conditions; Zonoid notes persist in the graph.
**VERIFY the daemon's HTTP `/search` + `/record_decision` accept a workspace/namespace param** so
each arm (and each re-run) is isolated, OR run the Zonoid arm against a throwaway daemon
workspace dir and reset it between runs. If neither, KB bleed-through between OFF/FAISS/Zonoid
re-runs would contaminate results. **This is the highest-leverage thing to confirm before the
Windows run.** (The MCP tools are per-workspace, so the capability almost certainly exists — just
confirm it's reachable over plain HTTP from a non-agent Python process.)

**Grading-dataset mismatch:** harness hardcodes `--dataset_name princeton-nlp/SWE-bench --split
test` (full SWE-bench), while SWE-Bench-CL is *derived from* Verified. instance_ids resolve (CL
ids ⊂ Verified ⊂ full test), but if a downstream comparison expects Verified-only grading,
change L695 to `princeton-nlp/SWE-bench_Verified`. **Low risk, one-line.**

**Cost/time:** first cold run is Docker-image-build-dominated (~1.5–3 h for 19 tasks). LLM cost
is one generation call per task per arm (cheap). **Low risk** given the small pilot.

**Bottom line:** clean integration. The memory seam is a 3-method duck-typed class; the toggle
is a one-line backend switch on an already-3-arm-capable loop; OFF needs zero work. The only real
work is (a) writing the `ZonoidMemorySystem` HTTP adapter (~40 LoC, drafted in §3), (b) confirming
daemon workspace isolation over HTTP, and (c) pinning the unpinned langchain/swebench deps. Not a
research slog.
