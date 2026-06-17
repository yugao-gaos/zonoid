"""bench/zonoid_bench/workspace.py -- Zonoid Bench SDK: workspace utilities.

Canonicalises the workspace helpers that were previously scattered across:
  - bench/agent-memory/probe_runner.py  (workspace_key, _drop_probe_stub)
  - lib/filedrop-tasks.js               (workspaceKey -- the authoritative JS source)

All code is stdlib-only (hashlib, os, re, json) and runs on embeddable Python 3.12.

Public surface
--------------
workspace_key(ws)                         -- EXACT port of lib/filedrop-tasks.js workspaceKey().
isolated_ws(root, unit, arm)              -- absolute path for one (unit, arm) workspace.
drop_task_stub(data_dir, ws, id, subject) -- write a file-drop task stub; return <harness>/<id>.
"""

from __future__ import annotations

import hashlib
import json
import os
import re


# ---------------------------------------------------------------------------
# workspace_key -- EXACT port of lib/filedrop-tasks.js workspaceKey()
# ---------------------------------------------------------------------------

def workspace_key(workspace: str) -> str:
    """Collision-free per-workspace folder name.

    MUST stay in lockstep with lib/filedrop-tasks.js workspaceKey():

        const h = crypto.createHash(sha1)
                        .update(String(workspace))
                        .digest(hex).slice(0, 16);
        const base = (path.basename(String(workspace)) || ws)
                        .replace(/[^A-Za-z0-9._-]/g, _);
        return base + - + h;

    Rules (confirmed from JS source):
    - Hash: SHA-1 of the workspace string encoded as UTF-8, hex digest, first 16 chars.
    - Base: os.path.basename of the workspace string, or ws if empty.
    - Sanitise: replace every char NOT in [A-Za-z0-9._-] with underscore.
    - Join: <sanitised-base>-<16-char-hex>.
    """
    ws = str(workspace or "")
    h = hashlib.sha1(ws.encode("utf-8")).hexdigest()[:16]
    base = os.path.basename(ws) or "ws"
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return f"{base}-{h}"


# ---------------------------------------------------------------------------
# isolated_ws -- absolute workspace path for one (unit, arm) pair
# ---------------------------------------------------------------------------

def isolated_ws(root: str, unit: str, arm: str) -> str:
    """Return an absolute workspace path for one (unit, arm) pair.

    The path is <root>/<unit-slug>-<arm> where the unit slug sanitises the
    unit identifier to [A-Za-z0-9._-] (same rule as workspace_key base). The
    directory is NOT created here -- callers that need it should call os.makedirs.

    Args:
        root: Parent directory for all workspace dirs of this bench run.
        unit: Benchmark unit identifier (task id, sequence id, conversation id ...).
        arm:  Arm label (e.g. on, off-cold, rag-control, zonoid).

    Returns:
        Absolute path string.
    """
    slug = re.sub(r"[^A-Za-z0-9._-]", "-", f"{unit}-{arm}")
    return os.path.abspath(os.path.join(root, slug))


# ---------------------------------------------------------------------------
# drop_task_stub -- write a file-drop task stub for the daemon to adopt
# ---------------------------------------------------------------------------

def drop_task_stub(
    data_dir: str,
    workspace: str,
    task_id: str,
    subject: str,
    *,
    harness: str = "bench",
    description: str = "",
    status: str = "pending",
    agent_id: str = "zonoid_bench",
) -> str:
    """Write a file-drop task stub and return its <harness>/<id> key.

    The stub is written atomically (tmp + rename) following the convention in
    lib/filedrop-tasks.js. The daemon adopts the stub (~1.5 s) and exposes the
    task on its HTTP surface.

    Folder layout (v1 -- mirrors lib/filedrop-tasks.js):
        <data_dir>/tasks/<workspace_key(workspace)>/<harness>/<id>.json

    Args:
        data_dir:    Root data directory (CLAUDE_PLUGIN_DATA or ~/.claude/orchestrator).
        workspace:   Absolute workspace path (the daemon requires an absolute path).
        task_id:     Task id string (must be URL-safe; callers typically use a UUID or slug).
        subject:     Short task description (the task question / problem statement).
        harness:     Harness namespace (default bench; avoid followup and UUID-like names).
        description: Optional long description (default empty string).
        status:      Initial status (default pending).
        agent_id:    Provenance agent id recorded in created_by.

    Returns:
        The namespaced task key: <harness>/<id>.
    """
    stub_dir = os.path.join(data_dir, "tasks", workspace_key(workspace), harness)
    os.makedirs(stub_dir, exist_ok=True)
    stub_path = os.path.join(stub_dir, f"{task_id}.json")
    stub = {
        "id": task_id,
        "subject": subject,
        "description": description,
        "status": status,
        "created_by": {"harness": harness, "agent_id": agent_id},
    }
    tmp = f"{stub_path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(stub, fh, indent=2)
    os.replace(tmp, stub_path)
    return f"{harness}/{task_id}"
