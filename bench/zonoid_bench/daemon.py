"""
bench/zonoid_bench/daemon.py
============================
Embedded bench-daemon lifecycle for the Zonoid Bench SDK.

Spawns an ISOLATED instance of the Zonoid orchestrator daemon (daemon.js) on a
FREE port (never :8787, which is reserved for the dev daemon), manages its
startup, health-check, model-cache sharing, and clean teardown.

Stdlib-only — runs on the embeddable Python at
  C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe
as well as any CPython 3.8+ on Mac/Linux.

Usage
-----
    from zonoid_bench.daemon import DaemonHandle, start, stop

    handle = start(data_dir="/tmp/bench-run-42")
    # handle.base_url  -> "http://127.0.0.1:<port>"
    # handle.port      -> int
    # handle.proc      -> subprocess.Popen

    stop(handle)

Design notes (§6 of docs/bench-sdk-design.md)
----------------------------------------------
* ORCH_PORT=<port>          — daemon.js:39 picks up the free port
* CLAUDE_PLUGIN_DATA=<dir>  — daemon.js:42 relocates all graph/overlay data
* /health is whitelisted through the 503 boot gate (daemon.js:332) — we poll
  it until the JSON body contains {"phase":"ready"}.
* Model files (Xenova/all-MiniLM-L6-v2, Xenova/ms-marco-MiniLM-L-6-v2) live
  under $CLAUDE_PLUGIN_DATA/models/. We SYMLINK (or copy on Windows where the
  symlink privilege may be absent) the production model cache directory into
  data_dir/models so the embed/rerank sidecars find the weights without
  re-downloading them.
* Graph, overlay, sessions, and journal data stay under data_dir — fully
  isolated from the production daemon.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

DEFAULT_READY_TIMEOUT = 120.0   # seconds to wait for phase:ready
POLL_INTERVAL         = 0.5     # seconds between /health polls
TERMINATE_TIMEOUT     = 5.0     # seconds between SIGTERM and SIGKILL

# The production model-cache directory relative to CLAUDE_PLUGIN_DATA.
# Both lib/embed.js and lib/rerank.js look for models under $BASE/models
# where BASE = CLAUDE_PLUGIN_DATA (daemon.js:42).
_MODEL_SUBDIR = "models"

# Default source of model weights: the user's live orchestrator data dir.
_DEFAULT_MODEL_SOURCE = os.path.join(
    os.path.expanduser("~"), ".claude", "orchestrator", _MODEL_SUBDIR
)


# ---------------------------------------------------------------------------
# Public dataclass
# ---------------------------------------------------------------------------

@dataclass
class DaemonHandle:
    """Everything the caller needs to interact with (and later stop) a daemon."""

    port: int
    base_url: str
    proc: subprocess.Popen
    data_dir: str
    # The live workspace this daemon was bound to (POST /workspace), if any. The eager-judge
    # candidate read + keepEdge persistence are bound to this workspace (note-mqgwrh5a63x).
    workspace: Optional[str] = None
    # Retain symlink/copy target so stop() can clean it up if needed.
    _model_link: Optional[str] = field(default=None, repr=False)


# ---------------------------------------------------------------------------
# Free-port helper
# ---------------------------------------------------------------------------

def _pick_free_port() -> int:
    """Bind a TCP socket to :0, let the OS assign a port, return it.

    Closes the socket immediately — the caller must bind the real server to
    that port before any concurrent bind races to claim it (rare in practice;
    the daemon starts within milliseconds).
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Model-cache sharing
# ---------------------------------------------------------------------------

def _share_model_cache(data_dir: str, model_source: Optional[str] = None) -> Optional[str]:
    """Ensure the bench data_dir has access to the production model weights.

    Strategy (Windows-safe):
    1. Try to create a *directory symlink* from data_dir/models → model_source.
       On Windows this requires the SeCreateSymbolicLink privilege (available to
       admins and Developer Mode users); if it fails we fall through.
    2. If symlink fails, *copy* the model files (slow the first time; subsequent
       runs re-use the copy because data_dir is usually a temp dir that is
       recreated fresh each run).

    Returns the path of the link/copy that was created, or None if model_source
    does not exist (embed/rerank will still work — they just cold-load on demand).
    """
    src = model_source or _DEFAULT_MODEL_SOURCE
    if not os.path.isdir(src):
        # No local model cache to share — fine; sidecars will download on first use.
        return None

    dest = os.path.join(data_dir, _MODEL_SUBDIR)
    os.makedirs(data_dir, exist_ok=True)

    # Already set up (e.g. caller pre-populated data_dir).
    if os.path.exists(dest):
        return dest

    # Attempt symlink first (zero disk cost).
    try:
        os.symlink(src, dest, target_is_directory=True)
        return dest
    except (OSError, NotImplementedError):
        pass  # fall through to copy

    # Fallback: copy
    try:
        shutil.copytree(src, dest)
        return dest
    except Exception as exc:  # noqa: BLE001
        # Non-fatal: log and continue; the daemon will work, just no pre-warmed models.
        print(
            f"[daemon.py] WARNING: could not share model cache from {src!r}: {exc}",
            file=sys.stderr,
        )
        return None


