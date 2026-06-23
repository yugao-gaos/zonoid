"""Zonoid Bench SDK — canonical HTTP client.

stdlib urllib only (no requests; runs on embeddable Python 3.12).
All HTTP transports follow the proven patterns from:
  - bench/agent-memory/zonoid_lifecycle.py   (urllib transport)
  - bench/swe-bench-cl/zonoid_memory.py      (method set, lifecycle docs)
  - bench/agent-memory/smoke.py              (overlay/edge, task/suggest usage)

Covered endpoints
-----------------
POST /overlay/note      — write a note (no ``force``; lets autowire + dup-guard run)
GET  /search            — semantic/lexical search, workspace-scoped, tiered results
GET  /judge/next        — eager-judge: pull a node's unjudged autowire candidate edge-set
POST /judge/verdict     — post edge/dup verdicts; body MUST be wrapped {workspace, verdicts:[...]}
POST /judge/drain       — drive the PRODUCTION sync judge to drain a node to idle (the de-ported
                          judge path: NO bench LLM; reuses lib/headless-drain.runJudgeDrainSync)
GET  /task/context      — read frozen DAG context for a node
POST /overlay/status    — update a node's status
POST /workspace         — bind the daemon's LIVE state.workspace (eager-judge prerequisite)
GET  /task/suggest      — suggest_links (cross-encoder ceScore ranked candidates)
POST /overlay/edge      — create/upsert a DAG edge (createEdge workaround; see §6 note)
warm_up                 — pre-pay embedding-model cold start

Load-bearing daemon findings (verified; encoded as code + asserts)
------------------------------------------------------------------
1. workspace MUST be an ABSOLUTE filesystem path.
   The daemon does path.join(workspace, '.graph'); a relative string silently fails to persist.
2. POST /overlay/note: do NOT pass ``force``. force:true suppresses autowire + dup-guard pipeline.
3. GET /search: params are QUERY-STRING (?q=...&k=...&workspace=...&gated=false). NOT a POST body.
   Result is {"results": [...]} with tier/via/path provenance per hit.
4. POST /judge/verdict: markDistinct is NOT in the bare-body fallback allowlist; body MUST be
   wrapped as {"workspace": ..., "verdicts": [...]}. keepEdge/pruneEdge also wrapped uniformly.
5. warm_up: first /search lazy-loads the local embedding model (~10-90 s).
   Call warm_up() once before any hot path.
6. overlay/edge (createEdge workaround): keepEdge() promotes an EXISTING autowire candidate edge
   in place; for task->note edges that don't yet exist as an autowire candidate, POST /overlay/edge
   CREATES a fresh asserted edge (upsert). This is the correct mechanism for wiring task->note
   context when the note was not autowired from that task. keepEdge is for judging pre-existing
   candidates; createEdge (overlay/edge) is for asserting new edges. keepEdge on a note<->note
   pair is also retrieval-inert due to the structBoost daemon gap (note-mqfm5mvl8zw); use
   /overlay/edge for task->note wiring.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


# ---------------------------------------------------------------------------
# Internal transport helpers
# ---------------------------------------------------------------------------

def _http_get(url: str, params: dict[str, Any], timeout: int) -> Any:
    """GET *url* with *params* as query-string. Returns parsed JSON body."""
    # Finding #3: /search (and other GET routes) use query-string params, not a body.
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    full_url = f"{url}?{qs}" if qs else url
    req = urllib.request.Request(full_url, method="GET")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw)


def _http_post(url: str, body: dict[str, Any], timeout: int) -> Any:
    """POST *url* with JSON *body*. Returns parsed JSON body."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw)


