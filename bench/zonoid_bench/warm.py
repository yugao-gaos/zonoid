"""bench/zonoid_bench/warm.py — Pre-learnt KB snapshot support (§7).

Public API
----------
produce_snapshot(repo, base_commit, out_dir, *, daemon=..., model='sonnet') -> pathlib.Path
    Run the expensive MINE+DRAIN once for (repo, base_commit) and write the
    snapshot artefacts into out_dir/<slug>/.  Wraps bench/swe-bench-cl/warm_start.js.

load_snapshot(snapshot, workspace, *, daemon=...) -> None
    Inject a pre-learnt KB into a bench daemon's workspace.

    Level A (default):  re-inject drained batches via
        node scripts/onboard-learn.js --inject --confirm --workspace <ABS workspace>
    with ORCH_GATE_OFF=1 and --model sonnet.  This skips the expensive MINE+DRAIN.

    Level B (optional, triggered by copy_graph=True):  copy a materialised .graph
    tarball from snapshot/.graph.tar.gz (or snapshot/.graph/ dir) into
    <workspace>/.graph/.

    AGENTS.md passthrough (optional, triggered by agents_md=<path>):
    copy a pre-exported <repo>.<model>.AGENTS.md file into
    <workspace>/AGENTS.md  (FeatureBench FB_KB_PATH style).

Design ref: docs/bench-sdk-design.md §7
Reuse:      bench/swe-bench-cl/warm_start.js
            scripts/onboard-learn.js (--inject / --drain / --enqueue flags)

Stdlib-only — runs on embeddable Python 3.12:
    C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe
"""

from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess
import sys
from typing import Optional

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_DEFAULT_DAEMON = "http://localhost:8787"

# Repo-root detection: warm.py lives at bench/zonoid_bench/warm.py so the repo
# root is three levels up.
_WARM_PY = pathlib.Path(__file__).resolve()
_REPO_ROOT = _WARM_PY.parent.parent.parent   # <repo>/bench/zonoid_bench/warm.py

_ONBOARD_LEARN = _REPO_ROOT / "scripts" / "onboard-learn.js"
_WARM_START_JS = _REPO_ROOT / "bench" / "swe-bench-cl" / "warm_start.js"


def _node() -> str:
    """Resolve the Node.js binary name available on PATH."""
    for name in ("node", "node.exe"):
        if shutil.which(name):
            return name
    raise FileNotFoundError(
        "Node.js ('node') not found on PATH; required for warm.py."
    )


def _run(argv: list[str], extra_env: Optional[dict[str, str]] = None, **kwargs) -> None:
    """Run *argv* as a subprocess, inheriting stdio, raising on non-zero exit."""
    env = {**os.environ, **(extra_env or {})}
    result = subprocess.run(argv, env=env, **kwargs)  # noqa: S603
    if result.returncode != 0:
        raise RuntimeError(
            f"Command exited {result.returncode}: {' '.join(str(a) for a in argv)}"
        )


def _slug(repo: str, base_commit: str) -> str:
    """Snapshot directory name keyed by (repo, base_commit).

    Mirrors the pilot-manifest.json convention: repo slug = repo path basename
    (or the last two path components joined with '_').  commit is truncated to 8
    chars for readability.  Characters outside [A-Za-z0-9._-] are replaced with '-'.

    Example:
        repo="pandas-dev/pandas", base_commit="82fa27153e5b..." -> "pandas-dev_pandas-82fa2715"
    """
    repo_part = repo.replace("/", "_").replace("\\", "_")
    commit_short = base_commit[:8]
    raw = f"{repo_part}-{commit_short}"
    return re.sub(r"[^A-Za-z0-9._-]", "-", raw)


def _onboard_dir(repo: str) -> pathlib.Path:
    """Return the standard bench/onboard/<repo-basename>/ directory."""
    return _REPO_ROOT / "bench" / "onboard" / pathlib.Path(repo).name


# ---------------------------------------------------------------------------
# produce_snapshot
# ---------------------------------------------------------------------------

