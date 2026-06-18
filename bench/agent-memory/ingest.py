"""Conversation ingester for the agent-memory benchmark harness.

``ConversationIngester`` takes one conversation in the common shape emitted
by ``datasets.py`` and loads each session as a Zonoid note into an isolated,
absolute-path workspace directory.

Common shape (from datasets.py):
    {
        "conv_id":  str,
        "sessions": [
            {"idx": int, "date": str | None,
             "turns": [{"speaker": str, "text": str, "turn_id": str | None}]}
        ],
        "probes": [...],   # not used during ingestion
    }

What the ingester does
----------------------
For each session:
  1. Format turns as speaker-labeled, turn-id-prefixed lines (see _format_turns).
  2. If the formatted text fits within NOTE_BUDGET chars, write ONE note:
       title   = "<conv_id> session <idx> (<date>)"
       summary = formatted turns (≤ NOTE_BUDGET)
       category= "conversation-session"
       tags    = [conv_id, session_date]
     with NO ``force`` so the daemon's autowire + dup-guard pipeline runs.
  3. If the session overflows NOTE_BUDGET, split into .part1 / .part2 / …
     notes, each ≤ NOTE_BUDGET, titled "<base_title>.part<n>".
  4. Collect and return the list of ``{"note_key": …, "title": …}`` dicts per
     session (one entry per note written, including .partN).

Workspace isolation
-------------------
Each conversation gets its own workspace directory:
    <workspace_root>/<conv_id_slug>/
This path is ABSOLUTE (requirement: the daemon does path.join(ws, '.graph')
and a relative path silently fails to persist).

HTTP
----
All daemon calls are made via ``zonoid_lifecycle`` (stdlib urllib.request; NO
requests library — embeddable Python has no pip / site-packages).

Note budget
-----------
NOTE_BUDGET = 6000 chars (conservative ceiling for a single note summary).
This keeps notes scannable in the DAG and well within the daemon's expected
summary size. Sessions with >6000 chars of formatted turns are split across
.partN sibling notes.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from typing import Any

# Embeddable Python 3.12 (py312embed) strips cwd from sys.path. Insert the
# directory containing this script so that sibling modules (zonoid_lifecycle,
# datasets) are always importable regardless of the working directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from zonoid_lifecycle import post_note, search, warm_up  # noqa: E402

# Maximum chars for a single note's summary field.
NOTE_BUDGET: int = 6_000

# Chars per turn line reserved for speaker label + turn_id prefix.
# e.g. "[t12] user: …"
_PREFIX_OVERHEAD: int = 40


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slugify(s: str) -> str:
    """Turn *s* into a filesystem-safe slug (ASCII alnum + hyphens)."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-") or "conv"


def _format_turns(turns: list[dict[str, Any]]) -> str:
    """Format a turn list as speaker-labeled, turn-id-prefixed lines.

    Output shape:
        [t1] user: I just started learning to bake bread.
        [t2] assistant: That's great! Sourdough or yeast-based?
        …

    If a turn has no turn_id, the bracket prefix is omitted.
    """
    lines = []
    for t in turns:
        speaker = (t.get("speaker") or "unknown").strip()
        text = (t.get("text") or "").strip()
        tid = t.get("turn_id")
        prefix = f"[{tid}] " if tid else ""
        lines.append(f"{prefix}{speaker}: {text}")
    return "\n".join(lines)


def _split_into_parts(text: str, budget: int) -> list[str]:
    """Split *text* into chunks of at most *budget* chars, breaking on newlines.

    Each chunk is as full as possible without exceeding *budget*.
    """
    if len(text) <= budget:
        return [text]
    parts: list[str] = []
    lines = text.split("\n")
    current_lines: list[str] = []
    current_len = 0
    for line in lines:
        # +1 for the newline we stripped
        needed = len(line) + (1 if current_lines else 0)
        if current_lines and current_len + needed > budget:
            parts.append("\n".join(current_lines))
            current_lines = [line]
            current_len = len(line)
        else:
            current_lines.append(line)
            current_len += needed
    if current_lines:
        parts.append("\n".join(current_lines))
    return parts


