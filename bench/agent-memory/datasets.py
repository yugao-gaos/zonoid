"""Dataset loaders for the agent-memory benchmark harness.

Reads LoCoMo and LongMemEval from a local ``--data-dir`` and emits ONE common shape per item:

    {
        "conv_id":  str,
        "sessions": [
            {"idx": int, "date": str | None, "turns": [{"speaker": str, "text": str, "turn_id": str | None}]}
        ],
        "probes": [
            {"qid": str, "question": str, "answer": str, "category": str, "evidence": list[str]}
        ]
    }

------------------------------------------------------------------------
Dataset sources and licenses
------------------------------------------------------------------------

LoCoMo
  URL:     https://github.com/snap-research/locomo
  Paper:   "LoCoMo: Large-Scale Multi-Session Conversations" (Maharana et al., 2024)
           https://arxiv.org/abs/2402.17753
  License: CC BY-NC 4.0 — non-commercial use only.
           Data files MUST NOT be committed to this repository.
           Download locomo10.json from the link above and point --data-dir at it.

LongMemEval
  URL:     https://github.com/xiaowu0162/LongMemEval
  Paper:   "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory"
           (Wu et al., 2024)  https://arxiv.org/abs/2410.10813
  License: MIT — free use, redistribution with attribution.
           Data files are NOT committed here; download from the repo above.

NOTE: Only hand-authored synthetic fixtures (bench/agent-memory/fixtures/) are committed.
      The actual dataset files are read at runtime from --data-dir.
------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------

def _load_json(data_dir: str, filename: str) -> Any:
    """Load a JSON file from *data_dir*, raising a clean error if absent."""
    path = os.path.join(data_dir, filename)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Dataset file not found: {path}\n"
            f"Download it from the dataset source and place it in --data-dir."
        )
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _norm_turns(raw_turns: list[Any]) -> list[dict]:
    """Normalise a raw turn list to the common {speaker, text, turn_id?} shape.

    Handles both LoCoMo-style dicts and plain strings (used by some synthetic fixtures).
    """
    out = []
    for i, t in enumerate(raw_turns):
        if isinstance(t, str):
            out.append({"speaker": "unknown", "text": t, "turn_id": None})
            continue
        if not isinstance(t, dict):
            continue
        speaker = (
            t.get("speaker")
            or t.get("role")
            or t.get("user")
            or ("user" if i % 2 == 0 else "assistant")
        )
        text = t.get("text") or t.get("content") or t.get("utterance") or ""
        turn_id = t.get("turn_id") or t.get("id") or None
        out.append({"speaker": str(speaker), "text": str(text), "turn_id": turn_id})
    return out


# ---------------------------------------------------------------------------
# LoCoMo loader
# ---------------------------------------------------------------------------
# Source:  https://github.com/snap-research/locomo
# License: CC BY-NC 4.0 (non-commercial only) — do NOT commit data files.
#
# locomo10.json has TWO possible formats:
#
# 1. REAL locomo10.json format (10 dialogues, conv_id = sample_id):
#      Each item has:
#        - "sample_id": str   (e.g. "conv-26")
#        - "conversation": dict with flat keys:
#            "session_1": [ {speaker, text, dia_id?}, ... ]
#            "session_1_date_time": "1:56 pm on 8 May, 2023"
#            "session_2": [ ... ]
#            "session_2_date_time": "..."
#            ... (up to session_N)
#        - "qa": [ {question, answer, category, evidence?, ...} ]
#
# 2. Synthetic fixture format (bench/agent-memory/fixtures/locomo10.json):
#      Each item has:
#        - "dialogue_id" or "conv_id" or "id": str
#        - "sessions": [ {session_id, date, conversation:[...]} ]
#        - "qa": [ ... ]
#
# Categories (verbatim pass-through):
#   "single-hop", "multi-hop", "temporal", "commonsense", "open_qa",
#   "unanswerable" / "adversarial" — map verbatim, do not normalise.
# ---------------------------------------------------------------------------


def _load_locomo_real_sessions(item: dict) -> list[dict]:
    """Extract sessions from the REAL LoCoMo locomo10.json format.

    The real dataset stores sessions as flat keys inside the ``conversation`` dict:
        ``session_1``, ``session_2``, … (each a list of turn dicts)
        ``session_1_date_time``, ``session_2_date_time``, … (each a date string)

    Turns: ``{speaker: str, text: str, dia_id?: str}``

    Returns a list of session dicts in the common shape (idx, date, turns).
    """
    import re as _re
    conversation = item.get("conversation")
    if not isinstance(conversation, dict):
        return []

    # Collect session numbers present
    nums: list[int] = []
    for k in conversation.keys():
        m = _re.match(r"^session_(\d+)$", k)
        if m:
            nums.append(int(m.group(1)))
    nums.sort()

    sessions: list[dict] = []
    for n in nums:
        key = f"session_{n}"
        date_key = f"session_{n}_date_time"
        raw_turns = conversation.get(key)
        if not isinstance(raw_turns, list):
            continue
        date = conversation.get(date_key) or None

        # Normalise turns: real format has {speaker, text, dia_id?}
        turns: list[dict] = []
        for t in raw_turns:
            if isinstance(t, dict):
                speaker = t.get("speaker") or "unknown"
                text = t.get("text") or ""
                turn_id = t.get("dia_id") or t.get("turn_id") or None
            elif isinstance(t, str):
                speaker = "unknown"
                text = t
                turn_id = None
            else:
                continue
            turns.append({"speaker": str(speaker), "text": str(text), "turn_id": turn_id})

        sessions.append({
            "idx": n,
            "date": str(date) if date is not None else None,
            "turns": turns,
        })
    return sessions


def load_locomo(data_dir: str) -> list[dict]:
    """Load LoCoMo (locomo10.json) from *data_dir* into the common shape.

    Handles both the synthetic fixture format (list of dicts with a ``sessions``
    list key) and the REAL locomo10.json format (list of dicts where sessions
    are stored as flat ``session_N`` / ``session_N_date_time`` keys inside a
    ``conversation`` dict).

    Returns a list of 10 dialogue dicts, each conforming to the common schema.
    Sessions are sorted by idx; probes preserve source order.
    """
    raw = _load_json(data_dir, "locomo10.json")

    # locomo10.json may be a list or a dict with a top-level key
    if isinstance(raw, dict):
        # Try common wrapper keys
        for key in ("dialogues", "data", "conversations", "items"):
            if key in raw:
                raw = raw[key]
                break
        else:
            # Single-item dict — wrap in list
            raw = [raw]

    records: list[dict] = []
    for idx, item in enumerate(raw):
        # Real LoCoMo uses "sample_id" (e.g. "conv-26"); fixtures use "dialogue_id"/"conv_id"/"id".
        conv_id = str(
            item.get("dialogue_id") or item.get("conv_id") or item.get("id")
            or item.get("sample_id") or idx
        )

        # Sessions — try standard list key first, then the real LoCoMo flat-dict format.
        raw_sessions = item.get("sessions") or item.get("conversations") or []
        sessions: list[dict] = []
        if raw_sessions:
            # Synthetic fixture / standard shape: list of session dicts
            for s_idx, sess in enumerate(raw_sessions):
                if isinstance(sess, dict):
                    s_i = sess.get("session_id") or sess.get("idx") or s_idx
                    date = sess.get("date") or sess.get("timestamp") or None
                    raw_turns = (
                        sess.get("conversation")
                        or sess.get("turns")
                        or sess.get("messages")
                        or []
                    )
                else:
                    # Unexpected shape — skip
                    continue
                sessions.append({
                    "idx": int(s_i) if str(s_i).isdigit() else s_idx,
                    "date": str(date) if date is not None else None,
                    "turns": _norm_turns(raw_turns),
                })
        else:
            # Real LoCoMo format: sessions stored as flat keys in ``conversation`` dict
            sessions = _load_locomo_real_sessions(item)

        sessions.sort(key=lambda s: s["idx"])

        # QA probes
        raw_qa = item.get("qa") or item.get("qas") or item.get("questions") or []
        probes: list[dict] = []
        for q_idx, qa in enumerate(raw_qa):
            qid = str(qa.get("question_id") or qa.get("qid") or qa.get("id") or q_idx)
            question = str(qa.get("question") or "")
            answer = str(qa.get("answer") or "")
            category = str(qa.get("category") or "unknown")
            evidence = qa.get("evidence") or []
            if isinstance(evidence, (str, int)):
                evidence = [str(evidence)]
            elif isinstance(evidence, list):
                evidence = [str(e) for e in evidence]
            else:
                evidence = []
            probes.append({
                "qid": qid,
                "question": question,
                "answer": answer,
                "category": category,
                "evidence": evidence,
            })

        records.append({
            "conv_id": conv_id,
            "sessions": sessions,
            "probes": probes,
        })

    return records


# ---------------------------------------------------------------------------
# LongMemEval loader
# ---------------------------------------------------------------------------
# Source:  https://github.com/xiaowu0162/LongMemEval
# License: MIT — free use and redistribution with attribution.
# Data files are NOT committed; provide via --data-dir.
#
# Available files (pass which to load):
#   longmemeval_oracle.json  — gold oracle setting
#   longmemeval_s.json       — small haystack (S)
#   longmemeval_m.json       — medium haystack (M)
#
# Each file is a list of items with roughly this shape:
#   {
#     "question_id": str,
#     "question_type": str,
#     "question": str,
#     "answer": str | list,
#     "question_date": str,
#     "haystack_sessions": [
#         {
#             "session_id": str,
#             "date": str,
#             "content": [ {"role": str, "content": str}, ... ]
#         }
#     ],
#     "answer_session_ids": [str, ...]
#   }
#
# question_type values (passed through verbatim as category):
#   "single-session-user", "single-session-assistant",
#   "single-session-preference", "multi-session",
#   "knowledge-update", "temporal-reasoning"
#
# evidence = answer_session_ids (list of str session ids)
# ---------------------------------------------------------------------------

_LME_FILES = ("longmemeval_oracle.json", "longmemeval_s.json", "longmemeval_m.json")


def load_longmemeval(data_dir: str, variant: str = "oracle") -> list[dict]:
    """Load a LongMemEval variant from *data_dir* into the common shape.

    Args:
        data_dir: Directory containing the dataset files.
        variant:  One of "oracle", "s", or "m" (default "oracle").

    Returns a list of dicts, one per question item, each conforming to the common schema.
    conv_id is the question_id (each item has its own haystack).
    Sessions are sorted by idx; evidence = answer_session_ids.
    """
    name_map = {"oracle": "longmemeval_oracle.json", "s": "longmemeval_s.json", "m": "longmemeval_m.json"}
    if variant not in name_map:
        raise ValueError(f"Unknown LongMemEval variant {variant!r}; choose from: {list(name_map)}")
    filename = name_map[variant]
    raw = _load_json(data_dir, filename)

    # Top-level may be a dict wrapping a list
    if isinstance(raw, dict):
        for key in ("data", "items", "questions"):
            if key in raw:
                raw = raw[key]
                break

    records: list[dict] = []
    for idx, item in enumerate(raw):
        conv_id = str(item.get("question_id") or idx)

        # Sessions from haystack_sessions
        raw_sessions = item.get("haystack_sessions") or item.get("sessions") or []
        sessions: list[dict] = []
        for s_idx, sess in enumerate(raw_sessions):
            s_id = str(sess.get("session_id") or sess.get("id") or s_idx)
            date = sess.get("date") or sess.get("timestamp") or None
            raw_turns = (
                sess.get("content")
                or sess.get("turns")
                or sess.get("messages")
                or sess.get("conversation")
                or []
            )
            sessions.append({
                "idx": s_idx,
                "date": str(date) if date is not None else None,
                "turns": _norm_turns(raw_turns),
            })
        # LongMemEval sessions are already time-ordered; keep that order
        # (s_idx preserves insertion order above)

        # Single probe per item
        question_id = str(item.get("question_id") or idx)
        question = str(item.get("question") or "")
        answer = item.get("answer") or ""
        if isinstance(answer, list):
            answer = "; ".join(str(a) for a in answer)
        else:
            answer = str(answer)
        category = str(item.get("question_type") or "unknown")
        evidence = item.get("answer_session_ids") or []
        if isinstance(evidence, str):
            evidence = [evidence]
        elif isinstance(evidence, list):
            evidence = [str(e) for e in evidence]
        else:
            evidence = []

        records.append({
            "conv_id": conv_id,
            "sessions": sessions,
            "probes": [{
                "qid": question_id,
                "question": question,
                "answer": answer,
                "category": category,
                "evidence": evidence,
            }],
        })

    return records


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Load LoCoMo / LongMemEval datasets and print summary statistics."
    )
    parser.add_argument(
        "--data-dir",
        required=True,
        help="Directory containing dataset JSON files (locomo10.json, longmemeval_*.json).",
    )
    parser.add_argument(
        "--dataset",
        choices=["locomo", "longmemeval-oracle", "longmemeval-s", "longmemeval-m", "all"],
        default="all",
        help="Which dataset to load (default: all available).",
    )
    return parser.parse_args(argv)


def _summarise(label: str, records: list[dict]) -> None:
    n_sessions = sum(len(r["sessions"]) for r in records)
    n_probes = sum(len(r["probes"]) for r in records)
    print(f"{label}: {len(records)} convs, {n_sessions} sessions, {n_probes} probes")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    data_dir = args.data_dir
    dataset = args.dataset

    if dataset in ("locomo", "all"):
        try:
            records = load_locomo(data_dir)
            _summarise("LoCoMo", records)
        except FileNotFoundError as exc:
            if dataset == "locomo":
                print(f"ERROR: {exc}", file=sys.stderr)
                return 1
            print(f"[skip] LoCoMo: {exc}")

    for variant in ("oracle", "s", "m"):
        tag = f"longmemeval-{variant}"
        if dataset in (tag, "all"):
            try:
                records = load_longmemeval(data_dir, variant=variant)
                _summarise(f"LongMemEval-{variant}", records)
            except FileNotFoundError as exc:
                if dataset == tag:
                    print(f"ERROR: {exc}", file=sys.stderr)
                    return 1
                print(f"[skip] LongMemEval-{variant}: {exc}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
