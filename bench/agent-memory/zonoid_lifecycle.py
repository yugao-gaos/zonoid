"""Shared stdlib HTTP helpers for talking to the Zonoid orchestrator daemon.

All HTTP is done via ``urllib.request`` (stdlib only — no pip, no requests).
This module is the shared transport layer for the agent-memory benchmark harness.

Ported from the patterns in ``bench/swe-bench-cl/zonoid_memory.py`` (which used
``requests``).  All workspace-targeting semantics are preserved:
  - GET routes: workspace passed as a query-string parameter (?workspace=…)
  - POST routes: workspace passed inside the JSON body (body.workspace)

Covered endpoints
-----------------
POST /overlay/note      — write a note (no ``force``; lets autowire + dup-guard run)
GET  /search            — semantic/lexical search, workspace-scoped
POST /judge/verdict     — post edge/dup verdicts; body MUST be wrapped {verdicts:[…]}
GET  /task/context      — read frozen DAG context for a node (probe runner reads this)
POST /overlay/status    — update a node's status

Embedder warm-up
----------------
The first /search call lazy-loads the local embedding model (~10–90 s).
Call ``warm_up(base_url)`` once before any hot path so no single call eats the latency.

HTTP shape notes (from spike note-mqgwr63ms7q + zonoid_memory.py findings)
---------------------------------------------------------------------------
1. workspace MUST be an ABSOLUTE filesystem path. A relative string silently
   fails to persist — the daemon does ``path.join(workspace, '.graph')``.
2. POST /overlay/note: response is ``{"key": "note:<id>", …}`` (field is "key",
   also sometimes "note_key" in older code — we prefer "key" per spike note).
3. No ``force`` on note writes: force suppresses autowire + the pending_dup signal.
4. POST /judge/verdict: markDistinct is NOT in the bare-body fallback allowlist;
   body MUST be wrapped as ``{"workspace": …, "verdicts": […]}``.
5. GET /search: params are query-string (?q=…&k=…&workspace=…&gated=false).
   Result is ``{"results": […]}``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


# ---------------------------------------------------------------------------
# Internal transport
# ---------------------------------------------------------------------------

def _http_get(url: str, params: dict[str, Any], timeout: int) -> Any:
    """GET *url* with *params* as query string. Returns parsed JSON body."""
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


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def post_note(
    base_url: str,
    workspace: str,
    title: str,
    summary: str,
    category: str = "conversation-session",
    tags: list[str] | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /overlay/note — write a note into *workspace*.

    No ``force`` is passed: omitting it lets the daemon's autowire + dup-guard
    + eager-judge pipeline run (force would suppress both).

    Returns the raw daemon response dict, which carries:
      ``{"key": "note:<id>", "autowired": <n>, "pending_dup": bool, …}``
    """
    body: dict[str, Any] = {
        "workspace": workspace,
        "title": title,
        "summary": summary,
        "category": category,
        # No "force" — intentional; see module docstring finding #3.
    }
    if tags:
        body["tags"] = tags
    return _http_post(f"{base_url.rstrip('/')}/overlay/note", body, timeout)


def search(
    base_url: str,
    workspace: str,
    query: str,
    k: int = 10,
    gated: bool = False,
    timeout: int = 120,
) -> list[dict[str, Any]]:
    """GET /search — semantic/lexical search scoped to *workspace*.

    Returns the ``results`` list (empty list on error or no results).
    ``gated=False`` (default): always returns ranked top-k regardless of the
    context-need gate — appropriate for evaluation harnesses that always want hits.
    """
    params: dict[str, Any] = {
        "q": query or "",
        "k": k,
        "workspace": workspace,
        "gated": "true" if gated else "false",
    }
    try:
        resp = _http_get(f"{base_url.rstrip('/')}/search", params, timeout)
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

    *verdicts* is a list of verdict dicts, e.g.:
      [{"keepEdge": {"from": key_a, "to": key_b}}, …]
      [{"markDistinct": {"keys": [key_a, key_b]}}, …]
      [{"consolidate": {"keep": key_a, "supersede": [key_b]}}, …]

    Body is ALWAYS wrapped as ``{"workspace": …, "verdicts": […]}`` because
    markDistinct is not in the bare-body fallback allowlist (finding #4).
    """
    body: dict[str, Any] = {
        "workspace": workspace,
        "verdicts": verdicts,
    }
    return _http_post(f"{base_url.rstrip('/')}/judge/verdict", body, timeout)


def get_task_context(
    base_url: str,
    workspace: str,
    node_key: str,
    timeout: int = 120,
) -> dict[str, Any]:
    """GET /task/context — read frozen DAG context for a node.

    Used by the probe runner to answer QA probes from the wired DAG rather than
    retrieval-time RAG. The probe runner calls KEEP-only (no prune) logic for
    isolated workspaces; that is out of scope for the ingester.

    Returns the raw daemon response dict.
    """
    params: dict[str, Any] = {
        "key": node_key,
        "workspace": workspace,
    }
    return _http_get(f"{base_url.rstrip('/')}/task/context", params, timeout)


def post_status(
    base_url: str,
    workspace: str,
    node_key: str,
    status: str,
    timeout: int = 120,
) -> dict[str, Any]:
    """POST /overlay/status — update a node's status in *workspace*.

    Returns the raw daemon response dict.
    """
    body: dict[str, Any] = {
        "workspace": workspace,
        "key": node_key,
        "status": status,
    }
    return _http_post(f"{base_url.rstrip('/')}/overlay/status", body, timeout)


def warm_up(base_url: str, workspace: str | None = None, timeout: int = 120) -> None:
    """Pre-pay the embedding-model cold start.

    The first /search call lazy-loads the local model (~10–90 s on this box).
    Call this once before the eval loop so no single hot path eats the latency.
    If *workspace* is None a throwaway query is sent with no workspace filter —
    sufficient to trigger the warm-up; no notes are written.
    """
    try:
        params: dict[str, Any] = {"q": "warmup", "k": 1, "gated": "false"}
        if workspace:
            params["workspace"] = workspace
        _http_get(f"{base_url.rstrip('/')}/search", params, timeout)
    except Exception:
        pass  # best-effort; a real call will retry