def produce_snapshot(
    repo: str,
    base_commit: str,
    out_dir: str,
    *,
    daemon: str = _DEFAULT_DAEMON,
    model: str = "sonnet",
    arm: str = "zonoid",
    workspace_root: Optional[str] = None,
    dry_run: bool = False,
) -> pathlib.Path:
    """Run the expensive MINE+DRAIN once and write snapshot artefacts to *out_dir*.

    Parameters
    ----------
    repo:         Absolute path to the repo checkout at *base_commit*.
    base_commit:  The base commit the repo is pinned to (used for keying only).
    out_dir:      Directory under which the per-(repo,commit) snapshot subdir is
                  written.  Created if absent.
    daemon:       Daemon URL (passed to warm_start.js via --daemon).
    model:        LLM model for the drain pass (default: 'sonnet').
    arm:          Bench arm label (default: 'zonoid').
    workspace_root: Workspace root for warm_start.js (defaults to /tmp/zonoid-cl
                    inside warm_start.js itself; override when the sequence workspace
                    is known up-front).
    dry_run:      Pass --dry-run to warm_start.js (mine + drain plan only, no inject).

    Returns
    -------
    pathlib.Path  The snapshot directory (<out_dir>/<slug>/) containing the drained
                  onboard-notes.json and related artefacts.
    """
    out_path = pathlib.Path(out_dir).resolve()
    slug = _slug(repo, base_commit)
    snap_dir = out_path / slug
    snap_dir.mkdir(parents=True, exist_ok=True)

    node = _node()
    warm_start = str(_WARM_START_JS)
    if not pathlib.Path(warm_start).is_file():
        raise FileNotFoundError(f"warm_start.js not found at: {warm_start}")

    argv = [
        node, warm_start,
        "--repo", str(pathlib.Path(repo).resolve()),
        "--daemon", daemon,
        "--model", model,
        "--arm", arm,
    ]
    if workspace_root:
        argv += ["--workspace-root", str(pathlib.Path(workspace_root).resolve())]
    if dry_run:
        argv.append("--dry-run")

    # ORCH_GATE_OFF=1 is already set inside warm_start.js via the childEnv it passes to
    # every child; we also set it here so any outer gate running in this process is off.
    extra_env = {"ORCH_GATE_OFF": "1", "ORCH_DAEMON": daemon}

    sys.stderr.write(
        f"[warm] produce_snapshot: repo={repo} base_commit={base_commit[:8]}\n"
        f"[warm] slug={slug}  snap_dir={snap_dir}\n"
        f"[warm] running: {' '.join(argv)}\n"
    )

    _run(argv, extra_env=extra_env)

    # Copy the mined artefacts from the default bench/onboard/<repo>/ location
    # into the keyed snapshot dir, so the snapshot is self-contained and portable.
    default_onboard = _onboard_dir(repo)
    if default_onboard.is_dir():
        for fname in ("onboard-notes.json", "onboard-queue.json", "onboard-learn-report.json"):
            src = default_onboard / fname
            if src.is_file():
                dst = snap_dir / fname
                shutil.copy2(str(src), str(dst))
                sys.stderr.write(f"[warm] copied {fname} -> {dst}\n")
    else:
        sys.stderr.write(
            f"[warm] WARN: default onboard dir {default_onboard} not found; "
            "artefacts stay wherever warm_start.js wrote them.\n"
        )

    sys.stderr.write(f"[warm] produce_snapshot DONE: {snap_dir}\n")
    return snap_dir


# ---------------------------------------------------------------------------
# load_snapshot
# ---------------------------------------------------------------------------

