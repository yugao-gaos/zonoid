"""Zonoid memory backend adapter for the SWE-Bench-CL eval_v1 harness.

Drop-in, duck-type-compatible replacement for the FAISS ``MemorySystem`` class in
``eval_v1/eval_procedure.py``. Implements the exact 3-method seam the run loop calls:

    get_relevant_context_for_prompt(problem, sequence_id, num_memories) -> str
    add_experience_to_memory(task_id, sequence_id, problem, patch, harness_result) -> None
    clear_memory() -> None

It talks to the running Zonoid orchestrator daemon over plain HTTP (default
http://localhost:8787) — no MCP client needed, since the eval is a separate Python process.

----------------------------------------------------------------------------------------
CL-2b — FULL ZONOID LIFECYCLE (add → wire → judge → tiered retrieval) + WARM START.

This is NOT the flat CL-2 store (raw POST /overlay/note force:true + GET /search gated:false).
Each recorded experience now goes through the REAL Zonoid process, and retrieval is the
structured/tiered bundle, not a flat cosine dump. See INTEGRATION-PLAN.md "Full-lifecycle
surface" for the HTTP reachability matrix this code is built on.

PER-TASK LIFECYCLE (add_experience_to_memory):
  1. ADD    POST /overlay/note  (NO force) — the write triggers the daemon's own pipeline:
            ingestNode → autowireNoteProvider seeds weight-0 candidate context edges to
            semantically-related notes + markEagerJudge. Response carries `autowired:<n>` and,
            if the 0.70 title-cosine dup guard fired, {pending_dup, note_key, match:{key}}.
  2. WIRE   is automatic (above). The adapter does not hand-wire — autowire is the real path.
  3. JUDGE  POST /judge/verdict (workspace-targetable). The adapter drives the judge from the
            write response (the judge READ queue, GET /judge/next, is workspace-blind — see the
            plan). It posts:
              - markDistinct{note_key, match.key}  iff pending_dup — clears the provisional flag
                so the note becomes RETRIEVAL-VISIBLE (a pending_dup note is hidden until judged).
              - keepEdge{from:note_key, to:match.key} — promotes the autowired weight-0 candidate
                edge to a ranked (judged, weight>0) context edge, so the wired neighbor is real
                retrieval signal next round.

RETRIEVAL (get_relevant_context_for_prompt):
  GET /search (structured, ungated) — returns a tiered bundle: each hit carries tier (dag/rag),
  via (semantic/lexical), and path (provenance). Because experiences are wired+judged, related
  experiences co-retrieve and the block shows the experience WITH its judged neighbor context,
  not an isolated cosine hit.

WARM START:
  Constructed with warm=True against a workspace pre-seeded by
  ``scripts/onboard-learn.js --inject --confirm --workspace <abs seq path>`` (see warm_start.js).
  A warm adapter does NOT rotate/clear the workspace at sequence start, so task 1 already has the
  onboarded repo KB. clear_memory() is a NO-OP under warm=True (clearing would discard the seed).

----------------------------------------------------------------------------------------
LOAD-BEARING DAEMON FINDINGS (smoke-verified; see APPLY.md for the capture):

1. The daemon `workspace` param MUST be an ABSOLUTE FILESYSTEM PATH. The daemon does
   ``path.join(workspace, '.graph')`` to locate the per-workspace store; a relative string
   silently fails to PERSIST (write returns ok but never round-trips on /search). Always pass
   an absolute path. This adapter builds one under ``workspace_root`` per sequence.

2. The note-write route is POST /overlay/note. We DROP `force` (CL-2 used force:true) so the
   autowire + judge lifecycle actually runs; `force` bypasses the dup guard AND suppresses the
   pending_dup signal the judge needs.

3. /search is GET with QUERY-STRING params (?q=&k=&workspace=). Score is cosine-ish (higher =
   better); do NOT sort ascending. Pass task_key=<k> for the DAG/RAG tiered bundle.

4. /judge/verdict: markDistinct/markJudged are NOT in the route's bare-body fallback allowlist —
   they MUST be wrapped as {verdicts:[{markDistinct:{...}}]} or the call is a silent no-op.
   keepEdge/pruneEdge/consolidate ARE in the allowlist (bare body works) but we wrap uniformly.

5. First /search lazy-loads the local embedding model (~10-90 s). Call warm_up() once before the
   eval loop so no single task eats the cold-start latency.
----------------------------------------------------------------------------------------
"""

import os
import re
import requests