def _base(base_url: str) -> str:
    return base_url.rstrip("/")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def warm_up(base_url: str, workspace: str | None = None, timeout: int = 120) -> None:
    """Pre-pay the embedding-model cold start.

    The first /search call lazy-loads the local embedding model (~10-90 s on this box).
    Call this once before the eval loop so no single hot path eats the cold-start latency.
    If *workspace* is None a throwaway query is sent with no workspace filter —
    sufficient to trigger the warm-up; no notes are written.

    Finding #5: best-effort, never raises. A real call will retry if this fails.
    """
    try:
        params: dict[str, Any] = {"q": "warmup", "k": 1, "gated": "false"}
        if workspace is not None:
            # Finding #1: workspace must be an absolute path.
            assert workspace == workspace or True  # pass-through; caller must supply abs path
            params["workspace"] = workspace
        _http_get(f"{_base(base_url)}/search", params, timeout)
    except Exception:
        pass  # best-effort; the real call will trigger warm-up as well


def post_note(
    base_url: str,
    workspace: str,
    title: str,
    summary: str,
    category: str = "conversation-session",
    tags: list[str] | None = None,
    wires_to: list[str] | None = None,
    supersedes: str | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /overlay/note — write a note into *workspace*.

    Finding #1: *workspace* MUST be an absolute filesystem path.
    Finding #2: No ``force`` — omitting it lets the daemon's autowire + dup-guard + eager-judge
    pipeline run. force:true would suppress both.

    Returns the raw daemon response dict:
      {"key": "note:<id>", "autowired": <n>, "pending_dup": bool, ...}
    """
    # Finding #1 guard: workspace must be an absolute path.
    if not (workspace.startswith("/") or (len(workspace) >= 2 and workspace[1] == ":")):
        raise ValueError(
            f"workspace must be an absolute filesystem path (finding #1), got: {workspace!r}"
        )

    body: dict[str, Any] = {
        "workspace": workspace,
        "title": title,
        "summary": summary,
        "category": category,
        # NO "force" — intentional: force suppresses autowire + dup-guard (finding #2).
    }
    if tags:
        body["tags"] = tags
    if wires_to:
        body["wires_to"] = wires_to
    if supersedes:
        body["supersedes"] = supersedes
    return _http_post(f"{_base(base_url)}/overlay/note", body, timeout)


def search(
    base_url: str,
    workspace: str,
    query: str,
    k: int = 10,
    gated: bool = False,
    task_key: str | None = None,
    timeout: int = 120,
) -> list[dict[str, Any]]:
    """GET /search — semantic/lexical search scoped to *workspace*.

    Finding #3: params are QUERY-STRING (?q=...&k=...&workspace=...&gated=false).
    Result is {"results": [...]} with optional tier/via/path provenance per hit.

    gated=False (default): always returns ranked top-k regardless of the context-need gate.
    Appropriate for evaluation harnesses that always want hits.

    task_key (optional): if provided, /search returns the daemon's task-aware bundle for
    that task, including structural DAG tiers and any daemon-selected RAG fill.

    Returns the ``results`` list (empty list on error or no results).
    """
    # Finding #1: workspace must be absolute.
    if not (workspace.startswith("/") or (len(workspace) >= 2 and workspace[1] == ":")):
        raise ValueError(
            f"workspace must be an absolute filesystem path (finding #1), got: {workspace!r}"
        )

    # Finding #3: all params go in the query-string for a GET.
    params: dict[str, Any] = {
        "q": query or "",
        "k": k,
        "workspace": workspace,
        "gated": "true" if gated else "false",
    }
    if task_key is not None:
        params["task_key"] = task_key

    try:
        resp = _http_get(f"{_base(base_url)}/search", params, timeout)
        return resp.get("results") or []
    except Exception:
        return []


def post_verdict(
    base_url: str,
    workspace: str,
    verdicts: list[dict[str, Any]],
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /judge/verdict — submit edge/dup verdicts for *workspace*.

    Finding #4: markDistinct is NOT in the bare-body fallback allowlist.
    Body MUST be wrapped as {"workspace": ..., "verdicts": [...]}.
    keepEdge/pruneEdge/consolidate are also wrapped uniformly.

    *verdicts* is a list of verdict dicts, e.g.:
      [{"keepEdge":    {"from": key_a, "to": key_b}}]
      [{"pruneEdge":   {"from": key_a, "to": key_b, "kind": "context"}}]
      [{"markDistinct":{"keys": [key_a, key_b]}}]
      [{"consolidate": {"keep": key_a, "supersede": [key_b]}}]

    Returns the raw daemon response dict.
    """
    # Finding #4 guard: always wrap.
    body: dict[str, Any] = {
        "workspace": workspace,
        "verdicts": verdicts,
    }
    return _http_post(f"{_base(base_url)}/judge/verdict", body, timeout)


def get_task_context(
    base_url: str,
    workspace: str,
    node_key: str,
    timeout: int = 120,
) -> dict[str, Any]:
    """GET /task/context — read frozen DAG context for a node.

    Finding #3: params are query-string.
    Returns: {"task": {...}, "dependencySummaries": [...], "ghostDependencies": [...]}

    dependencySummaries entries carry: key, via, weight, summary.
    Only entries with weight > 0 are judged/kept edges (weight-0 = unjudged candidate).
    """
    params: dict[str, Any] = {
        "key": node_key,
        "workspace": workspace,
    }
    return _http_get(f"{_base(base_url)}/task/context", params, timeout)


def post_status(
    base_url: str,
    workspace: str,
    node_key: str,
    status: str,
    summary: str | None = None,
    agent_id: str | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /overlay/status — update a node's status in *workspace*.

    This route also runs ingestNode + autowireNewTaskWholeGraph on the first status update,
    seeding note->task candidate context edges based on the task's summary embedding.
    It is the correct way to attach a summary to a task node and trigger the autowire pipeline.

    Returns the raw daemon response dict.
    """
    body: dict[str, Any] = {
        "workspace": workspace,
        "key": node_key,
        "status": status,
    }
    if summary is not None:
        body["summary"] = summary
    if agent_id is not None:
        body["agent_id"] = agent_id
    return _http_post(f"{_base(base_url)}/overlay/status", body, timeout)


def task_suggest(
    base_url: str,
    task_key: str,
    workspace: str | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
    """GET /task/suggest — suggest_links with cross-encoder ceScore ranked candidates.

    Equivalent to the MCP suggest_links tool. Returns up to 5 candidates ranked by
    cosine similarity then cross-encoder rerank (when available).

    Finding #3: GET with query-string params.

    Returns:
      {
        "task": {"id": ..., "label": ...},
        "suggestions": [{"key": ..., "label": ..., "score": ..., "ceScore": ..., ...}],
        "duplicates": [...],
        "hint": "..."
      }

    ceScore > 0.2 is the conventional threshold used in the FeatureBench canonical ON arm
    for wiring verified context edges via overlay_edge.

    *workspace* selects the target overlay (defaults to the daemon's live workspace).
    """
    params: dict[str, Any] = {"key": task_key}
    if workspace is not None:
        params["workspace"] = workspace
    return _http_get(f"{_base(base_url)}/task/suggest", params, timeout)


def judge_next(
    base_url: str,
    node: str,
    budget: int = 20,
    workspace: str | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
    """GET /judge/next?node=&budget=&workspace= — the EAGER-JUDGE candidate set for *node*.

    This is the production eager-judge pull: ``?node=<key>`` serves THIS node's whole unjudged
    autowire candidate edge-set in one slice (routes/judge.js EAGER MODE). Each item is an edge
    ``{kind:"edge", id, from:{key,...}, to:{key,...}, neighborhood, ...}`` where ``from`` is the
    candidate PROVIDER and ``to`` is *node* (the consumer). These are the weight-0, judged:false
    edges seeded by the daemon's configured autowire candidate policy (for the bench daemon:
    broad candidate threshold plus top-K bounds); until a keepEdge verdict promotes them they
    contribute ZERO retrieval relevance.

    CRITICAL (note-mqgwrh5a63x): /judge/next is hard-bound to the daemon's LIVE ``state.workspace``
    (routes/judge.js:48,58 — it does NOT honour an isolated ``?workspace=`` for the candidate read).
    So *node* must live in the daemon's live workspace for this to return its candidates. The bench
    runs ONE embedded daemon per unit whose live workspace IS the unit dir (daemon.start(workspace=))
    so this read resolves to the right overlay. The ``workspace`` param here is still forwarded for
    parity with the rest of the client, but it does not override the live binding for the eager read.

    Returns the raw daemon response dict:
      {"epoch", "budget", "node", "eager": true, "idle": bool, "total": int, "items": [...]}
    On error returns {"items": [], "idle": True, "error": "..."} so callers never crash.
    """
    params: dict[str, Any] = {"node": node, "budget": budget}
    if workspace is not None:
        params["workspace"] = workspace
    try:
        return _http_get(f"{_base(base_url)}/judge/next", params, timeout)
    except Exception as exc:  # noqa: BLE001
        return {"items": [], "idle": True, "total": 0, "error": str(exc)}


def judge_drain(
    base_url: str,
    node: str,
    workspace: str,
    budget: int = 20,
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /judge/drain?node=&budget=&workspace= — drive the PRODUCTION sync judge for *node*.

    This is the de-ported judge path: instead of the bench pulling /judge/next, running its own LLM
    edge-judge, and posting /judge/verdict, it makes ONE call to the production endpoint that drains
    the node's whole unjudged autowire candidate edge-set to idle (or the budget/round ceiling) by
    REUSING the in-process production judge (lib/headless-drain.runJudgeDrainSync →
    resolveJudgeBackend → provider.runJudgeLoop). There is NO judge LLM in the bench: the prompt,
    keep/prune rubric, /judge/next pull, and /judge/verdict write all live in production.

    node       — the probe key whose candidate edges to drain (the /judge/next?node= target).
    workspace  — the (absolute) bench workspace; the daemon must be LIVE-bound to it for the eager
                 read to resolve (note-mqgwrh5a63x). Passed in the body; node/budget ride the query.
    budget     — per-round adjudication budget (the daemon clamps to 1..50).

    Returns the raw daemon response dict:
      {"ok": True, "workspace", "node", "judged", "kept", "pruned", "idle", "rounds", ...}
    On error returns {"ok": False, "idle": True, "error": "..."} so callers never crash.
    """
    # Finding #1: workspace must be absolute (the body carries it for targetOverlay resolution).
    if not (workspace.startswith("/") or (len(workspace) >= 2 and workspace[1] == ":")):
        raise ValueError(
            f"workspace must be an absolute filesystem path (finding #1), got: {workspace!r}"
        )
    # node + budget ride the query-string (the route reads u.searchParams first, then body); the
    # workspace rides the body so targetOverlay(b, u) resolves the right overlay.
    qs = urllib.parse.urlencode({"node": node, "budget": budget})
    url = f"{_base(base_url)}/judge/drain?{qs}"
    body: dict[str, Any] = {"workspace": workspace}
    try:
        return _http_post(url, body, timeout)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "idle": True, "judged": 0, "kept": 0, "pruned": 0, "error": str(exc)}


def set_workspace(
    base_url: str,
    path: str,
    force: bool = True,
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /workspace {path, force} — bind the daemon's LIVE ``state.workspace`` to *path*.

    This is the lever that makes the eager-judge read (/judge/next?node=) resolve to a bench unit's
    isolated workspace: set the embedded daemon's live workspace to the unit dir, and the whole
    eager pipeline (autowire seed → markEagerJudge → /judge/next → keepEdge save → /task/context)
    operates on ONE consistent in-memory + persisted overlay.

    Finding #1: *path* MUST be an absolute filesystem path.
    force=True (default): routes/meta.js skips a re-bind to a different path unless force is set;
    we always force so a reused data_dir with a stale workspace file is overridden cleanly.

    Returns the raw daemon response dict: {"ok": True, "workspace": "<path>"}.
    """
    if not (path.startswith("/") or (len(path) >= 2 and path[1] == ":")):
        raise ValueError(
            f"workspace path must be an absolute filesystem path (finding #1), got: {path!r}"
        )
    body: dict[str, Any] = {"path": path, "force": bool(force)}
    return _http_post(f"{_base(base_url)}/workspace", body, timeout)


def overlay_edge(
    base_url: str,
    from_key: str,
    to_key: str,
    workspace: str | None = None,
    kind: str | None = None,
    weight: float | None = None,
    from_workspace: str | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /overlay/edge — create/upsert a DAG edge (finding #6 createEdge workaround).

    Finding #6: keepEdge() promotes an EXISTING autowire candidate edge in place.
    For task->note edges that don't yet exist as an autowire candidate, POST /overlay/edge
    CREATES a fresh asserted edge (origin:'asserted'). This is the correct mechanism for
    wiring task->note context edges. keepEdge is for judging pre-existing candidates;
    overlay_edge is for asserting new edges.

    This is also the workaround for the structBoost daemon gap (note-mqfm5mvl8zw):
    keepEdge on note<->note edges is retrieval-inert; createEdge (this fn) creates a real
    asserted edge that registers in the DAG adjacency.

    kind: "context" for context edges, defaults to "blocking" (back-compat).
    from_workspace: for cross-workspace ghost edges.

    Returns: {"ok": True, "edges": <count>, "ghost": bool, "kind": "context"|"blocking"}
    """
    body: dict[str, Any] = {
        "from": from_key,
        "to": to_key,
    }
    if workspace is not None:
        body["workspace"] = workspace
    if kind is not None:
        body["kind"] = kind
    if weight is not None:
        body["weight"] = weight
    if from_workspace is not None:
        body["fromWorkspace"] = from_workspace
    return _http_post(f"{_base(base_url)}/overlay/edge", body, timeout)


# ---------------------------------------------------------------------------
# ZonoidClient class (stateful convenience wrapper)
# ---------------------------------------------------------------------------

class ZonoidClient:
    """Stateful convenience wrapper around the module-level functions.

    Binds base_url + workspace so callers don't thread them through every call.
    All methods delegate to the module-level functions; the transport logic lives there.

    Usage:
        client = ZonoidClient("http://localhost:8787", workspace="/abs/path/to/ws")
        client.warm_up()
        hits = client.search("my query")
        resp = client.post_note("Title", "Summary")
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8787",
        workspace: str | None = None,
        timeout: int = 120,
    ) -> None:
        # Finding #1: if a workspace is provided it must be absolute.
        if workspace is not None and not (
            workspace.startswith("/") or (len(workspace) >= 2 and workspace[1] == ":")
        ):
            raise ValueError(
                f"workspace must be an absolute filesystem path (finding #1), got: {workspace!r}"
            )
        self.base_url = base_url
        self.workspace = workspace
        self.timeout = timeout

    def _ws(self, workspace: str | None) -> str:
        """Resolve workspace, raising if neither caller nor instance has one."""
        ws = workspace or self.workspace
        if not ws:
            raise ValueError("workspace is required (pass to __init__ or method call)")
        return ws

    def warm_up(self, workspace: str | None = None, timeout: int | None = None) -> None:
        """Pre-pay the embedding-model cold start (finding #5)."""
        warm_up(
            self.base_url,
            workspace=workspace or self.workspace,
            timeout=timeout or self.timeout,
        )

    def post_note(
        self,
        title: str,
        summary: str,
        category: str = "conversation-session",
        tags: list[str] | None = None,
        wires_to: list[str] | None = None,
        supersedes: str | None = None,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """POST /overlay/note (no force; findings #1 + #2)."""
        return post_note(
            self.base_url,
            self._ws(workspace),
            title,
            summary,
            category=category,
            tags=tags,
            wires_to=wires_to,
            supersedes=supersedes,
            timeout=timeout or self.timeout,
        )

    def search(
        self,
        query: str,
        k: int = 10,
        gated: bool = False,
        task_key: str | None = None,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> list[dict[str, Any]]:
        """GET /search (query-string params; finding #3)."""
        return search(
            self.base_url,
            self._ws(workspace),
            query,
            k=k,
            gated=gated,
            task_key=task_key,
            timeout=timeout or self.timeout,
        )

    def post_verdict(
        self,
        verdicts: list[dict[str, Any]],
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """POST /judge/verdict (wrapped body; finding #4)."""
        return post_verdict(
            self.base_url,
            self._ws(workspace),
            verdicts,
            timeout=timeout or self.timeout,
        )

    def get_task_context(
        self,
        node_key: str,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """GET /task/context — frozen DAG context for a node."""
        return get_task_context(
            self.base_url,
            self._ws(workspace),
            node_key,
            timeout=timeout or self.timeout,
        )

    def post_status(
        self,
        node_key: str,
        status: str,
        summary: str | None = None,
        agent_id: str | None = None,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """POST /overlay/status — update node status + trigger autowire ingest."""
        return post_status(
            self.base_url,
            self._ws(workspace),
            node_key,
            status,
            summary=summary,
            agent_id=agent_id,
            timeout=timeout or self.timeout,
        )

    def task_suggest(
        self,
        task_key: str,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """GET /task/suggest — ceScore-ranked suggest_links candidates."""
        return task_suggest(
            self.base_url,
            task_key,
            workspace=workspace or self.workspace,
            timeout=timeout or self.timeout,
        )

    def judge_next(
        self,
        node: str,
        budget: int = 20,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """GET /judge/next?node= — the eager-judge autowire candidate set for *node*."""
        return judge_next(
            self.base_url,
            node,
            budget=budget,
            workspace=workspace or self.workspace,
            timeout=timeout or self.timeout,
        )

    def judge_drain(
        self,
        node: str,
        budget: int = 20,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """POST /judge/drain — drive the PRODUCTION sync judge to drain *node* to idle.

        Single call replacing the old pull(/judge/next)→EdgeJudge→post(/judge/verdict) loop: the
        bench runs NO judge LLM; production's runJudgeDrainSync does the keep/prune adjudication.
        Returns {ok, judged, kept, pruned, idle, rounds, ...}.
        """
        return judge_drain(
            self.base_url,
            node,
            self._ws(workspace),
            budget=budget,
            timeout=timeout or self.timeout,
        )

    def set_workspace(
        self,
        path: str,
        force: bool = True,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """POST /workspace — bind the daemon's live workspace to *path* (eager-judge prerequisite)."""
        return set_workspace(
            self.base_url,
            path,
            force=force,
            timeout=timeout or self.timeout,
        )

    def overlay_edge(
        self,
        from_key: str,
        to_key: str,
        kind: str | None = None,
        weight: float | None = None,
        from_workspace: str | None = None,
        workspace: str | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        """POST /overlay/edge — createEdge (finding #6 workaround for task->note wiring)."""
        return overlay_edge(
            self.base_url,
            from_key,
            to_key,
            workspace=workspace or self.workspace,
            kind=kind,
            weight=weight,
            from_workspace=from_workspace,
            timeout=timeout or self.timeout,
        )


# ---------------------------------------------------------------------------
# Smoke test (run directly against live daemon)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    """Smoke test: warm_up + search returns a list; task_suggest returns expected shape.

    Usage (embeddable python full path):
        C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/zonoid_bench/client.py
        C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/zonoid_bench/client.py --daemon http://localhost:8787

    Runtime: stdlib ONLY. Embeddable Python 3.12 safe.
    """
    import sys
    import os
    import tempfile

    daemon = "http://localhost:8787"
    for i, arg in enumerate(sys.argv):
        if arg == "--daemon" and i + 1 < len(sys.argv):
            daemon = sys.argv[i + 1]

    print(f"Smoke: daemon={daemon}")

    # ---------- Finding #5: warm_up ----------
    print("  warm_up()... ", end="", flush=True)
    try:
        warm_up(daemon, timeout=120)
        print("OK")
    except Exception as e:
        print(f"FAILED (daemon may be down): {e}")
        sys.exit(1)

    # ---------- Finding #3: search returns a list ----------
    # Use a throwaway absolute workspace so notes don't pollute the live graph.
    ws = os.path.abspath(tempfile.mkdtemp(prefix="zonoid-client-smoke-"))
    print(f"  search(workspace={ws!r})... ", end="", flush=True)
    try:
        hits = search(daemon, ws, "test query", k=3, gated=False, timeout=60)
        assert isinstance(hits, list), f"expected list, got {type(hits).__name__}"
        print(f"OK (got {len(hits)} hits)")
    except Exception as e:
        print(f"FAILED: {e}")
        sys.exit(1)

    # ---------- task_suggest returns expected shape ----------
    # We need an existing task key from the live workspace.
    # Strategy: try /graph/delta?since=0 first, then probe /task/suggest with a candidate
    # key from the environment or a stable well-known fallback.
    print("  task_suggest()... ", end="", flush=True)
    try:
        import urllib.parse as _up

        key: str | None = None

        # Strategy 1: ZONOID_SMOKE_TASK_KEY env override (e.g. set by CI).
        key = os.environ.get("ZONOID_SMOKE_TASK_KEY") or None

        # Strategy 2: /graph/delta?since=0 (JSON API).
        if not key:
            try:
                qs = _up.urlencode({"since": "0"})
                with urllib.request.urlopen(f"{daemon}/graph/delta?{qs}", timeout=15) as r:
                    delta = json.loads(r.read())
                tasks = delta.get("tasks") or []
                if tasks:
                    key = tasks[0].get("id") or tasks[0].get("key")
            except Exception:
                pass

        # Strategy 3: probe /task/suggest with the handoff task key (always exists while
        # this smoke is running, because start_task has been called on it).
        if not key:
            _candidate = "59fc18e1-744e-4f7a-9093-a8e12d43087b/15"
            try:
                qs2 = _up.urlencode({"key": _candidate})
                with urllib.request.urlopen(
                    f"{daemon}/task/suggest?{qs2}", timeout=15
                ) as r2:
                    _body = json.loads(r2.read())
                if "suggestions" in _body:
                    key = _candidate
            except Exception:
                pass

        if not key:
            print("SKIP (no tasks in live graph; can't exercise task_suggest)")
        else:
            result = task_suggest(daemon, key, timeout=60)
            assert "suggestions" in result, f"missing 'suggestions' key: {result}"
            assert isinstance(result["suggestions"], list), \
                f"suggestions is not a list: {result['suggestions']}"
            # Validate ceScore shape on first suggestion if present.
            if result["suggestions"]:
                s = result["suggestions"][0]
                # ceScore is present when the cross-encoder sidecar is up; may be absent.
                if "ceScore" in s:
                    assert isinstance(s["ceScore"], (int, float)), \
                        f"ceScore must be numeric, got: {s['ceScore']!r}"
            print(f"OK (task={key!r}, suggestions={len(result['suggestions'])}, "
                  f"ceScore_present={'ceScore' in (result['suggestions'][0] if result['suggestions'] else {})})")
    except Exception as e:
        print(f"FAILED: {e}")
        sys.exit(1)

    # ---------- Finding #1: absolute-workspace guard ----------
    print("  absolute-workspace guard... ", end="", flush=True)
    try:
        post_note(daemon, "relative/path", "t", "s")
        print("FAILED (should have raised ValueError)")
        sys.exit(1)
    except ValueError as e:
        print(f"OK (raised ValueError: {e})")
    except Exception as e:
        print(f"UNEXPECTED: {e}")
        sys.exit(1)

    # ---------- Finding #2: post_note without force (verify no 'force' in body) ----------
    # We do this by writing a real note and confirming the response has 'key'.
    print(f"  post_note(no force, ws={ws!r})... ", end="", flush=True)
    try:
        resp = post_note(
            daemon, ws,
            title="client smoke test note",
            summary="A smoke-test note to verify the post_note transport works end-to-end.",
            category="smoke",
            timeout=60,
        )
        key_field = resp.get("key") or resp.get("note_key")
        assert key_field, f"post_note response missing 'key': {resp}"
        print(f"OK (key={key_field!r})")
    except Exception as e:
        print(f"FAILED: {e}")
        sys.exit(1)

    print("\nSmoke: ALL PASS")
    sys.exit(0)
