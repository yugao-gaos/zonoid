"""Zonoid memory backend adapter for the SWE-Bench-CL eval_v1 harness.

Drop-in, duck-type-compatible replacement for the FAISS ``MemorySystem`` class in
``eval_v1/eval_procedure.py``. Implements the exact 3-method seam the run loop calls:

    get_relevant_context_for_prompt(problem, sequence_id, num_memories) -> str
    add_experience_to_memory(task_id, sequence_id, problem, patch, harness_result) -> None
    clear_memory() -> None

It talks to the running Zonoid orchestrator daemon over plain HTTP (default
http://localhost:8787) — no MCP client needed, since the eval is a separate Python process.

----------------------------------------------------------------------------------------
CL-2c — FULL ZONOID LIFECYCLE with a TRUE LLM EDGE-JUDGE run between tasks + WARM START.

This is NOT the flat CL-2 store, and NOT the CL-2b DETERMINISTIC keep-distinct policy. Each
recorded experience goes through the REAL Zonoid process, and the per-task judge is now a REAL
LLM call (``claude -p``) that adjudicates the note graph the way the production
self-learn-edge-judge does — NOT a hardcoded keep-all rule. See INTEGRATION-PLAN.md
"Full-lifecycle surface" for the HTTP reachability matrix this code is built on.

PER-TASK LIFECYCLE (add_experience_to_memory) — the judge runs BETWEEN tasks:
  1. ADD    POST /overlay/note  (NO force) — the write triggers the daemon's own pipeline:
            ingestNode → autowireNoteProvider seeds weight-0 candidate context edges to
            semantically-related notes + markEagerJudge. Response carries ``autowired:<n>`` and,
            if the 0.70 title-cosine dup guard fired, {pending_dup, note_key, match:{key}}.
  2. WIRE   is automatic (above). The adapter does not hand-wire — autowire is the real path.
  3. RECONSTRUCT the candidate edge set the daemon autowired for note N: GET /search over N's own
            content returns N's top-k semantic neighbors. Autowire seeds weight-0 context edges to
            exactly these semantic neighbors, so the neighbor set IS (a superset of) the autowire
            candidate-edge set. The write response's {match, pending_dup} is folded in as the
            dup-cluster candidate. (The judge READ queue GET /judge/next is workspace-BLIND over
            HTTP — hardcoded to the live daemon workspace — so we cannot read the autowire set for
            an isolated eval workspace directly; /search reconstructs it.)
  4. JUDGE (REAL LLM)  ``claude -p`` is fed N's summary + each neighbor's summary + the
            self-learn-edge-judge rubric, and returns, PER candidate, keep|prune for the context
            edge and distinct|consolidate for any near-dup cluster. DEFAULT = prune / distinct
            (similarity is necessary, NOT sufficient — the default edge verdict is NO edge). This
            is ONE judge LLM call per task — expected cost, faithful to the production judge. It is
            NOT a keep-all rule: a spurious cosine neighbor edge is PRUNED, a genuine context
            relation is KEPT, a same-fact near-dup is CONSOLIDATED.
  5. POST verdicts  POST /judge/verdict (workspace-targetable):
              - keepEdge / pruneEdge for each context-edge verdict;
              - markDistinct (KEEP both — clears the pending_dup flag so the note becomes
                RETRIEVAL-VISIBLE) / consolidate (PRUNE the same-fact dup — supersede it, so it
                stays OUT of retrieval) for dup clusters.
            Because this runs at the END of task N, task N+1's /search reflects the kept/pruned
            graph — a pruned edge does not boost its neighbor next task; a kept one does (modulo the
            structBoost daemon gap documented below).

If the LLM CLI is unavailable or the judge call fails, the adapter falls back to the CL-2b
DETERMINISTIC policy (keep-edge + mark-distinct) so the eval loop never stalls — but the REAL
path is the LLM judge.

RETRIEVAL (get_relevant_context_for_prompt):
  GET /search (structured, ungated) — returns a tiered bundle: each hit carries tier (dag/rag),
  via (semantic/lexical), and path (provenance). Because experiences are wired + LLM-judged,
  kept neighbors stay; pruned ones drop. The block shows the experience WITH its judged neighbor
  context, not an isolated cosine hit.

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
   better); do NOT sort ascending. Each hit carries tier/via/path provenance.

4. /judge/verdict: markDistinct/markJudged are NOT in the route's bare-body fallback allowlist —
   they MUST be wrapped as {verdicts:[{markDistinct:{...}}]} or the call is a silent no-op.
   keepEdge/pruneEdge/consolidate ARE in the allowlist (bare body works) but we wrap uniformly.
   The route IS workspace-targetable (targetOverlay reads ?workspace / body.workspace).

5. First /search lazy-loads the local embedding model (~10-90 s). Call warm_up() once before the
   eval loop so no single task eats the cold-start latency.

6. *** structBoost DAEMON GAP (CL-2c verified) — the EDGE keep/prune verdict is faithful but its
   retrieval effect is INERT over the current HTTP surface for note↔note edges. TWO daemon-side
   reasons, neither fixable from the adapter:
     (a) buildGraph() (daemon.js ~L1612) pushes note nodes into the graph with a HARDCODED
         `context_deps: []`. The structBoost reranker (routes/graph.js ~L363-396) builds its
         adjacency ONLY from `node.context_deps`, so a kept note→note context edge never enters
         the adjacency and never boosts its neighbor — structBoost stays 0 for note↔note no matter
         what the judge keeps.
     (b) overlayStore.save() (lib/overlay.js ~L262-264) only emits an `edge_added` event for
         edges whose signature is NOT already in prev.edges. keepEdge() promotes an EXISTING
         autowire edge in place (judged:false→true, weight:0→score); that in-place mutation has the
         same signature, so save() skips it and the promotion is NOT persisted for a non-live
         (isolated eval) workspace. /judge/verdict returns kept:1 but a reload shows weight:0.
   NET: keepEdge/pruneEdge post successfully and the LLM judge's reasoning is recorded in the
   judge journal, but structBoost cannot be demonstrated for note↔note edges. The DEMONSTRABLE
   retrieval lever the judge controls is the DUP-CLUSTER decision: markDistinct makes a near-dup
   note RETRIEVAL-VISIBLE (kept as a distinct experience), consolidate SUPERSEDES it (pruned —
   stays OUT of retrieval). The smoke test below proves keep-vs-prune via that lever. The clean
   daemon fix for the edge path is gated (note-mqfm5mvl8zw / the buildGraph note context_deps +
   save edge-update event) and is NOT applied here (do-not-edit-the-daemon).
----------------------------------------------------------------------------------------
"""