class ZonoidMemorySystem:
    """HTTP adapter to the Zonoid daemon, duck-typed to the FAISS MemorySystem seam.

    Implements the FULL Zonoid lifecycle (add → autowire → judge → tiered retrieval), not a flat
    semantic store. One memory system per (sequence, arm)."""

    def __init__(
        self,
        sequence_id,
        base_url="http://localhost:8787",
        workspace_root="/tmp/zonoid-cl",
        arm="zonoid",
        num_retrieved_memories=3,
        timeout=120,
        warm=False,
    ):
        """One memory system per (sequence, arm).

        sequence_id:    the CL sequence id (e.g. "pytest-dev_pytest_sequence").
        workspace_root: absolute dir under which per-sequence workspaces are created.
        arm:            arm label, folded into the workspace path so OFF/FAISS/Zonoid and
                        re-runs never share a graph store.
        warm:           if True, the workspace was pre-seeded by the onboard warm-start step
                        (warm_start.js). A warm adapter does NOT rotate/clear at sequence start —
                        clear_memory() becomes a no-op so the onboarded KB survives into task 1.
        """
        self.base_url = base_url.rstrip("/")
        self.sequence_id = sequence_id
        self.arm = arm
        self.num_retrieved_memories = num_retrieved_memories
        self.timeout = timeout
        self.warm = warm
        # Absolute-path workspace (finding #1). Slugify the sequence id for a clean dir name.
        # MUST match the slug warm_start.js seeds (see that script) so a warm run lands on the
        # already-onboarded workspace.
        self._slug = re.sub(r"[^A-Za-z0-9._-]", "-", f"{sequence_id}-{arm}")
        self.workspace = os.path.abspath(os.path.join(workspace_root, self._slug))
        os.makedirs(self.workspace, exist_ok=True)

    # -- lifecycle --------------------------------------------------------------------

    def warm_up(self):
        """Pre-pay the embedding-model cold start. Call once before the eval loop."""
        try:
            self._search("warmup", 1)
        except Exception:
            pass  # best-effort; a real call will retry

    def clear_memory(self):
        """FAISS wipes its in-process index here. Under WARM start this is a NO-OP — clearing
        would discard the onboarded repo KB the warm-start step seeded (the whole point of warm
        is that task 1 already has context).

        For a COLD Zonoid arm (warm=False) we ISOLATE instead of wipe (Zonoid notes are
        persistent, no delete-all): switch to a FRESH workspace dir so prior notes are invisible
        and a re-run of the same arm starts empty."""
        if self.warm:
            return  # warm: keep the onboarded seed
        # Append a monotonic suffix so each clear yields a brand-new, empty namespace.
        n = getattr(self, "_clear_gen", 0) + 1
        self._clear_gen = n
        root = os.path.dirname(self.workspace)
        self.workspace = os.path.abspath(os.path.join(root, f"{self._slug}-run{n}"))
        os.makedirs(self.workspace, exist_ok=True)

    # -- the 3-method seam ------------------------------------------------------------

    def get_relevant_context_for_prompt(
        self, current_task_problem_statement, current_sequence_id, num_memories=None
    ):
        """RETRIEVE (tiered/structured): return a ready-to-paste prompt block of past experiences
        (warm-start repo KB + wired+judged per-task experiences), or "".

        Uses the structured /search bundle — each hit carries tier (dag/rag), via, and path
        provenance. Because experiences are wired+judged, a hit's judged neighbor co-retrieves, so
        the block shows the experience WITH its context, not an isolated flat cosine hit."""
        k = num_memories if num_memories is not None else self.num_retrieved_memories
        hits = self._search(current_task_problem_statement, k)
        if not hits:
            return ""
        block = "\n\n--- Relevant Past Experiences (from Zonoid lifecycle memory) ---\n"
        for h in hits:
            title = h.get("title", "?")
            score = h.get("score", 0.0) or 0.0
            summary = h.get("summary", "")
            tier = h.get("tier", "rag")
            via = h.get("via", "")
            path = h.get("path") or []
            prov = f" via {via}" if via else ""
            nbr = f" [wired-neighbor path: {' -> '.join(path)}]" if path else ""
            block += (
                f"Past experience ({title}, relevance {score:.2f}, tier={tier}{prov}){nbr}:\n"
                f"{summary}\n---\n"
            )
        block += "--- End of Past Experiences ---\n"
        return block

    def add_experience_to_memory(
        self, task_id, sequence_id, problem_statement, generated_patch, harness_result
    ):
        """WRITE + WIRE + JUDGE: record this graded attempt through the FULL Zonoid lifecycle.

        ADD (POST /overlay/note, NO force) → daemon autowires candidate edges + marks eager-judge.
        JUDGE (POST /judge/verdict) → clear any pending_dup (markDistinct) so the note is visible,
        and keepEdge to promote the autowired neighbor edge to ranked signal.

        Records BOTH successes and failures with the harness-verified outcome, matching FAISS."""
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
            # NO `force`: let the dup guard + autowire + eager-judge lifecycle run. force:true
            # (CL-2) suppressed both the wiring path and the pending_dup signal the judge needs.
        }
        try:
            r = requests.post(
                f"{self.base_url}/overlay/note", json=payload, timeout=self.timeout
            )
            r.raise_for_status()
            resp = r.json()
        except Exception as e:  # never crash the eval loop over a memory write
            print(f"[ZonoidMemorySystem] add_experience_to_memory write failed: {e}")
            return

        # JUDGE the freshly-written note from the write response (the judge READ queue, GET
        # /judge/next, is workspace-blind over HTTP — we drive verdicts from {pending_dup, match}).
        note_key = resp.get("note_key") or resp.get("key")
        match = (resp.get("match") or {}).get("key")
        verdicts = []
        if resp.get("pending_dup") and note_key and match:
            # The note is retrieval-INVISIBLE until judged. CL experiences are distinct attempts,
            # not the same fact ⇒ markDistinct clears the provisional flag (makes it visible).
            verdicts.append({"markDistinct": {"keys": [note_key, match]}})
        if note_key and match:
            # Promote the autowired weight-0 candidate edge to a ranked (judged) context edge so
            # the wired neighbor is real retrieval signal next round.
            verdicts.append({"keepEdge": {"from": note_key, "to": match}})
        if verdicts:
            self._judge(verdicts)

    # -- internal ---------------------------------------------------------------------

    def _search(self, query, k):
        """GET /search (query-string params). Structured/tiered bundle. Returns hit dicts."""
        params = {
            "q": query or "",
            "k": k,
            "workspace": self.workspace,
            # ungated: always return the ranked top-k regardless of the context-need gate —
            # a fixed-k eval always wants the hits; the gate is for agent token economy. The
            # bundle is still STRUCTURED (tier/via/path) — ungated only drops the inject/abstain
            # annotation, not the tiering.
            "gated": "false",
        }
        r = requests.get(
            f"{self.base_url}/search", params=params, timeout=self.timeout
        )
        r.raise_for_status()
        return r.json().get("results", []) or []

    def _judge(self, verdicts):
        """POST /judge/verdict (workspace-targetable). verdicts is a list of verdict dicts.
        MUST wrap in {verdicts:[...]}: markDistinct is not in the route's bare-body allowlist
        (finding #4), so an unwrapped body is a silent no-op."""
        try:
            r = requests.post(
                f"{self.base_url}/judge/verdict",
                json={"workspace": self.workspace, "verdicts": verdicts},
                timeout=self.timeout,
            )
            r.raise_for_status()
        except Exception as e:  # judging must never crash the eval loop
            print(f"[ZonoidMemorySystem] _judge failed: {e}")


