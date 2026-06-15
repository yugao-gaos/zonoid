"""Zonoid memory backend adapter for the SWE-Bench-CL eval_v1 harness.

Drop-in, duck-type-compatible replacement for the FAISS ``MemorySystem`` class in
``eval_v1/eval_procedure.py``. Implements the exact 3-method seam the run loop calls:

    get_relevant_context_for_prompt(problem, sequence_id, num_memories) -> str
    add_experience_to_memory(task_id, sequence_id, problem, patch, harness_result) -> None
    clear_memory() -> None

It talks to the running Zonoid orchestrator daemon over plain HTTP (default
http://localhost:8787) — no MCP client needed, since the eval is a separate Python process.

  WRITE   -> POST /overlay/note   (the HTTP route behind the MCP record_decision tool)
  READ    -> GET  /search         (the semantic engine behind search_knowledge)
  ISOLATE -> a per-(sequence, arm) absolute-path workspace dir (Zonoid has no delete-all)

----------------------------------------------------------------------------------------
SMOKE-VERIFIED FINDINGS (see APPLY.md for the full capture). Read these — they are
load-bearing for correctness:

1. The daemon `workspace` param MUST be an ABSOLUTE FILESYSTEM PATH, not a bare namespace
   string. The daemon does ``path.join(workspace, '.graph')`` to locate the per-workspace
   graph store; a relative string (e.g. "cl-pytest-zonoid") silently fails to PERSIST
   notes — the write returns ok:true but the note never round-trips on /search. Always
   pass an absolute path. This adapter builds one under ``workspace_root`` per sequence.

2. The note-write route is POST /overlay/note (NOT /record_decision — that is an MCP tool
   name with no HTTP route). Body: {workspace, title, summary, category, force}. Pass
   ``force: true`` to bypass the 0.70-cosine dup guard — a CL pilot WANTS every attempt
   recorded, and near-identical solutions would otherwise be admitted "pending_dup" =
   retrieval-invisible until a judge clears them.

3. /search is GET with QUERY-STRING params (?q=&k=&workspace=). POST /search ignores the
   body's query field. Score is cosine-ish (higher = better); do NOT sort ascending. Only
   used for display, so no normalization is needed.

4. First /search lazy-loads the local embedding model (~10-90 s). Call warm_up() once
   before the eval loop so no single task eats the cold-start latency.
----------------------------------------------------------------------------------------
"""

import os
import re
import requests