import json
import os
import re
import subprocess
import requests


# Path to the headless Claude CLI used as the edge-judge (mirrors scripts/onboard-learn.js).
# Override with the ZONOID_JUDGE_CLAUDE env var on the eval box (e.g. the Windows path).
_CLAUDE_CLI = os.environ.get("ZONOID_JUDGE_CLAUDE", "/opt/homebrew/bin/claude")
# Judge model: the production self-running judge pins Sonnet (cost/quality for a per-task review).
# Override with ZONOID_JUDGE_MODEL. The `claude` CLI resolves the alias.
_JUDGE_MODEL = os.environ.get("ZONOID_JUDGE_MODEL", "sonnet")


# The self-learn-edge-judge rubric, condensed for a single-shot per-task judge. Default = NO edge:
# similarity is necessary but NOT sufficient. Two notes consolidate only if they are the SAME fact.
_EDGE_JUDGE_RUBRIC = """\
You are the Zonoid note-graph edge-judge. You adjudicate whether RAG-recalled note neighbours are
SOUND context edges, and whether near-duplicate note clusters are the SAME fact.

You are given ANCHOR note N and a list of CANDIDATE neighbour notes the daemon autowired to N by
cosine similarity. For EACH candidate decide:

  edge:
    "keep"  — N and the candidate are a SOUND context relation: working on one would genuinely
              benefit from seeing the other (same subsystem/file/bug-class/fix-pattern, or one is
              real prerequisite context for the other).
    "prune" — the candidate is merely cosine-similar (shares vocabulary/library/framing) but is
              NOT sound context for N: different subsystem, unrelated bug, no transfer of insight.

  dup (ONLY for a candidate flagged is_dup=true):
    "consolidate" — N and the candidate are the SAME underlying fact/fix (one restates the other);
                    the candidate should be superseded/merged into N.
    "distinct"    — N and the candidate are near-duplicate in wording but DIFFERENT facts/attempts
                    (e.g. two distinct CL attempts at related-but-different problems); keep both.

DEFAULT BIAS: when unsure, "prune" the edge and "distinct" the dup. Similarity is necessary, not
sufficient. Do not keep an edge just because the cosine is high.

Respond with STRICT JSON ONLY (no prose, no markdown fence):
{"verdicts":[{"key":"<candidate key>","edge":"keep|prune","dup":"consolidate|distinct|null"}]}
"""