if __name__ == "__main__":
    # Manual smoke check of the FULL lifecycle: write two related experiences (the 2nd trips the
    # dup guard → pending_dup invisible), drive the judge, prove BOTH retrieve, prove isolation.
    import tempfile

    root = tempfile.mkdtemp(prefix="zonoid-cl-selftest-")
    mem = ZonoidMemorySystem("selftest-seq", workspace_root=root, arm="zonoid")
    mem.warm_up()
    mem.add_experience_to_memory(
        "demo-task-1",
        "selftest-seq",
        "fix TimeDelta quantity conversion overflow in to_value",
        "diff --git a/astropy/time/core.py b/astropy/time/core.py\n+    # cast float64",
        True,
    )
    # A semantically-near 2nd experience: trips the 0.70 dup guard → pending_dup → invisible until
    # the lifecycle's markDistinct verdict clears it. If add_experience did its job, it retrieves.
    mem.add_experience_to_memory(
        "demo-task-2",
        "selftest-seq",
        "TimeDelta to_value precision regression on quantity unit conversion",
        "diff --git a/astropy/time/core.py b/astropy/time/core.py\n+    # precision guard",
        False,
    )
    ctx = mem.get_relevant_context_for_prompt(
        "TimeDelta to_value precision conversion", "selftest-seq", 3
    )
    other = ZonoidMemorySystem("other-seq", workspace_root=root, arm="zonoid")
    ctx_other = other.get_relevant_context_for_prompt(
        "TimeDelta to_value precision conversion", "other-seq", 3
    )
    print("SAME workspace retrieval (expect BOTH experiences, incl. the judged dup):")
    print(ctx or "  <EMPTY>")
    print("OTHER workspace retrieval (expect empty):")
    print(ctx_other or "  <EMPTY>")
    assert ctx, "round-trip failed: wrote experiences but retrieved nothing"
    assert "demo-task-2" in ctx, (
        "lifecycle failed: the pending_dup 2nd experience was not made visible by the judge"
    )
    assert not ctx_other, "isolation failed: other workspace saw the notes"
    print("\nOK: full lifecycle (add->wire->judge->tiered retrieval) + isolation verified.")
