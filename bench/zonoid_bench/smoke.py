"""bench/zonoid_bench/smoke.py — Zonoid Bench SDK integration smoke test (merge gate).

Full end-to-end smoke that ties together the entire SDK:
    daemon + client + arms (run_canonical_wiring, run_retrieve_and_answer, run_cold,
    run_rag_control) + report (score, render_report)

Spawns its OWN isolated daemon on a FREE port (never 8787) so it runs independently
of the production daemon at :8787.  The smoke is entirely self-contained — no licensed
data, no external service, no shared state.

Assertions
----------
A1  ON (retrieve_and_answer) answer CONTAINS the planted fact.
A2  Canonical wiring surfaced >= 1 context edge (overlay_edge / suggest_links used).
A3  cold answer does NOT contain the planted fact (rigging guard).

Usage (embeddable Python full path, from the repo root):
    C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/zonoid_bench/smoke.py

Runtime: stdlib-only + Node (for daemon). Embeddable Python 3.12 safe.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

# ── path bootstrap ─────────────────────────────────────────────────────────────
# Embeddable Python strips cwd from sys.path; insert bench/ so zonoid_bench is
# importable regardless of the working directory.
_HERE  = os.path.dirname(os.path.abspath(__file__))  # bench/zonoid_bench/
_BENCH = os.path.dirname(_HERE)                        # bench/
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

# Force UTF-8 output so assertion glyphs (PASS/FAIL) never crash on cp1252 consoles.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

# ── SDK imports ────────────────────────────────────────────────────────────────
from zonoid_bench import daemon as daemon_mod     # noqa: E402
from zonoid_bench.client import ZonoidClient      # noqa: E402
from zonoid_bench import arms as arms_mod         # noqa: E402
from zonoid_bench import report as report_mod     # noqa: E402


# ── Resolve daemon.js ──────────────────────────────────────────────────────────
# The repo root for this file (bench/zonoid_bench/smoke.py) is two levels up.
# When running from a git worktree that has no node_modules, Node.js cannot
# resolve @xenova/transformers for the embed sidecar.  We walk up the filesystem
# to find the nearest daemon.js that sits alongside a node_modules directory,
# falling back to the local worktree's daemon.js when none is found.

def _find_daemon_js() -> str:
    """Return the path to a daemon.js whose sibling node_modules has @xenova/transformers.

    Search order:
    1. Local repo root (two levels up from this file) — used if node_modules present.
    2. Git worktree list — the first (main) worktree in the list, which typically has
       the full node_modules install.
    3. Fallback to local repo root regardless (embed sidecar may load from its own path).
    """
    import subprocess, shutil

    # Candidate 1: local worktree repo root.
    local_root = os.path.normpath(os.path.join(_HERE, "..", ".."))
    local_js = os.path.join(local_root, "daemon.js")
    local_xenova = os.path.join(local_root, "node_modules", "@xenova")
    if os.path.isfile(local_js) and os.path.isdir(local_xenova):
        return local_js

    # Candidate 2: git worktree list — first entry is the main worktree.
    git = shutil.which("git")
    if git:
        try:
            result = subprocess.run(
                [git, "worktree", "list", "--porcelain"],
                capture_output=True, text=True, timeout=10,
                cwd=local_root,
            )
            # Parse: each worktree block starts with "worktree <path>"
            for line in result.stdout.splitlines():
                if line.startswith("worktree "):
                    wt_path = line[len("worktree "):].strip()
                    wt_js = os.path.join(wt_path, "daemon.js")
                    wt_xenova = os.path.join(wt_path, "node_modules", "@xenova")
                    if os.path.isfile(wt_js) and os.path.isdir(wt_xenova):
                        return wt_js
        except Exception:
            pass

    # Fallback: local worktree daemon.js (embed may still work if models cached).
    return local_js


# ──────────────────────────────────────────────────────────────────────────────
# Toy unit — the planted fact + distractor
# ──────────────────────────────────────────────────────────────────────────────
#
# Planted fact: a deliberately non-world-knowledge token so the cold arm cannot
# know it.  Distractor: a plausible but different codename to pollute the
# workspace and verify the retrieval surface isn't just returning everything.

def _make_token() -> str:
    """Generate a unique run-time token that cannot be guessed by the cold arm.

    The token is derived from os.urandom so it is different every run, not
    mentioned in any model training data, and not present in this conversation's
    context (since it's generated at RUNTIME inside the smoke process, not stated
    in the conversation that spawns it).
    """
    import hashlib as _hashlib
    raw = __import__("os").urandom(12)
    h = _hashlib.sha256(raw).hexdigest()[:12].upper()
    return f"SMK-{h[:4]}-{h[4:8]}-{h[8:]}"


# Generated at import time so it's consistent for a single run.
PLANTED_FACT_TOKEN: str = _make_token()

_PLANTED_NOTE_TITLE   = "Bench smoke -- integration run secret"

def _make_summaries() -> tuple[str, str]:
    """Build the planted and distractor summaries around the runtime token."""
    tok = PLANTED_FACT_TOKEN
    planted = (
        f"The one-time secret token for this bench smoke run is {tok}. "
        f"This value is stored only in this isolated knowledge base and is "
        f"not present in any model training corpus or public source."
    )
    distractor = (
        "A separate session identifier SMK-AAAA-BBBB-CCCC belongs to a legacy "
        "test run and is unrelated to the current smoke session's secret token."
    )
    return planted, distractor


_PLANTED_NOTE_SUMMARY, _DISTRACTOR_NOTE_SUMMARY = _make_summaries()
_DISTRACTOR_NOTE_TITLE = "Bench smoke -- distractor session id"

_PROBE_QUESTION = (
    "What is the one-time secret token stored in this bench smoke session's knowledge base?"
)


# ──────────────────────────────────────────────────────────────────────────────
# PASS / FAIL helpers
# ──────────────────────────────────────────────────────────────────────────────

_results: list[tuple[str, bool, str]] = []


def _assert(name: str, ok: bool, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    line = f"  [{tag}] {name}"
    if detail:
        line += f" -- {detail}"
    print(line)
    _results.append((name, ok, detail))
    return ok


# ──────────────────────────────────────────────────────────────────────────────
# main
# ──────────────────────────────────────────────────────────────────────────────

def main() -> int:
    print("=" * 70)
    print("Zonoid Bench SDK -- integration smoke test")
    print("=" * 70)

    # ── PHASE 0: start isolated daemon ─────────────────────────────────────────
    print("\n[Phase 0] Starting isolated bench daemon ...")
    _daemon_js = _find_daemon_js()
    print(f"  using daemon.js: {_daemon_js}")
    t0 = time.monotonic()
    handle = daemon_mod.start(daemon_js=_daemon_js)  # auto-selects free port + temp data_dir
    elapsed = time.monotonic() - t0
    port = handle.port
    base_url = handle.base_url
    data_dir = handle.data_dir
    print(f"  daemon ready in {elapsed:.1f}s  port={port}  pid={handle.proc.pid}")
    print(f"  data_dir={data_dir!r}")

    # Sanity: must not have grabbed the production port.
    if port == 8787:
        print("ABORT: daemon started on :8787 (the production port) -- bailing out.")
        daemon_mod.stop(handle)
        return 1

    # Isolated workspace for this smoke run.
    workspace = os.path.abspath(tempfile.mkdtemp(prefix="zonoid-smoke-ws-"))
    client = ZonoidClient(base_url, workspace=workspace, timeout=120)

    try:
        return _run_smoke(client, data_dir, port)
    finally:
        print(f"\n[Phase 6] Stopping daemon (port={port}) ...")
        rc = daemon_mod.stop(handle)
        print(f"  daemon exited  exit_code={rc}")

    return 1  # unreachable but satisfies type checkers


def _run_smoke(client: ZonoidClient, data_dir: str, port: int) -> int:
    # ── PHASE 1: warm up embedder ───────────────────────────────────────────────
    print("\n[Phase 1] Warm up embedding model ...")
    client.warm_up()
    # Real reachability probe (warm_up swallows errors).
    probe_hits = client.search("warmup reachability probe", k=1)
    print(f"  warm_up OK -- /search round-tripped ({len(probe_hits)} hits)")

    # ── PHASE 2: ingest toy unit — planted fact + distractor ───────────────────
    print("\n[Phase 2] Ingest toy unit (planted fact + distractor) ...")

    resp_fact = client.post_note(
        title=_PLANTED_NOTE_TITLE,
        summary=_PLANTED_NOTE_SUMMARY,
        category="bench-smoke",
        tags=["smoke", "integration", "planted-fact"],
    )
    fact_key = resp_fact.get("key") or resp_fact.get("note_key") or ""
    print(f"  planted fact note  key={fact_key!r}")

    resp_dist = client.post_note(
        title=_DISTRACTOR_NOTE_TITLE,
        summary=_DISTRACTOR_NOTE_SUMMARY,
        category="bench-smoke",
        tags=["smoke", "integration", "distractor"],
    )
    dist_key = resp_dist.get("key") or resp_dist.get("note_key") or ""
    print(f"  distractor note    key={dist_key!r}")

    if not fact_key:
        print("ABORT: planted fact note returned no key -- daemon may be unhealthy.")
        return 1

    # Let the embedder index both notes before suggest_links/search.
    print("  sleeping 5 s for embedder to index ...")
    time.sleep(5)

    # ── PHASE 3: ON arm — canonical wiring (run_canonical_wiring) ──────────────
    print("\n[Phase 3] Canonical ON-arm wiring (run_canonical_wiring) ...")
    unit_id = f"smoke-unit-{int(time.time()) % 100000}"
    wiring = arms_mod.run_canonical_wiring(
        client,
        unit_id=unit_id,
        task_summary=_PROBE_QUESTION,
        as_task=False,   # note path (FB default)
        tags=["smoke", "integration"],
    )
    print(f"  unit note key  : {wiring.task_key!r}")
    print(f"  search hits    : {wiring.search_hits}")
    print(f"  suggest seen   : {[(s.get('key'), s.get('ceScore'), s.get('score')) for s in wiring.suggest_seen]}")
    print(f"  wired edges    : {wiring.wired_edges}")
    print(f"  context deps   : {[d.get('label') for d in wiring.context_deps]}")

    # ── PHASE 4: retrieve-and-answer ON arm ────────────────────────────────────
    print("\n[Phase 4] ON arm -- retrieve_and_answer ...")
    unit_id_ra = f"smoke-ra-{int(time.time()) % 100000}"
    on_result = arms_mod.run_retrieve_and_answer(
        client,
        unit_id=unit_id_ra,
        question=_PROBE_QUESTION,
        task_summary=_PROBE_QUESTION,
        data_dir=data_dir,
    )
    print(f"  ON predicted   : {on_result.predicted!r}")
    print(f"  context keys   : {on_result.context_keys}")
    on_wiring = on_result.wiring

    # ── PHASE 5a: cold arm (no memory — rigging guard) ─────────────────────────
    print("\n[Phase 5a] Cold arm (no memory -- rigging guard) ...")
    cold_result = arms_mod.run_cold(_PROBE_QUESTION)
    print(f"  cold predicted : {cold_result.predicted!r}")

    # ── PHASE 5b: RAG-control arm (plain search, no task key) ──────────────────
    print("\n[Phase 5b] RAG-control arm (plain search, no DAG wiring) ...")
    rag_result = arms_mod.run_rag_control(client, _PROBE_QUESTION)
    print(f"  rag predicted  : {rag_result.predicted!r}")
    print(f"  rag context    : {rag_result.context_keys}")

    # ── PHASE 5c: score via report.score + render_report ───────────────────────
    print("\n[Phase 5c] Score via report.score + render_report ...")
    records = [
        {
            "arm": "on",
            "category": "integration-smoke",
            "question": _PROBE_QUESTION,
            "gold": PLANTED_FACT_TOKEN,
            "predicted": on_result.predicted,
        },
        {
            "arm": "cold",
            "category": "integration-smoke",
            "question": _PROBE_QUESTION,
            "gold": PLANTED_FACT_TOKEN,
            "predicted": cold_result.predicted,
        },
        {
            "arm": "rag_control",
            "category": "integration-smoke",
            "question": _PROBE_QUESTION,
            "gold": PLANTED_FACT_TOKEN,
            "predicted": rag_result.predicted,
        },
    ]
    # Write results + score (token-F1 only; no LLM judge -- keeps smoke offline-fast).
    results_dir = tempfile.mkdtemp(prefix="zonoid-smoke-report-")
    results_path = os.path.join(results_dir, "smoke-results.jsonl")
    report_mod.write_results(records, results_path)

    scores = report_mod.score(records, use_llm_judge=False, use_f1=True)
    arms_scores = scores.get("arms", {})
    print(f"  token-F1 scores:")
    for arm_name, arm_data in sorted(arms_scores.items()):
        f1 = arm_data.get("f1_mean")
        f1_str = f"{f1:.3f}" if f1 is not None else "N/A"
        print(f"    {arm_name:14s} F1={f1_str}")

    json_path, md_path = report_mod.render_report(
        scores,
        path_md=os.path.join(results_dir, "smoke-report.md"),
        path_json=os.path.join(results_dir, "smoke-report.json"),
        title="Zonoid Bench SDK integration smoke report",
    )
    print(f"  report.json -> {json_path}")
    print(f"  report.md   -> {md_path}")

    # ── ASSERTIONS ─────────────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("Assertions")
    print("=" * 70)

    ok = True

    # A1: ON (retrieve_and_answer) answer CONTAINS the planted fact token.
    on_answer_lc = (on_result.predicted or "").lower()
    a1_ok = PLANTED_FACT_TOKEN.lower() in on_answer_lc
    ok = _assert(
        "A1  ON answer contains planted fact",
        a1_ok,
        f"planted={PLANTED_FACT_TOKEN!r}  predicted={on_result.predicted!r}",
    ) and ok

    # A2: Canonical wiring surfaced >= 1 context edge.
    #     Either wired_edges from run_canonical_wiring or context_keys from
    #     run_retrieve_and_answer must be non-empty.
    wired_from_canonical = wiring.wired_edges
    wired_from_ra = on_result.context_keys
    a2_ok = bool(wired_from_canonical or wired_from_ra)
    ok = _assert(
        "A2  canonical wiring surfaced >= 1 context edge",
        a2_ok,
        f"canonical.wired_edges={wired_from_canonical}  "
        f"retrieve_and_answer.context_keys={wired_from_ra}",
    ) and ok

    # A3: cold answer does NOT contain the planted fact (rigging guard).
    cold_answer_lc = (cold_result.predicted or "").lower()
    a3_ok = PLANTED_FACT_TOKEN.lower() not in cold_answer_lc
    ok = _assert(
        "A3  cold answer does NOT contain planted fact (rigging guard)",
        a3_ok,
        f"planted={PLANTED_FACT_TOKEN!r}  cold={cold_result.predicted!r}",
    ) and ok

    # Summary
    print("\n" + "=" * 70)
    n_pass = sum(1 for _, v, _ in _results if v)
    n_fail = sum(1 for _, v, _ in _results if not v)
    print(f"Results: {n_pass} PASS  /  {n_fail} FAIL  (daemon port={port})")
    print("=" * 70)
    print("OVERALL: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