# ---------------------------------------------------------------------------
# Ingester
# ---------------------------------------------------------------------------

class ConversationIngester:
    """Ingest one conversation (common-shape dict) into Zonoid as session notes.

    Args:
        base_url:       Daemon URL (default http://localhost:8787).
        workspace_root: Parent directory under which per-conversation workspace
                        dirs are created.  Each conversation gets an isolated
                        absolute-path subdirectory.
        timeout:        Per-HTTP-call timeout in seconds.
        note_budget:    Max chars per note summary (overflow → .partN splits).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8787",
        workspace_root: str | None = None,
        timeout: int = 120,
        note_budget: int = NOTE_BUDGET,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        # Default workspace root: a subdir of temp so it's always absolute.
        if workspace_root is None:
            workspace_root = os.path.join(tempfile.gettempdir(), "zonoid-agent-memory")
        self.workspace_root = os.path.abspath(workspace_root)
        self.timeout = timeout
        self.note_budget = note_budget

    # -- public API ----------------------------------------------------------

    def workspace_for(self, conv_id: str) -> str:
        """Return the absolute workspace path for *conv_id* (created on demand)."""
        slug = _slugify(conv_id)
        ws = os.path.join(self.workspace_root, slug)
        os.makedirs(ws, exist_ok=True)
        return ws

    def ingest(self, conv: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
        """Ingest all sessions of *conv* into an isolated Zonoid workspace.

        Args:
            conv: A conversation dict in the common shape from ``datasets.py``.

        Returns:
            A dict mapping session index (str) to a list of note dicts written
            for that session:
              {
                "<session_idx>": [
                    {"note_key": "note:<id>", "title": "…"},
                    …   # more entries if .partN splits occurred
                ],
                …
              }

        Raises:
            RuntimeError: If the daemon is unreachable on the FIRST note write.
            (Subsequent per-session failures are collected and re-raised at the
            end so as many sessions as possible are ingested.)
        """
        conv_id = str(conv.get("conv_id") or "unknown")
        sessions = conv.get("sessions") or []
        workspace = self.workspace_for(conv_id)

        result: dict[str, list[dict[str, str]]] = {}
        errors: list[str] = []
        first_call = True

        for sess in sessions:
            sess_idx = sess.get("idx")
            date = sess.get("date") or "unknown-date"
            turns = sess.get("turns") or []
            base_title = f"{conv_id} session {sess_idx} ({date})"
            tags = [conv_id, str(date)]

            formatted = _format_turns(turns)
            parts = _split_into_parts(formatted, self.note_budget)

            date_prefix = f"Session date: {date}\n"
            session_notes: list[dict[str, str]] = []
            date_prefix = f"Session date: {date}\n"
            for part_idx, part_text in enumerate(parts):
                if len(parts) > 1:
                    title = f"{base_title}.part{part_idx + 1}"
                    summary = (
                        f"{date_prefix}[part {part_idx + 1} of {len(parts)}]\n{part_text}"
                    )
                else:
                    title = base_title
                    summary = f"{date_prefix}{part_text}"

                try:
                    resp = post_note(
                        base_url=self.base_url,
                        workspace=workspace,
                        title=title,
                        summary=summary,
                        category="conversation-session",
                        tags=tags,
                        timeout=self.timeout,
                    )
                    note_key = resp.get("key") or resp.get("note_key") or ""
                    if not note_key:
                        errors.append(
                            f"session {sess_idx} part {part_idx + 1}: "
                            f"daemon returned no note key (resp={resp!r})"
                        )
                        continue
                    session_notes.append({"note_key": note_key, "title": title})
                    first_call = False
                except Exception as exc:
                    msg = (
                        f"session {sess_idx} part {part_idx + 1}: "
                        f"POST /overlay/note failed: {exc}"
                    )
                    if first_call:
                        raise RuntimeError(
                            f"Daemon unreachable or first write failed: {exc}"
                        ) from exc
                    errors.append(msg)

            if session_notes:
                result[str(sess_idx)] = session_notes

        if errors:
            raise RuntimeError(
                f"Ingestion completed with {len(errors)} error(s):\n"
                + "\n".join(f"  - {e}" for e in errors)
            )

        return result


# ---------------------------------------------------------------------------
# Smoke-test / verify entry point
# ---------------------------------------------------------------------------
# Run with the embeddable Python full path:
#   C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/agent-memory/ingest.py
#
# Loads the LoCoMo fixture, ingests the first conversation into a temp
# workspace, asserts each session became a note, and that /search can find a
# planted token from session 0.

def _verify(daemon: str = "http://localhost:8787") -> int:
    """End-to-end verify against the live daemon.

    Returns 0 on PASS, 1 on FAIL.
    """
    import urllib.error

    fixture_dir = os.path.join(_HERE, "fixtures")
    # datasets.py is a sibling module; _HERE is already on sys.path (module top).
    from datasets import load_locomo

    print(f"[verify] loading LoCoMo fixture from {fixture_dir}")
    try:
        records = load_locomo(fixture_dir)
    except FileNotFoundError as exc:
        print(f"FAIL: {exc}")
        return 1

    if not records:
        print("FAIL: fixture loaded but no records found")
        return 1

    conv = records[0]
    conv_id = conv["conv_id"]
    print(f"[verify] ingesting conv_id={conv_id!r} ({len(conv['sessions'])} sessions)")

    # Warm up the embedding model first.
    print("[verify] warming up embedder (may take up to 90s on cold start)…")
    try:
        warm_up(daemon, timeout=120)
    except Exception as exc:
        print(f"FAIL: daemon unreachable during warm-up: {exc}")
        return 1
    print("[verify] warm-up OK")

    # Use a temp workspace so the test is isolated and repeatable.
    ws_root = tempfile.mkdtemp(prefix="zonoid-ingest-verify-")
    ingester = ConversationIngester(
        base_url=daemon,
        workspace_root=ws_root,
        timeout=120,
    )
    workspace = ingester.workspace_for(conv_id)

    try:
        result = ingester.ingest(conv)
    except RuntimeError as exc:
        print(f"FAIL: {exc}")
        return 1

    # Assert every session produced at least one note key.
    ok = True
    for sess in conv["sessions"]:
        s_idx = str(sess["idx"])
        notes = result.get(s_idx, [])
        if not notes:
            print(f"FAIL: session {s_idx} produced no notes")
            ok = False
            continue
        for n in notes:
            key = n.get("note_key", "")
            if not key.startswith("note:"):
                print(f"FAIL: session {s_idx} returned unexpected key {key!r}")
                ok = False
            else:
                print(f"  session {s_idx}: {key!r} ({n['title']!r})")

    if not ok:
        return 1

    # Plant a unique token from session 0 and assert /search finds it.
    # "focaccia" is in session 0 turn t3 — specific enough to be distinctive.
    planted_token = "focaccia"
    print(f"\n[verify] searching for planted token {planted_token!r} in workspace…")
    hits = search(
        base_url=daemon,
        workspace=workspace,
        query=planted_token,
        k=5,
        gated=False,
        timeout=120,
    )
    found = any(
        planted_token.lower() in (h.get("title", "") + h.get("summary", "")).lower()
        for h in hits
    )
    if not found:
        # Show what we got so it's diagnosable.
        print(f"  /search returned {len(hits)} hits; none contained {planted_token!r}")
        for h in hits:
            print(f"    key={h.get('key')} title={h.get('title')!r} score={h.get('score')}")
        print("FAIL: search did not find planted token")
        return 1

    print(f"  found {planted_token!r} in {len(hits)} hit(s) — OK")
    print("\nPASS")
    return 0


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Ingest conversations into Zonoid (or run end-to-end verify)."
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run the smoke-test end-to-end verify against the live daemon.",
    )
    parser.add_argument(
        "--daemon",
        default="http://localhost:8787",
        help="Daemon base URL (default: http://localhost:8787).",
    )
    args = parser.parse_args()

    if args.verify:
        sys.exit(_verify(args.daemon))
    else:
        print("Usage: python ingest.py --verify [--daemon <url>]")
        sys.exit(0)