# ---------------------------------------------------------------------------
# /health polling
# ---------------------------------------------------------------------------

def _poll_health(base_url: str, timeout: float = DEFAULT_READY_TIMEOUT) -> None:
    """Poll GET <base_url>/health until the response body has {"phase":"ready"}.

    /health is whitelisted through the 503 boot gate (daemon.js:332), so we
    receive a JSON body even while the daemon is still initialising.  Each
    response body looks like {"phase":"<name>", ...}.

    Raises RuntimeError on timeout.
    """
    deadline = time.monotonic() + timeout
    url = f"{base_url}/health"
    last_phase: Optional[str] = None

    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                body = resp.read()
                data = json.loads(body)
                phase = data.get("phase", "")
                if phase != last_phase:
                    print(f"[daemon.py] /health phase={phase!r}", file=sys.stderr)
                    last_phase = phase
                if phase == "ready":
                    return
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            # Daemon not yet listening — keep waiting.
            pass

        time.sleep(POLL_INTERVAL)

    raise RuntimeError(
        f"Daemon at {base_url} did not reach phase:ready within {timeout}s "
        f"(last phase={last_phase!r})"
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def start(
    daemon_js: Optional[str] = None,
    port: Optional[int] = None,
    data_dir: Optional[str] = None,
    model_source: Optional[str] = None,
    ready_timeout: float = DEFAULT_READY_TIMEOUT,
    workspace: Optional[str] = None,
) -> DaemonHandle:
    """Spawn an isolated Zonoid daemon and wait until it is ready.

    Parameters
    ----------
    daemon_js:
        Path to daemon.js.  Defaults to ``<repo_root>/daemon.js`` where
        repo_root is two directories above this file
        (bench/zonoid_bench/daemon.py → repo_root).
    port:
        TCP port to bind.  If None (default), a free port is chosen
        automatically — it will NEVER be 8787 (the dev-daemon port).
    data_dir:
        CLAUDE_PLUGIN_DATA for this daemon instance.  If None, a temporary
        directory under the system temp tree is created automatically and is
        NOT removed on stop() — pass an explicit path if you want lifecycle
        control.
    model_source:
        Directory to share model weights from.  Defaults to
        ~/.claude/orchestrator/models.
    ready_timeout:
        How long (seconds) to wait for phase:ready before raising.
    workspace:
        If set (absolute path), bind the daemon's LIVE ``state.workspace`` to it
        once ready (POST /workspace {path, force:true}).  This is the lever the
        canonical ON-arm needs: the eager-judge read (/judge/next?node=) and the
        keepEdge promotion are hard-bound to ``state.workspace`` (routes/judge.js),
        so for an autowire candidate to surface + a keepEdge to persist for a bench
        UNIT, the unit's workspace dir must BE the daemon's live workspace
        (note-mqgwrh5a63x: keepEdge on a non-live/isolated workspace does not
        surface in /task/context).  One embedded daemon per unit, live-bound to that
        unit's dir, makes the whole pipeline operate on one consistent overlay.

    Returns
    -------
    DaemonHandle
        Contains .port, .base_url, .proc, .data_dir, .workspace.
    """
    # ---- resolve daemon.js -----------------------------------------------
    if daemon_js is None:
        # bench/zonoid_bench/daemon.py  →  ../../daemon.js
        _pkg_dir  = pathlib.Path(__file__).resolve().parent   # zonoid_bench/
        _bench    = _pkg_dir.parent                            # bench/
        _repo_root = _bench.parent                             # repo root
        daemon_js = str(_repo_root / "daemon.js")

    if not os.path.isfile(daemon_js):
        raise FileNotFoundError(
            f"daemon.js not found at {daemon_js!r}. "
            "Pass daemon_js=<path> explicitly or run from the repo root."
        )

    # ---- pick port -------------------------------------------------------
    if port is None:
        port = _pick_free_port()
        # Safety: extremely unlikely, but guard against the OS returning 8787.
        while port == 8787:
            port = _pick_free_port()
    elif port == 8787:
        raise ValueError(
            "Port 8787 is reserved for the dev daemon. "
            "Pass port=None to auto-select a free port."
        )

    # ---- data dir --------------------------------------------------------
    if data_dir is None:
        import tempfile
        data_dir = tempfile.mkdtemp(prefix="zonoid-bench-")

    os.makedirs(data_dir, exist_ok=True)

    # ---- share model cache -----------------------------------------------
    model_link = _share_model_cache(data_dir, model_source)

    # ---- spawn daemon ----------------------------------------------------
    env = {
        **os.environ,
        "ORCH_PORT":          str(port),
        "CLAUDE_PLUGIN_DATA": data_dir,
        # Disable drain-loop in headless bench processes (hang-protection).
        # Without this, the embedded daemon's drain loop blocks indefinitely
        # when there are no tasks — observed to hang bench runs for hours.
        "ORCH_HEADLESS_DRAINS": "0",
        # Drop the production cosine floor so the eager-judge sees all top-K reranked candidates
        # instead of a hard cosine cutoff. Cost is bounded by TASK_CREATE_FANOUT (5 per kind)
        # and the ORCH_AUTOWIRE_K cap (top-K pre-filter before fan-out). Production daemon stays
        # at its default (env not set). Bench uses ~0 to maximise recall for the eager-judge to
        # arbitrate.
        "ORCH_AUTOWIRE_THRESHOLD": os.environ.get("ORCH_AUTOWIRE_THRESHOLD", "0.0"),
        # Top-K cosine candidates passed to the fan-out before the per-kind TASK_CREATE_FANOUT cap
        # applies. Bounds cost: at most K cosine scores + fan-out cap kept edges, not all 114 notes.
        "ORCH_AUTOWIRE_K":         os.environ.get("ORCH_AUTOWIRE_K", "20"),
    }

    # node must be on PATH; this is a hard requirement (see §3 of design doc).
    node_exe = shutil.which("node")
    if node_exe is None:
        raise EnvironmentError(
            "node is not on PATH. Install Node.js (v24.x recommended) before "
            "using the embedded daemon."
        )

    proc = subprocess.Popen(
        [node_exe, daemon_js],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        # Keep the child alive independently of this Python process on Unix;
        # on Windows Popen already does not create a new process group by
        # default, so no extra flag needed.
    )

    base_url = f"http://127.0.0.1:{port}"
    print(
        f"[daemon.py] spawned daemon pid={proc.pid} port={port} "
        f"data_dir={data_dir!r}",
        file=sys.stderr,
    )

    # ---- wait for ready --------------------------------------------------
    try:
        _poll_health(base_url, timeout=ready_timeout)
    except Exception:
        # Make sure we don't leave a zombie behind.
        proc.terminate()
        try:
            proc.wait(timeout=TERMINATE_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise

    print(f"[daemon.py] daemon ready at {base_url}", file=sys.stderr)

    # ---- bind live workspace (eager-judge prerequisite) ------------------
    # POST /workspace {path, force:true} so state.workspace == the unit dir. The eager-judge read
    # (/judge/next?node=) and keepEdge save are hard-bound to state.workspace (routes/judge.js);
    # this bind is what makes an autowire candidate surface + a keepEdge persist for a bench unit.
    if workspace is not None:
        if not (workspace.startswith("/") or (len(workspace) >= 2 and workspace[1] == ":")):
            proc.terminate()
            try:
                proc.wait(timeout=TERMINATE_TIMEOUT)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise ValueError(
                f"workspace must be an absolute filesystem path, got: {workspace!r}"
            )
        os.makedirs(workspace, exist_ok=True)
        _bind_workspace(base_url, workspace)
        print(f"[daemon.py] live workspace bound to {workspace!r}", file=sys.stderr)

    return DaemonHandle(
        port=port,
        base_url=base_url,
        proc=proc,
        data_dir=data_dir,
        workspace=workspace,
        _model_link=model_link,
    )


def _bind_workspace(base_url: str, workspace: str, timeout: float = 15.0) -> None:
    """POST /workspace {path, force:true} to bind the daemon's live state.workspace.

    Raises RuntimeError if the daemon does not confirm the bind (the canonical ON-arm depends on
    state.workspace == workspace, so a silent failure here would make the eager-judge read miss).
    """
    body = json.dumps({"path": workspace, "force": True}).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/workspace", data=body, method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    if not data.get("ok") or data.get("workspace") != workspace:
        raise RuntimeError(
            f"failed to bind live workspace to {workspace!r}: daemon returned {data!r}"
        )


def stop(handle: DaemonHandle, timeout: float = TERMINATE_TIMEOUT) -> int:
    """Terminate the daemon cleanly.

    Sends SIGTERM (terminate on Windows), waits *timeout* seconds, then
    sends SIGKILL / TerminateProcess if the process has not exited.

    Parameters
    ----------
    handle:
        The DaemonHandle returned by start().
    timeout:
        Seconds to wait after terminate() before kill().

    Returns
    -------
    int
        The process exit code (may be negative on Unix when killed by signal).
    """
    proc = handle.proc
    if proc.poll() is not None:
        # Already exited (e.g. crashed).
        return proc.returncode  # type: ignore[return-value]

    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

    code = proc.returncode
    print(
        f"[daemon.py] daemon pid={proc.pid} exited with code={code}",
        file=sys.stderr,
    )
    return code
