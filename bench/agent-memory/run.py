"""CLI entry point for the agent-memory benchmark harness.

Pipeline: load (datasets.py) → ingest (ingest.ConversationIngester)
          → probe (probe_runner.run_probe) → score (scorer.score)
          → report (scorer.generate_report)

Usage
-----
C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/agent-memory/run.py \\
    --benchmark locomo \\
    --data-dir  <abs-path-to-dir-containing-locomo10.json> \\
    --workspace-root <abs-path-for-per-conv-workspaces> \\
    --arms our-way,search,cold \\
    --daemon http://localhost:8787 \\
    --model sonnet \\
    --limit 3

Idempotent / resumable
----------------------
A per-conversation done-marker is written at:
    <output-dir>/checkpoints/<conv_id_slug>.done

Re-runs skip conversations whose done-marker exists. Delete the checkpoints/
directory (or individual .done files) to re-run from scratch.

Arms
----
--arms is a comma-separated subset of:  our-way, search, cold, distill, combined
Default: our-way,search,cold (all three).
Add distill to compare LLM fact-distillation against raw-chunk ingest.
Add combined to merge both ingest paths (production-equivalent retrieval).

Score
-----
After all probes complete, scorer.py is invoked automatically on the output
results.jsonl to produce report.json + report.md. Pass --skip-score to skip.

Runtime (note-mqgz977tbqe): embeddable Python 3.12 — stdlib ONLY, no pip.
Use the FULL PATH to the embeddable interpreter on the command line.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from datasets import load_locomo, load_longmemeval  # noqa: E402
from distill import ConversationDistiller  # noqa: E402
from ingest import ConversationIngester  # noqa: E402
from probe_runner import (  # noqa: E402
    _build_session_candidates,
    run_probe,
    run_probe_combined,
    run_probe_dag_combined,
    run_probe_distill,
)
from scorer import generate_report, score  # noqa: E402
from zonoid_lifecycle import warm_up  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slugify(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-") or "conv"


def _done_marker(checkpoint_dir: str, conv_id: str) -> str:
    return os.path.join(checkpoint_dir, f"{_slugify(conv_id)}.done")


def _mark_done(checkpoint_dir: str, conv_id: str) -> None:
    os.makedirs(checkpoint_dir, exist_ok=True)
    path = _done_marker(checkpoint_dir, conv_id)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"conv_id": conv_id, "ts": time.time()}) + "\n")


def _is_done(checkpoint_dir: str, conv_id: str) -> bool:
    return os.path.exists(_done_marker(checkpoint_dir, conv_id))


# ---------------------------------------------------------------------------
# Per-conversation runner
# ---------------------------------------------------------------------------

def _run_conv(
    conv: dict[str, Any],
    ingester: ConversationIngester,
    daemon: str,
    arms: list[str],
    max_probes: int | None,
    out_fh: "Any",
    distiller: "ConversationDistiller | None" = None,
) -> int:
    """Ingest *conv* (idempotent) and probe it through *arms*.

    Writes one JSONL record per (probe, arm) to *out_fh*.
    Returns the number of records written.

    If *distiller* is provided (non-None) and "distill" or "combined" is in *arms*,
    the conversation is also ingested via ``ConversationDistiller`` into a separate
    distill workspace, and distill/combined-arm probe records are written alongside
    the standard arm records.

    For the "combined" arm: retrieval merges both the raw-chunk workspace (populated
    by ``ConversationIngester``) and the atomic-fact distill workspace (populated by
    ``ConversationDistiller``), re-ranks by score, and answers from the merged pool.
    This is the production-equivalent arm.
    """
    conv_id = str(conv.get("conv_id") or "unknown")
    workspace = ingester.workspace_for(conv_id)

    print(
        f"[run] conv_id={conv_id!r}: {len(conv['sessions'])} sessions, "
        f"{len(conv['probes'])} probes",
        file=sys.stderr,
    )

    # Ingest (idempotent only if same workspace on same daemon — the note
    # dup-guard prevents double-writes within a workspace).
    ingest_map = ingester.ingest(conv)
    candidates = _build_session_candidates(conv, ingest_map)
    print(
        f"[run]   {len(candidates)} session candidates ingested",
        file=sys.stderr,
    )

    # Distill arm / combined arm: ingest facts into a separate workspace, then
    # answer probes using the distilled-fact graph (search-based retrieval over
    # atomic facts). Combined arm also requires this workspace.
    needs_distill = distiller is not None and ("distill" in arms or "combined" in arms or "dag-combined" in arms)
    distill_workspace: str | None = None
    if needs_distill:
        distill_workspace = distiller.workspace_for(conv_id)  # type: ignore[union-attr]
        print(f"[run]   distilling {conv_id!r} into {distill_workspace!r} …", file=sys.stderr)
        distill_map = distiller.ingest(conv)  # type: ignore[union-attr]
        n_facts = sum(len(v) for v in distill_map.values())
        print(f"[run]   distilled {n_facts} fact(s) across {len(distill_map)} session(s)", file=sys.stderr)

    probes = conv.get("probes") or []
    if max_probes is not None:
        probes = probes[:max_probes]

    n = 0
    for probe in probes:
        # Standard arms (our-way, search, cold).
        standard_arms = [a for a in arms if a not in ("distill", "combined")]
        if standard_arms:
            all_records = run_probe(
                base_url=daemon,
                workspace=workspace,
                conv_id=conv_id,
                probe=probe,
                candidates=candidates,
            )
            for rec in all_records:
                if rec["arm"] in arms:
                    out_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    out_fh.flush()
                    n += 1

        # Distill arm: search the distilled-fact workspace and answer.
        if "distill" in arms and distill_workspace is not None:
            distill_records = run_probe_distill(
                base_url=daemon,
                workspace=distill_workspace,
                conv_id=conv_id,
                probe=probe,
            )
            for rec in distill_records:
                out_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                out_fh.flush()
                n += 1

        # Combined arm: merge raw-chunk + distill retrieval pools, re-rank, answer.
        if "combined" in arms and distill_workspace is not None:
            combined_records = run_probe_combined(
                base_url=daemon,
                workspace=workspace,
                distill_workspace=distill_workspace,
                conv_id=conv_id,
                probe=probe,
            )
            for rec in combined_records:
                out_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                out_fh.flush()
                n += 1

        # dag-combined arm: DAG wiring + RAG fill (raw notes) + distill fact search, merged context.
        if "dag-combined" in arms and distill_workspace is not None:
            dc_records = run_probe_dag_combined(
                base_url=daemon,
                workspace=workspace,
                distill_workspace=distill_workspace,
                conv_id=conv_id,
                probe=probe,
                candidates=candidates,
            )
            for rec in dc_records:
                out_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                out_fh.flush()
                n += 1

    print(f"[run]   wrote {n} records for conv {conv_id!r}", file=sys.stderr)
    return n


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the agent-memory benchmark end-to-end: "
            "load → ingest → probe → score → report."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--benchmark",
        choices=["locomo", "longmemeval", "longmemeval-oracle", "longmemeval-s", "longmemeval-m"],
        default="locomo",
        help="Which benchmark to run (default: locomo).",
    )
    parser.add_argument(
        "--data-dir",
        required=True,
        help="Absolute path to directory containing dataset JSON files.",
    )
    parser.add_argument(
        "--arms",
        default="our-way,search,cold",
        help=(
            "Comma-separated arms to run (default: our-way,search,cold). "
            "Also: distill, combined. "
            "combined merges raw-chunk + distill retrieval pools (auto-enables distill ingest)."
        ),
    )
    parser.add_argument(
        "--daemon",
        default="http://localhost:8787",
        help="Orchestrator daemon URL (default: http://localhost:8787).",
    )
    parser.add_argument(
        "--workspace-root",
        default=None,
        help=(
            "Absolute path for per-conversation workspace directories. "
            "Defaults to a temp subdir."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help=(
            "Claude model alias for probe answerer + LLM judge "
            "(sets ZONOID_BENCH_MODEL; default: sonnet)."
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        dest="max_convs",
        help="Limit number of conversations (for testing / sampling).",
    )
    parser.add_argument(
        "--max-probes",
        type=int,
        default=None,
        help="Limit probes per conversation (for testing / sampling).",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help=(
            "Directory for results.jsonl + report files. "
            "Defaults to bench/agent-memory/ relative to this script."
        ),
    )
    parser.add_argument(
        "--skip-score",
        action="store_true",
        help="Skip post-run scoring (do not invoke scorer.py).",
    )
    parser.add_argument(
        "--no-llm-judge",
        action="store_true",
        help="During scoring, skip LLM judge calls — compute token-F1 only.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=True,
        help=(
            "Skip conversations with existing done-markers (default: True). "
            "Use --no-resume to force re-run all conversations."
        ),
    )
    parser.add_argument(
        "--no-resume",
        action="store_false",
        dest="resume",
        help="Re-run all conversations, ignoring existing checkpoints.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # Model override
    if args.model:
        os.environ["ZONOID_BENCH_MODEL"] = args.model

    # Resolve paths
    data_dir = os.path.abspath(args.data_dir)
    output_dir = os.path.abspath(args.output_dir) if args.output_dir else _HERE
    checkpoint_dir = os.path.join(output_dir, "checkpoints")
    results_path = os.path.join(output_dir, "results.jsonl")

    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    valid_arms = {"our-way", "search", "cold", "distill", "combined", "dag-combined"}
    bad = [a for a in arms if a not in valid_arms]
    if bad:
        print(f"ERROR: unknown arm(s): {bad}. Valid: {sorted(valid_arms)}", file=sys.stderr)
        return 2

    # combined arm requires the distill ingest path — auto-enable it if not already present.
    if "combined" in arms and "distill" not in arms:
        arms = list(arms) + ["distill"]
        print(
            "[run] combined arm selected — auto-enabling distill ingest (needed for both pools)",
            file=sys.stderr,
        )

    # dag-combined requires the distill ingest path.
    if "dag-combined" in arms and "distill" not in arms:
        arms = list(arms) + ["distill"]
        print(
            "[run] dag-combined arm selected — auto-enabling distill ingest (needed for distill tier)",
            file=sys.stderr,
        )

    # Load conversations
    bm = args.benchmark.lower()
    print(f"[run] loading {bm} from {data_dir} …", file=sys.stderr)
    if bm == "locomo":
        convs = load_locomo(data_dir)
    elif bm in ("longmemeval", "longmemeval-oracle"):
        convs = load_longmemeval(data_dir, variant="oracle")
    elif bm == "longmemeval-s":
        convs = load_longmemeval(data_dir, variant="s")
    elif bm == "longmemeval-m":
        convs = load_longmemeval(data_dir, variant="m")
    else:
        print(f"ERROR: unknown benchmark {bm!r}", file=sys.stderr)
        return 2

    if args.max_convs is not None:
        convs = convs[: args.max_convs]

    print(f"[run] {len(convs)} conversation(s) to run; arms={arms}", file=sys.stderr)

    # Warm up embedder (one cold-start latency before the hot loop)
    print("[run] warming up embedder (may take up to 90s on cold start) …", file=sys.stderr)
    try:
        warm_up(args.daemon, timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: daemon warm-up failed: {exc}", file=sys.stderr)
        print("      Continuing — individual probe calls will handle retries.", file=sys.stderr)

    ingester = ConversationIngester(
        base_url=args.daemon,
        workspace_root=args.workspace_root,
        timeout=120,
    )

    # Distill arm / combined arm: create a distiller with a separate workspace root so
    # distilled-fact notes land in a different directory than raw-chunk notes — prevents
    # cross-contamination. Both "distill" and "combined" require the distiller.
    distiller: ConversationDistiller | None = None
    if "distill" in arms or "combined" in arms:
        distill_root = (
            os.path.join(args.workspace_root, "distill")
            if args.workspace_root
            else None
        )
        distiller = ConversationDistiller(
            base_url=args.daemon,
            workspace_root=distill_root,
            timeout=120,
        )
        print(f"[run] distill arm enabled; workspace_root={distiller.workspace_root!r}", file=sys.stderr)

    # Run conversations
    os.makedirs(output_dir, exist_ok=True)
    total = 0
    skipped = 0

    # Open in append mode so partial runs can be resumed.
    open_mode = "a" if args.resume else "w"
    with open(results_path, open_mode, encoding="utf-8") as out_fh:
        for conv in convs:
            conv_id = str(conv.get("conv_id") or "unknown")

            if args.resume and _is_done(checkpoint_dir, conv_id):
                print(f"[run] skipping {conv_id!r} (done-marker found)", file=sys.stderr)
                skipped += 1
                continue

            try:
                n = _run_conv(
                    conv=conv,
                    ingester=ingester,
                    daemon=args.daemon,
                    arms=arms,
                    max_probes=args.max_probes,
                    out_fh=out_fh,
                    distiller=distiller,
                )
                total += n
                _mark_done(checkpoint_dir, conv_id)
            except Exception as exc:  # noqa: BLE001
                print(
                    f"ERROR: conv {conv_id!r} failed: {exc}; skipping and continuing.",
                    file=sys.stderr,
                )

    print(
        f"[run] done — {total} record(s) written to {results_path} "
        f"({skipped} conversation(s) skipped via checkpoints)",
        file=sys.stderr,
    )

    # Score
    if args.skip_score:
        print("[run] --skip-score: skipping scorer.", file=sys.stderr)
        return 0

    if not os.path.exists(results_path) or os.path.getsize(results_path) == 0:
        print("[run] results.jsonl is empty — nothing to score.", file=sys.stderr)
        return 0

    print("[run] scoring results …", file=sys.stderr)
    try:
        scored = score(
            results_path=results_path,
            use_llm_judge=not args.no_llm_judge,
            verbose=False,
        )
        json_path, md_path = generate_report(
            scored=scored,
            benchmark=bm,
            output_dir=output_dir,
        )
        arms_out = scored.get("arms", {})
        for arm, d in sorted(arms_out.items()):
            from scorer import _pct
            print(
                f"[run] arm={arm}  accuracy={_pct(d.get('accuracy'))}"
                f"  f1={_pct(d.get('f1_mean'))}  n={d.get('total', 0)}",
                file=sys.stderr,
            )
        print(f"[run] report.json → {json_path}", file=sys.stderr)
        print(f"[run] report.md   → {md_path}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: scoring failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