def load_snapshot(
    snapshot: str,
    workspace: str,
    *,
    daemon: str = _DEFAULT_DAEMON,
    # Level B options
    copy_graph: bool = False,
    # AGENTS.md passthrough
    agents_md: Optional[str] = None,
) -> None:
    """Inject a pre-learnt KB into a bench daemon workspace.

    Level A (always run, default):
        Calls ``scripts/onboard-learn.js --inject --confirm --workspace <ABS workspace>``
        with ORCH_GATE_OFF=1 and --model sonnet.  This re-injects already-drained
        onboard-notes.json into the daemon without re-running the expensive LLM step.

        *snapshot* must be a directory containing ``onboard-notes.json``.

    Level B (optional, copy_graph=True):
        Copies a materialised ``.graph`` snapshot into ``<workspace>/.graph``.
        Source: ``<snapshot>/.graph/`` (directory) or ``<snapshot>/.graph.tar.gz``
        (tarball, extracted via tarfile stdlib module).
        Applied BEFORE Level A so the daemon picks up the graph state first.

    AGENTS.md passthrough (optional, agents_md=<path>):
        Copies the given pre-exported AGENTS.md into ``<workspace>/AGENTS.md``.
        Applied after Level A+B.  Mirrors the FeatureBench FB_KB_PATH pattern.

    Parameters
    ----------
    snapshot:   Path to the snapshot directory (output of produce_snapshot, or
                an existing bench/onboard/<repo>/ directory).
    workspace:  ABSOLUTE path to the target bench daemon workspace.
                Finding #1: MUST be absolute — the daemon does path.join(workspace, '.graph');
                a relative string silently fails to persist.
    daemon:     Daemon base URL (used for the --inject HTTP call).
    copy_graph: Level B — copy/extract a .graph snapshot into the workspace.
    agents_md:  Path to a pre-exported AGENTS.md to copy into <workspace>/AGENTS.md.
    """
    snap = pathlib.Path(snapshot).resolve()

    # Finding #1: workspace MUST be absolute — check the original string BEFORE
    # resolve() so we catch relative inputs even on Windows (resolve() would
    # expand them against cwd, masking the mistake).
    if not os.path.isabs(workspace):
        raise ValueError(
            f"workspace must be an absolute path (Finding #1); got: {workspace!r}"
        )
    ws = pathlib.Path(workspace).resolve()
    ws_str = str(ws)

    if not snap.is_dir():
        raise FileNotFoundError(f"snapshot directory not found: {snap}")

    # -----------------------------------------------------------------------
    # Level B: copy/extract .graph snapshot (before Level A so daemon state is
    # restored before notes are injected)
    # -----------------------------------------------------------------------
    if copy_graph:
        graph_dir = snap / ".graph"
        graph_tar = snap / ".graph.tar.gz"
        ws_graph = ws / ".graph"

        if graph_dir.is_dir():
            sys.stderr.write(
                f"[warm] Level B: copying {graph_dir} -> {ws_graph}\n"
            )
            if ws_graph.exists():
                shutil.rmtree(str(ws_graph))
            shutil.copytree(str(graph_dir), str(ws_graph))

        elif graph_tar.is_file():
            import tarfile  # stdlib
            sys.stderr.write(
                f"[warm] Level B: extracting {graph_tar} -> {ws}\n"
            )
            ws_graph.parent.mkdir(parents=True, exist_ok=True)
            if ws_graph.exists():
                shutil.rmtree(str(ws_graph))
            with tarfile.open(str(graph_tar), "r:gz") as tf:
                tf.extractall(str(ws))  # noqa: S202 (trusted snapshot)

        else:
            sys.stderr.write(
                f"[warm] WARN: Level B requested but neither {graph_dir} "
                f"nor {graph_tar} exist; skipping.\n"
            )

    # -----------------------------------------------------------------------
    # Level A: re-inject drained batches via onboard-learn.js --inject
    # -----------------------------------------------------------------------
    notes_file = snap / "onboard-notes.json"
    if not notes_file.is_file():
        raise FileNotFoundError(
            f"onboard-notes.json not found in snapshot: {snap}\n"
            "Run produce_snapshot() or --drain first."
        )

    node = _node()
    onboard_learn = str(_ONBOARD_LEARN)
    if not pathlib.Path(onboard_learn).is_file():
        raise FileNotFoundError(
            f"scripts/onboard-learn.js not found at: {onboard_learn}"
        )

    # onboard-learn.js --inject reads notes from <inDir>/onboard-notes.json.
    # The script resolves --in as the directory that contains the notes file,
    # defaulting to <repo>/.graph/onboard; we pass --in pointing at the snapshot
    # dir so it finds notes regardless of the repo path.
    argv = [
        node, onboard_learn,
        "--repo", ws_str,        # dummy repo path (--inject doesn't mine)
        "--in", str(snap),       # snapshot dir contains onboard-notes.json
        "--inject",
        "--confirm",
        "--workspace", ws_str,
        "--model", "sonnet",     # known fix: onboarding model pin
    ]

    extra_env = {
        "ORCH_GATE_OFF": "1",    # known fix: ungate onboard writes
        "ORCH_DAEMON": daemon,
    }

    sys.stderr.write(
        f"[warm] Level A inject: workspace={ws_str}\n"
        f"[warm] running: {' '.join(argv)}\n"
    )

    _run(argv, extra_env=extra_env)

    sys.stderr.write("[warm] Level A inject DONE\n")

    # -----------------------------------------------------------------------
    # AGENTS.md passthrough
    # -----------------------------------------------------------------------
    if agents_md:
        src = pathlib.Path(agents_md).resolve()
        if not src.is_file():
            raise FileNotFoundError(f"agents_md source not found: {src}")
        ws.mkdir(parents=True, exist_ok=True)
        dst = ws / "AGENTS.md"
        shutil.copy2(str(src), str(dst))
        sys.stderr.write(f"[warm] AGENTS.md passthrough: {src} -> {dst}\n")

    sys.stderr.write(f"[warm] load_snapshot DONE: workspace={ws_str}\n")
