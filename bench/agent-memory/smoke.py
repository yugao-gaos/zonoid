"""Acceptance smoke test for the agent-memory benchmark harness.

Mirrors bench/swe-bench-cl/smoke_llm_judge.py in structure. Self-contained:
no licensed datasets required - the toy conversation is defined inline.

Toy fixture
-----------
3 sessions, 1 probe. The planted multi-hop fact lives ONLY in session 1:
  "I finally made that raspberry coulis - it took exactly 37 minutes."
A distractor session (session 2) is topically adjacent (desserts) but does NOT
contain the answer. Session 0 is entirely unrelated (hiking).

Probe: "How long did it take to make the raspberry coulis?"  Gold: "37 minutes"

Assertions (printed PASS/FAIL per line):
  [A] ConversationIngester creates one note per session (3 sessions -> 3 note keys).
  [B] our-way: blind judge keeps session 1 (evidence), NOT session 2 (distractor);
      GET /task/context returns session-1 note key and does NOT return session-2 note key.
  [C] our-way answers the planted question correctly (answer contains "37").
  [D] cold arm FAILS to answer correctly (rigging guard - answer must NOT contain "37").

Usage (embeddable Python full path):
    C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/agent-memory/smoke.py
    C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/agent-memory/smoke.py --daemon http://localhost:8787

Runtime: stdlib ONLY (no pip). Embeddable Python 3.12 safe.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile

# Embeddable Python 3.12 strips cwd from sys.path; always import siblings by full path.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from ingest import ConversationIngester  # noqa: E402
from probe_runner import (  # noqa: E402
    _build_session_candidates,
    run_cold,
    run_our_way,
)
from zonoid_lifecycle import warm_up  # noqa: E402


# ---------------------------------------------------------------------------
# Toy conversation (no licensed data - fully inline)
# ---------------------------------------------------------------------------
# Three sessions:
#   session 0 - hiking trip (unrelated)
#   session 1 - raspberry coulis, "exactly 37 minutes" (EVIDENCE)
#   session 2 - chocolate lava cake (topically adjacent dessert, NO answer)
# Probe asks about the coulis timing -> gold "37 minutes".

TOY_CONV: dict = {
    "conv_id": "smoke-conv-001",
    "sessions": [
        {
            "idx": 0,
            "date": "2025-01-10",
            "turns": [
                {"speaker": "user",      "text": "Just got back from hiking the ridge trail.", "turn_id": "t1"},
                {"speaker": "assistant", "text": "How long was the hike?",                     "turn_id": "t2"},
                {"speaker": "user",      "text": "About three hours each way.",                "turn_id": "t3"},
                {"speaker": "assistant", "text": "That's a solid day out. Did you see wildlife?", "turn_id": "t4"},
                {"speaker": "user",      "text": "Just some deer near the top.",               "turn_id": "t5"},
            ],
        },
        {
            "idx": 1,
            "date": "2025-02-14",
            "turns": [
                {"speaker": "user",      "text": "I finally made that raspberry coulis today.", "turn_id": "t1"},
                {"speaker": "assistant", "text": "Oh nice, how did it go?",                    "turn_id": "t2"},
                {"speaker": "user",      "text": "It took exactly 37 minutes from start to finish.", "turn_id": "t3"},
                {"speaker": "assistant", "text": "37 minutes is pretty efficient for a coulis.", "turn_id": "t4"},
                {"speaker": "user",      "text": "The key was keeping the heat low the whole time.", "turn_id": "t5"},
            ],
        },
        {
            "idx": 2,
            "date": "2025-03-01",
            "turns": [
                {"speaker": "user",      "text": "Tried making chocolate lava cakes last night.", "turn_id": "t1"},
                {"speaker": "assistant", "text": "Ooh, did they come out with a runny center?",   "turn_id": "t2"},
                {"speaker": "user",      "text": "Perfectly molten! Baked them at 425F for 12 minutes.", "turn_id": "t3"},
                {"speaker": "assistant", "text": "That's the sweet spot. Did you serve them with anything?", "turn_id": "t4"},
                {"speaker": "user",      "text": "Just powdered sugar and cream.",                "turn_id": "t5"},
            ],
        },
    ],
    "probes": [
        {
            "qid": "smoke-q1",
            "question": "How long did it take to make the raspberry coulis?",
            "answer":   "37 minutes",
            "category": "single-hop",
            "evidence": ["1"],  # session idx 1 is the evidence
        }
    ],
}

TOY_PROBE = TOY_CONV["probes"][0]


# ---------------------------------------------------------------------------
# Rigging-guard: answer correctness check
# ---------------------------------------------------------------------------

def _answer_correct(predicted: str, expected_token: str = "37") -> bool:
    """Return True if *predicted* contains the gold token '37' (the unique fact)."""
    return expected_token in (predicted or "")


# ---------------------------------------------------------------------------
# Smoke runner
# ---------------------------------------------------------------------------

def run_smoke(daemon: str = "http://localhost:8787") -> int:
    """Run all four assertions against the live daemon.

    Returns 0 on overall PASS, 1 on any FAIL, 2 if the daemon is unreachable.
    """
    results: list[tuple[str, bool, str]] = []  # (label, passed, detail)

    def _record(label: str, passed: bool, detail: str = "") -> None:
        status = "PASS" if passed else "FAIL"
        suffix = ("  - " + detail) if detail else ""
        print("  [%s] %s%s" % (status, label, suffix))
        results.append((label, passed, detail))

    # ------------------------------------------------------------------
    # Daemon reachability + embedder warm-up
    # ------------------------------------------------------------------
    print("[smoke] checking daemon reachability + embedder warm-up ...")
    try:
        warm_up(daemon, timeout=120)
        print("[smoke] daemon reachable + embedder warm-up OK")
    except Exception as exc:
        print("\nDAEMON UNREACHABLE: %s" % exc)
        print(
            "Cannot run smoke test - start the Zonoid daemon at "
            + daemon + " and re-run."
        )
        return 2

    # ------------------------------------------------------------------
    # Isolated temp workspace (clean slate for every smoke run)
    # ------------------------------------------------------------------
    ws_root = tempfile.mkdtemp(prefix="zonoid-smoke-")
    print("[smoke] workspace root: %s" % ws_root)

    ingester = ConversationIngester(
        base_url=daemon,
        workspace_root=ws_root,
        timeout=120,
    )
    conv_id = TOY_CONV["conv_id"]
    workspace = ingester.workspace_for(conv_id)

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------
    print("\n[smoke] ingesting toy conversation (3 sessions) ...")
    try:
        ingest_map = ingester.ingest(TOY_CONV)
    except RuntimeError as exc:
        print("FATAL: ingestion failed - %s" % exc)
        return 1

    # ------------------------------------------------------------------
    # [A] One note per session
    # ------------------------------------------------------------------
    print("\n[A] ConversationIngester - one note per session")
    n_sessions = len(TOY_CONV["sessions"])
    n_notes = sum(len(v) for v in ingest_map.values())
    session_coverage = all(
        str(s["idx"]) in ingest_map and len(ingest_map[str(s["idx"])]) >= 1
        for s in TOY_CONV["sessions"]
    )
    # Each session should yield exactly one note (short fixture, no splits).
    a_ok = n_notes == n_sessions and session_coverage
    _record(
        "[A] ingest: 1 note per session",
        a_ok,
        "sessions=%d, notes_written=%d, all_covered=%s" % (n_sessions, n_notes, session_coverage),
    )

    if not ingest_map:
        print("[smoke] FATAL: ingest returned empty map; cannot continue with our-way assertions.")
        print("\nOVERALL: FAIL")
        return 1

    # ------------------------------------------------------------------
    # Build session candidates (mirrors probe_runner.run_probe)
    # ------------------------------------------------------------------
    candidates = _build_session_candidates(TOY_CONV, ingest_map)
    print("[smoke] %d session candidate(s): " % len(candidates) + ", ".join(
        "sid=%s" % c.sid for c in candidates
    ))

    # ------------------------------------------------------------------
    # [B] + [C] our-way arm
    # ------------------------------------------------------------------
    print("\n[B+C] our-way arm (DAG read: blind keep -> /task/context -> answer) ...")
    ow = run_our_way(daemon, workspace, TOY_PROBE, candidates)

    kept_sids:    list[str] = ow.get("kept_sids", [])
    context_keys: list[str] = ow.get("context_keys", [])
    predicted_ow: str       = ow.get("predicted", "")

    print("  kept sids:    %s" % kept_sids)
    print("  context keys: %s" % context_keys)
    print("  answer:       %r" % predicted_ow)

    # Evidence session note key (session idx "1")
    evidence_notes_1 = {
        n["note_key"]
        for n in ingest_map.get("1", [])
        if n.get("note_key")
    }
    # Distractor session note keys (session idx "2")
    distractor_notes_2 = {
        n["note_key"]
        for n in ingest_map.get("2", [])
        if n.get("note_key")
    }

    ctx_set = set(context_keys)

    # [B-i] Evidence session is in /task/context
    b_evidence = bool(ctx_set & evidence_notes_1)
    _record(
        "[B-i] our-way: /task/context includes evidence session (idx=1)",
        b_evidence,
        "evidence_notes=%s, ctx=%s" % (evidence_notes_1, ctx_set),
    )

    # [B-ii] Distractor session is NOT in /task/context
    b_no_distractor = not (ctx_set & distractor_notes_2)
    _record(
        "[B-ii] our-way: /task/context excludes distractor session (idx=2)",
        b_no_distractor,
        "distractor_notes=%s, ctx=%s" % (distractor_notes_2, ctx_set),
    )

    # [C] our-way answer correct
    c_ok = _answer_correct(predicted_ow, "37")
    _record(
        "[C] our-way: answer contains the planted fact ('37')",
        c_ok,
        "predicted=%r" % predicted_ow,
    )

    # ------------------------------------------------------------------
    # [D] Cold arm FAILS - rigging guard
    # ------------------------------------------------------------------
    print("\n[D] cold arm (floor - must NOT contain '37') ...")
    cold_result = run_cold(TOY_PROBE)
    predicted_cold: str = cold_result.get("predicted", "")
    print("  cold answer: %r" % predicted_cold)

    d_ok = not _answer_correct(predicted_cold, "37")
    _record(
        "[D] cold: rigging guard - answer does NOT contain '37' (no-memory floor)",
        d_ok,
        "predicted=%r" % predicted_cold,
    )

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    overall = all(p for _, p, _ in results)
    print("\n" + "=" * 60)
    print("OVERALL: %s" % ("PASS" if overall else "FAIL"))
    print("=" * 60)
    if not overall:
        failed = [lbl for lbl, p, _ in results if not p]
        print("  failed assertions: %s" % failed)
    return 0 if overall else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Acceptance smoke test for the agent-memory harness. "
            "Requires a live Zonoid daemon (default http://localhost:8787)."
        )
    )
    parser.add_argument(
        "--daemon",
        default="http://localhost:8787",
        help="Daemon base URL (default: http://localhost:8787).",
    )
    args = parser.parse_args(argv)
    return run_smoke(args.daemon)


if __name__ == "__main__":
    sys.exit(main())