class ZonoidMemorySystem:
    """HTTP adapter to the Zonoid daemon, duck-typed to the FAISS MemorySystem seam."""

    def __init__(
        self,
        sequence_id,
        base_url="http://localhost:8787",
        workspace_root="/tmp/zonoid-cl",
        arm="zonoid",
        num_retrieved_memories=3,
        timeout=120,
    ):
        """One memory system per (sequence, arm).

        sequence_id:    the CL sequence id (e.g. "pytest-dev_pytest_sequence").
        workspace_root: absolute dir under which per-sequence workspaces are created.
        arm:            arm label, folded into the workspace path so OFF/FAISS/Zonoid and
                        re-runs never share a graph store.
        """
        self.base_url = base_url.rstrip("/")
        self.sequence_id = sequence_id
        self.arm = arm
        self.num_retrieved_memories = num_retrieved_memories
        self.timeout = timeout
        # Absolute-path workspace (finding #1). Slugify the sequence id for a clean dir name.
        slug = re.sub(r"[^A-Za-z0-9._-]", "-", f"{sequence_id}-{arm}")
        self.workspace = os.path.abspath(os.path.join(workspace_root, slug))
        os.makedirs(self.workspace, exist_ok=True)

    # -- lifecycle --------------------------------------------------------------------

    def warm_up(self):
        """Pre-pay the embedding-model cold start. Call once before the eval loop."""
        try:
            self._search("warmup", 1)
        except Exception:
            pass  # best-effort; a real call will retry

    def clear_memory(self):
        """FAISS wipes its in-process index here. Zonoid notes are persistent, so we
        ISOLATE instead of wipe: switch to a FRESH workspace dir so prior notes are
        invisible. Per-(sequence, arm) scoping already gives clean separation between
        arms; this additionally guarantees a re-run of the SAME arm starts empty."""
        slug = re.sub(r"[^A-Za-z0-9._-]", "-", f"{self.sequence_id}-{self.arm}")
        # Append a monotonic suffix so each clear yields a brand-new, empty namespace.
        n = getattr(self, "_clear_gen", 0) + 1
        self._clear_gen = n
        root = os.path.dirname(self.workspace)
        self.workspace = os.path.abspath(os.path.join(root, f"{slug}-run{n}"))
        os.makedirs(self.workspace, exist_ok=True)

    # -- the 3-method seam ------------------------------------------------------------

    def get_relevant_context_for_prompt(
        self, current_task_problem_statement, current_sequence_id, num_memories=None
    ):
        """RETRIEVE: return a ready-to-paste prompt block of past experiences, or "".

        Mirrors FAISS's get_relevant_context_for_prompt signature. The per-sequence
        workspace makes the sequence filter implicit (the whole KB IS this sequence)."""
        k = num_memories if num_memories is not None else self.num_retrieved_memories
        hits = self._search(current_task_problem_statement, k)
        if not hits:
            return ""
        block = "\n\n--- Relevant Past Experiences (from Zonoid Semantic Memory) ---\n"
        for h in hits:
            title = h.get("title", "?")
            score = h.get("score", 0.0) or 0.0
            summary = h.get("summary", "")
            block += f"Past experience ({title}, relevance {score:.2f}):\n{summary}\n---\n"
        block += "--- End of Past Experiences ---\n"
        return block

    def add_experience_to_memory(
        self, task_id, sequence_id, problem_statement, generated_patch, harness_result
    ):
        """WRITE: record this graded attempt as a Zonoid note. Records BOTH successes and
        failures with the harness-verified outcome, matching the FAISS class (which prefixes
        the doc with SUCCESSFUL/FAILED based on the same boolean)."""
        if harness_result is True:
            status = "SUCCESSFUL SOLUTION (Verified by Harness)"
        elif harness_result is False:
            status = "FAILED ATTEMPT (Verified by Harness)"
        else:
            status = "ATTEMPT (outcome unverified)"
        summary = (
            f"[{status}]\n"
            f"Sequence: {sequence_id}  Task: {task_id}\n"
            f"Problem:\n{(problem_statement or '')[:1500]}\n\n"
            f"Generated patch:\n{(generated_patch or '')[:3000]}"
        )
        payload = {
            "workspace": self.workspace,
            "title": f"CL experience {task_id}",
            "summary": summary,
            "category": "cl-experience",
            "force": True,  # bypass the 0.70 dup guard — record every attempt (finding #2)
        }
        try:
            r = requests.post(
                f"{self.base_url}/overlay/note", json=payload, timeout=self.timeout
            )
            r.raise_for_status()
        except Exception as e:  # never crash the eval loop over a memory write
            print(f"[ZonoidMemorySystem] add_experience_to_memory failed: {e}")

    # -- internal ---------------------------------------------------------------------

    def _search(self, query, k):
        """GET /search (query-string params). Returns the list of hit dicts (may be empty)."""
        params = {
            "q": query or "",
            "k": k,
            "workspace": self.workspace,
            # ungated: always return the ranked top-k regardless of the context-need gate —
            # a fixed-k eval always wants the hits; the gate is for agent token economy.
            "gated": "false",
        }
        r = requests.get(
            f"{self.base_url}/search", params=params, timeout=self.timeout
        )
        r.raise_for_status()
        return r.json().get("results", []) or []


if __name__ == "__main__":
    # Manual smoke check: write one experience, retrieve it, prove isolation.
    import tempfile

    root = tempfile.mkdtemp(prefix="zonoid-cl-selftest-")
    mem = ZonoidMemorySystem("selftest-seq", workspace_root=root, arm="zonoid")
    mem.warm_up()
    mem.add_experience_to_memory(
        "demo-task-1",
        "selftest-seq",
        "fix TimeDelta quantity conversion overflow in to_value",
        "diff --git a/astropy/time/core.py b/astropy/time/core.py\n+    # fix",
        True,
    )
    ctx = mem.get_relevant_context_for_prompt(
        "TimeDelta quantity conversion overflow", "selftest-seq", 3
    )
    other = ZonoidMemorySystem("other-seq", workspace_root=root, arm="zonoid")
    ctx_other = other.get_relevant_context_for_prompt(
        "TimeDelta quantity conversion overflow", "other-seq", 3
    )
    print("SAME workspace retrieval (expect non-empty):")
    print(ctx or "  <EMPTY>")
    print("OTHER workspace retrieval (expect empty):")
    print(ctx_other or "  <EMPTY>")
    assert ctx, "round-trip failed: wrote an experience but retrieved nothing"
    assert not ctx_other, "isolation failed: other workspace saw the note"
    print("\nOK: round-trip + workspace isolation verified.")
