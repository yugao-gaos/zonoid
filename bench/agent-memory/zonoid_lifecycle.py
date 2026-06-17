"""Thin compatibility shim — re-exports the Zonoid HTTP lifecycle from the SDK.

This module used to carry its OWN urllib transport (post_note / search /
post_verdict / get_task_context / post_status / warm_up).  That machinery was
the divergent, duplicated copy called out in docs/bench-sdk-design.md §1.  It now
lives in ONE place — ``bench/zonoid_bench/client.py`` — and this file simply
re-exports those functions so existing importers (ingest.py, run.py, smoke.py,
probe_runner.py) keep working unchanged.

Why a shim and not a delete: ``ingest.py`` and friends import
``from zonoid_lifecycle import post_note, search, warm_up`` and call them
POSITIONALLY as ``post_note(base_url, workspace, title, summary, ...)``.  The SDK
module-level functions in ``zonoid_bench.client`` carry the IDENTICAL positional
signature ``(base_url, workspace, ...)`` (they were extracted from this very
module), so a direct re-export is byte-compatible — no adapter needed.

The SDK adds two extras the old module lacked, both backward-compatible:
  - ``post_note`` / ``search`` now guard that the workspace is an ABSOLUTE path
    (finding #1).  The agent-memory harness already passes absolute workspaces
    (ConversationIngester.workspace_for → os.path.abspath), so the guard never
    fires here; it only catches a future caller that regresses.
  - ``post_status`` / ``search`` gained optional keyword args (``summary=``,
    ``task_key=``) that the old signature did not have.  Old positional callers
    are unaffected.

Runtime: stdlib only (urllib via the SDK).  Embeddable Python 3.12 safe.
"""

from __future__ import annotations

import os
import sys

# Embeddable Python 3.12 (py312embed) strips cwd from sys.path. Insert the bench/
# root (the parent of this agent-memory folder) so ``import zonoid_bench`` resolves
# regardless of the working directory — the same bootstrap arms.py / client.py use.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

# Re-export the canonical lifecycle. These ARE the functions agent-memory used to
# define locally; they now have a single source of truth in the SDK client.
from zonoid_bench.client import (  # noqa: E402,F401
    ZonoidClient,
    _http_get,
    _http_post,
    get_task_context,
    judge_next,
    overlay_edge,
    post_note,
    post_status,
    post_verdict,
    search,
    task_suggest,
    warm_up,
)

__all__ = [
    "ZonoidClient",
    "_http_get",
    "_http_post",
    "get_task_context",
    "judge_next",
    "overlay_edge",
    "post_note",
    "post_status",
    "post_verdict",
    "search",
    "task_suggest",
    "warm_up",
]