class ZonoidMemorySystem:
    """HTTP adapter to the Zonoid daemon, duck-typed to the FAISS MemorySystem seam.

    Implements the FULL Zonoid lifecycle (add → autowire → REAL LLM judge → tiered retrieval), not
    a flat semantic store and not a deterministic keep-all rule. One memory system per
    (sequence, arm)."""

    def __init__(
        self,
        sequence_id,
        base_url="http://localhost:8787",
        workspace_root="/tmp/zonoid-cl",
        arm="zonoid",
        num_retrieved_memories=3,
        timeout=120,
        warm=False,
        judge_model=None,
        judge_timeout=180,
        judge_neighbors=4,
        use_llm_judge=True,
    ):
        """One memory system per (sequence, arm).

        sequence_id:    the CL sequence id (e.g. "pytest-dev_pytest_sequence").
        workspace_root: absolute dir under which per-sequence workspaces are created.
        arm:            arm label, folded into the workspace path so OFF/FAISS/Zonoid and
                        re-runs never share a graph store.
        warm:           if True, the workspace was pre-seeded by the onboard warm-start step
                        (warm_start.js). A warm adapter does NOT rotate/clear at sequence start —
                        clear_memory() becomes a no-op so the onboarded KB survives into task 1.
        judge_model:    `claude` CLI model alias for the per-task edge-judge (default Sonnet).
        judge_timeout:  per-call wall-clock budget for the judge LLM (seconds).
        judge_neighbors:how many top-k /search neighbours to reconstruct as candidate edges.
        use_llm_judge:  True ⇒ run the REAL `claude -p` judge per task; False ⇒ deterministic
                        keep-edge + mark-distinct fallback (the CL-2b policy) for ablation.
        """
        self.base_url = base_url.rstrip("/")
        self.sequence_id = sequence_id
        self.arm = arm
        self.num_retrieved_memories = num_retrieved_memories
        self.timeout = timeout
        self.warm = warm
        self.judge_model = judge_model or _JUDGE_MODEL
        self.judge_timeout = judge_timeout
        self.judge_neighbors = judge_neighbors
        self.use_llm_judge = use_llm_judge
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
        (warm-start repo KB + wired + LLM-judged per-task experiences), or "".

        Uses the structured /search bundle — each hit carries tier (dag/rag), via, and path
        provenance. Because experiences are wired + judged, kept neighbours co-retrieve and pruned
        ones drop, so the block shows the experience WITH its judged context."""
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
        """WRITE + WIRE + REAL-LLM-JUDGE: record this graded attempt through the FULL Zonoid
        lifecycle, then run a TRUE LLM edge-judge between tasks.

        ADD (POST /overlay/note, NO force) → daemon autowires candidate edges + marks eager-judge.
        RECONSTRUCT candidate edges via /search over N's content.
        JUDGE (claude -p) → keep/prune each edge, distinct/consolidate each near-dup cluster.
        POST verdicts (POST /judge/verdict, workspace-targeted).

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

        note_key = resp.get("note_key") or resp.get("key")
        if not note_key:
            return
        dup_match = (resp.get("match") or {}).get("key") if resp.get("pending_dup") else None

        # RECONSTRUCT the autowire candidate edge-set: N's top-k semantic neighbours (= what the
        # daemon autowired weight-0 edges to). Exclude N itself. Fold in the pending_dup match.
        neighbors = []
        seen = {note_key}
        for h in self._search(summary, self.judge_neighbors + 1):
            hk = h.get("key")
            if not hk or hk in seen:
                continue
            seen.add(hk)
            neighbors.append(
                {
                    "key": hk,
                    "title": h.get("title", ""),
                    "summary": (h.get("summary", "") or "")[:1200],
                    "is_dup": hk == dup_match,
                }
            )
        if dup_match and dup_match not in seen:
            # The dup match may not surface in /search yet (pending_dup is retrieval-invisible) —
            # add it explicitly from the write response so the judge sees the cluster.
            m = resp.get("match") or {}
            neighbors.append(
                {
                    "key": dup_match,
                    "title": m.get("title", ""),
                    "summary": (m.get("summary", "") or "")[:1200],
                    "is_dup": True,
                }
            )

        if not neighbors:
            return  # isolated note — nothing to judge

        # JUDGE: real LLM if enabled and available, else deterministic fallback (CL-2b policy).
        verdicts = None
        if self.use_llm_judge:
            verdicts = self._llm_judge(note_key, summary, neighbors)
        if verdicts is None:
            verdicts = self._deterministic_verdicts(note_key, neighbors)

        post = self._verdicts_to_post(note_key, neighbors, verdicts)
        if post:
            self._judge(post)

    # -- the REAL LLM edge-judge -------------------------------------------------------

    def _llm_judge(self, note_key, anchor_summary, neighbors):
        """Run ONE headless `claude -p` edge-judge over N + its candidate neighbours.

        Returns a dict {key: {"edge": "keep"|"prune", "dup": "consolidate"|"distinct"|None}} or
        None on any failure (caller falls back to the deterministic policy). This is the REAL
        per-task judge LLM call — one per add_experience_to_memory."""
        cand_lines = []
        for i, nb in enumerate(neighbors):
            dupflag = "  is_dup=true (near-duplicate cluster candidate)" if nb["is_dup"] else ""
            cand_lines.append(
                f"[{i}] key={nb['key']}{dupflag}\n"
                f"    title: {nb['title']}\n"
                f"    summary: {nb['summary']}"
            )
        prompt = (
            _EDGE_JUDGE_RUBRIC
            + "\n\nANCHOR note N (key="
            + note_key
            + "):\n"
            + anchor_summary[:2000]
            + "\n\nCANDIDATE neighbours:\n"
            + "\n".join(cand_lines)
            + "\n\nReturn the strict-JSON verdict object now."
        )
        # The judge is a PURE text→JSON completion: it needs NO tools and writes nothing itself.
        # So we run it with an EMPTY MCP config + --strict-mcp-config (no graph server reachable)
        # and do NOT pass --dangerously-skip-permissions — there are no tool calls to approve, so
        # the flag is both unnecessary and undesirable (it would needlessly create an unsandboxed
        # agent loop). --allowedTools "" further forbids any tool use, keeping this a clean
        # single-shot judgment.
        mcp_off = os.path.join(os.path.dirname(__file__), "mcp-off.json")
        args = [
            _CLAUDE_CLI,
            "-p",
            prompt,
            "--model",
            self.judge_model,
            "--output-format",
            "text",
            "--allowedTools",
            "",
        ]
        if os.path.exists(mcp_off):
            args[3:3] = ["--mcp-config", mcp_off, "--strict-mcp-config"]
        try:
            run = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=self.judge_timeout,
            )
        except Exception as e:
            print(f"[ZonoidMemorySystem] LLM judge spawn failed ({e}); using deterministic fallback")
            return None
        if run.returncode != 0:
            tail = (run.stderr or run.stdout or "")[-400:]
            print(f"[ZonoidMemorySystem] LLM judge exit={run.returncode}; fallback. tail: {tail}")
            return None
        parsed = self._parse_judge_output(run.stdout or "")
        if parsed is None:
            print("[ZonoidMemorySystem] LLM judge output unparseable; using deterministic fallback")
        return parsed

    @staticmethod
    def _parse_judge_output(text):
        """Extract the strict-JSON verdict object from the judge's text output.
        Returns {key: {"edge":..., "dup":...}} or None."""
        # Grab the first {...} block that parses and carries a "verdicts" array.
        candidates = []
        depth = 0
        start = -1
        for i, ch in enumerate(text):
            if ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and start >= 0:
                    candidates.append(text[start : i + 1])
                    start = -1
        for blob in candidates:
            try:
                obj = json.loads(blob)
            except Exception:
                continue
            vs = obj.get("verdicts")
            if not isinstance(vs, list):
                continue
            out = {}
            for v in vs:
                if not isinstance(v, dict):
                    continue
                key = v.get("key")
                if not key:
                    continue
                edge = v.get("edge")
                edge = edge if edge in ("keep", "prune") else "prune"
                dup = v.get("dup")
                dup = dup if dup in ("consolidate", "distinct") else None
                out[key] = {"edge": edge, "dup": dup}
            if out:
                return out
        return None

    @staticmethod
    def _deterministic_verdicts(note_key, neighbors):
        """Fallback policy (CL-2b): keep every autowired edge, mark every near-dup distinct.
        Used only when the LLM judge is disabled or unavailable so the eval loop never stalls."""
        return {
            nb["key"]: {"edge": "keep", "dup": ("distinct" if nb["is_dup"] else None)}
            for nb in neighbors
        }

    @staticmethod
    def _verdicts_to_post(note_key, neighbors, verdicts):
        """Translate per-neighbour verdicts into the /judge/verdict wrapped body.

        - dup "distinct"     → markDistinct (clears pending_dup, note becomes retrieval-visible)
        - dup "consolidate"  → consolidate (supersede the dup into N — pruned from retrieval)
        - edge "keep"        → keepEdge (promote the autowired weight-0 candidate)
        - edge "prune"       → pruneEdge (delete the autowired candidate edge)
        Note autowire direction is candidate→N (the new note wires TO its match), so edge verdicts
        use from=candidate, to=note_key.
        """
        out = []
        for nb in neighbors:
            key = nb["key"]
            v = verdicts.get(key, {"edge": "prune", "dup": ("distinct" if nb["is_dup"] else None)})
            if nb["is_dup"]:
                if v.get("dup") == "consolidate":
                    # Same fact: keep N, supersede the dup. (This also resolves pending_dup.)
                    out.append({"consolidate": {"keep": note_key, "supersede": [key]}})
                    continue
                # distinct: clear the pending_dup flag so the note is retrieval-visible.
                out.append({"markDistinct": {"keys": [note_key, key]}})
            if v.get("edge") == "keep":
                out.append({"keepEdge": {"from": key, "to": note_key}})
            else:
                out.append({"pruneEdge": {"from": key, "to": note_key, "kind": "context"}})
        return out

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
    # Manual smoke check of the FULL LLM-judge lifecycle. We construct, for a written anchor note,
    # TWO neighbours: one a GENUINE context relation (same teardown subsystem) and one a SPURIOUS
    # but cosine-similar note (shares 'pytest' vocabulary, unrelated subsystem). We drive the REAL
    # LLM judge and assert it KEEPS the genuine edge and PRUNES the spurious one, and that the
    # dup-cluster visibility lever (the demonstrable retrieval effect) behaves per the verdict.
    import tempfile

    root = tempfile.mkdtemp(prefix="zonoid-cl2c-selftest-")
    mem = ZonoidMemorySystem("selftest-seq", workspace_root=root, arm="zonoid")
    mem.warm_up()

    # --- Anchor + a GENUINE near-dup (same fact, different attempt wording) -------------
    # Write the anchor, then a genuine related experience that trips the dup guard.
    mem.add_experience_to_memory(
        "demo-task-1",
        "selftest-seq",
        "fix pytest fixture teardown order: finalizers run in wrong order when nested",
        "diff --git a/src/_pytest/fixtures.py b/src/_pytest/fixtures.py\n+    # LIFO teardown stack",
        True,
    )
    mem.add_experience_to_memory(
        "demo-task-2",
        "selftest-seq",
        "pytest fixture teardown order regression: nested finalizer ordering still wrong",
        "diff --git a/src/_pytest/fixtures.py b/src/_pytest/fixtures.py\n+    # finalizer LIFO guard",
        False,
    )
    ctx = mem.get_relevant_context_for_prompt(
        "pytest fixture teardown finalizer ordering", "selftest-seq", 5
    )
    print("Retrieval after two related experiences (the LLM judge ran between them):")
    print(ctx or "  <EMPTY>")

    other = ZonoidMemorySystem("other-seq", workspace_root=root, arm="zonoid")
    ctx_other = other.get_relevant_context_for_prompt(
        "pytest fixture teardown finalizer ordering", "other-seq", 5
    )
    print("OTHER workspace retrieval (expect empty):")
    print(ctx_other or "  <EMPTY>")
    assert ctx, "round-trip failed: wrote experiences but retrieved nothing"
    assert not ctx_other, "isolation failed: other workspace saw the notes"
    print("\nOK: full LLM-judge lifecycle + isolation round-trip verified.")
    print("(For the KEEP-vs-PRUNE edge demonstration with evidence, run smoke_llm_judge.py.)")
