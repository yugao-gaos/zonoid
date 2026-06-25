"""bench/agent-memory/distill.py — Phase-1 Distiller: session turns → atomic fact notes.

``distill_session(turns, session_date, ...)`` is the ONE new public API.

Design (docs/conversational-memory-design.md §5, Phase 1):
  - LLM-extract atomic facts from a session transcript via ``claude -p`` (tool-less).
  - Each fact is ONE note: self-contained, specific, relative-time resolved.
  - Written via the existing ``post_note`` path (``record_decision`` semantics).
  - ADDITIVE: zero changes to the daemon engine.  Raw-chunk ingest (ingest.py) still
    works; the distiller is a REPLACEMENT ingest path that is tried first.
  - Gold is never seen: the distiller reads ONLY the session transcript.

Fact contract:
  ATOMIC       — one subject-predicate-object claim per note.
  SPECIFIC     — keeps names, dates, numbers, proper nouns; not vague paraphrases.
  RESOLVED     — relative time (``yesterday``, ``last week``) is converted to an
                 absolute date against ``session_date`` in the fact text.
  SELF-CONTAINED — readable with no surrounding context.

stdlib only (subprocess/urllib) — runs on embeddable Python 3.12.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any

# ---------------------------------------------------------------------------
# Path bootstrap (mirrors ingest.py and arms.py)
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
for _p in (_HERE, _BENCH):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from zonoid_lifecycle import post_note, _http_post  # noqa: E402

# ---------------------------------------------------------------------------
# LLM helpers — reuse the same claude_p / parse logic as zonoid_bench.judge
# ---------------------------------------------------------------------------
# We duplicate the tiny claude_p wrapper here so distill.py has ZERO cross-package
# deps (bench/agent-memory is standalone; bench/zonoid_bench is a sibling package
# the script may or may not have on sys.path depending on the caller).

import shutil
import subprocess

_CLAUDE_CLI: str = os.environ.get("ZONOID_BENCH_CLAUDE") or shutil.which("claude") or "claude"
_JUDGE_MODEL: str = os.environ.get("ZONOID_BENCH_MODEL", "sonnet")
_CLAUDE_TIMEOUT: int = min(120, int(os.environ.get("ZONOID_BENCH_CLAUDE_TIMEOUT", "90")))

_HERE_MCP_OFF = os.path.join(_HERE, "mcp-off.json")
_BENCH_MCP_OFF = os.path.join(_BENCH, "mcp-off.json")
_MCP_OFF = _HERE_MCP_OFF if os.path.exists(_HERE_MCP_OFF) else _BENCH_MCP_OFF


def _claude_p(prompt: str, *, model: str | None = None, timeout: int | None = None) -> str | None:
    """Single-shot, tool-less ``claude -p`` via stdin.  Returns stdout or None on error."""
    cli = _CLAUDE_CLI
    mdl = model or _JUDGE_MODEL
    tmo = timeout if timeout is not None else _CLAUDE_TIMEOUT
    args: list[str] = [cli, "-p"]
    if os.path.exists(_MCP_OFF):
        args += ["--mcp-config", _MCP_OFF, "--strict-mcp-config"]
    args += ["--model", mdl, "--output-format", "text", "--allowedTools", ""]
    try:
        run = subprocess.run(
            args, input=prompt, capture_output=True, text=True,
            encoding="utf-8", timeout=tmo,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[distill] claude_p failed: {exc}", file=sys.stderr)
        return None
    if run.returncode != 0:
        print(f"[distill] claude_p exit={run.returncode}: {(run.stderr or run.stdout or '')[-300:]}", file=sys.stderr)
        return None
    return run.stdout or ""


# ---------------------------------------------------------------------------
# Distillation prompt
# ---------------------------------------------------------------------------

_DISTILL_PROMPT = """\
You are a fact-extraction assistant. Extract ATOMIC FACTS from the conversation session below.

Rules:
1. ONE claim per fact — one subject-predicate-object statement.
2. Be SPECIFIC: keep names, places, numbers, dates, proper nouns.
3. RESOLVE relative time against the session date "{session_date}":
   - "yesterday" → the actual calendar date one day before {session_date}
   - "last week" → the week before {session_date}
   - "today" → {session_date}
   - Emit absolute dates in the fact text.
4. Make each fact SELF-CONTAINED: readable with no surrounding context.
5. Only extract facts stated by the user (not the assistant's speculative responses).
6. Skip pleasantries, meta-commentary, generic advice — only concrete facts about the user.
7. If you find NO extractable facts, return an empty list.
8. For each fact, identify the PRIMARY entity it is about: choose a concise canonical name
   (e.g. "bread baking", "Alice Smith", "San Francisco") and its type: one of
   person | org | place | thing | concept.

Return ONLY a JSON array of objects with this shape:
[
  {{
    "title": "short fact title (5-10 words)",
    "fact": "full self-contained fact sentence",
    "entity_name": "canonical entity name this fact is about",
    "entity_type": "person|org|place|thing|concept"
  }},
  ...
]

Session date: {session_date}

CONVERSATION:
{transcript}

JSON array of facts:"""


# ---------------------------------------------------------------------------
# Core extraction
# ---------------------------------------------------------------------------

def _format_turns(turns: list[dict[str, Any]]) -> str:
    """Format turns as speaker-labeled lines (mirrors ingest._format_turns)."""
    lines = []
    for t in turns:
        speaker = (t.get("speaker") or "unknown").strip()
        text = (t.get("text") or "").strip()
        tid = t.get("turn_id")
        prefix = f"[{tid}] " if tid else ""
        lines.append(f"{prefix}{speaker}: {text}")
    return "\n".join(lines)


def _parse_facts(raw: str) -> list[dict[str, str]]:
    """Extract the JSON array from the raw LLM output.

    Handles three common output patterns:
      1. Pure JSON array  [...]
      2. Markdown-fenced  ```json\n[...]\n```
      3. Mixed prose + JSON  (scan for first '[' ... last ']')
    """
    if not raw:
        return []
    raw = raw.strip()

    # Pattern 1: markdown fence
    fence_m = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", raw, re.DOTALL)
    if fence_m:
        raw = fence_m.group(1)

    # Pattern 2: scan for first '[' ... matching ']'
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1 or end < start:
        return []
    blob = raw[start : end + 1]

    try:
        parsed = json.loads(blob)
    except json.JSONDecodeError:
        # Try stripping trailing commas (common LLM mistake)
        cleaned = re.sub(r",\s*([}\]])", r"\1", blob)
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            return []

    if not isinstance(parsed, list):
        return []

    facts = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        fact = str(item.get("fact") or "").strip()
        if fact:
            entry: dict[str, str] = {"title": title or fact[:60], "fact": fact}
            # Phase 2: entity fields (optional — backwards-compatible with old prompts that omit them).
            entity_name = str(item.get("entity_name") or "").strip()
            entity_type = str(item.get("entity_type") or "").strip().lower()
            if entity_name:
                entry["entity_name"] = entity_name
            if entity_type:
                entry["entity_type"] = entity_type
            facts.append(entry)
    return facts


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def distill_session(
    turns: list[dict[str, Any]],
    session_date: str | None,
    *,
    base_url: str = "http://localhost:8787",
    workspace: str,
    conv_id: str = "unknown",
    session_idx: int | str = 0,
    category: str = "distilled-fact",
    tags: list[str] | None = None,
    timeout: int = 30,
    model: str | None = None,
    verbose: bool = False,
) -> list[dict[str, str]]:
    """Distill one session's turns into atomic fact notes in the Zonoid workspace.

    Args:
        turns:        List of turn dicts {speaker, text, turn_id?}.
        session_date: The date of this session (used for relative-time resolution).
                      Pass None or "unknown" if unavailable.
        base_url:     Daemon URL.
        workspace:    ABSOLUTE path to the per-conversation Zonoid workspace dir.
        conv_id:      Conversation ID (for note tags).
        session_idx:  Session index (for note tags).
        category:     Note category (default "distilled-fact").
        tags:         Extra tags beyond [conv_id, session_date].
        timeout:      Per-note HTTP timeout in seconds.
        model:        LLM model override (default: ZONOID_BENCH_MODEL / "sonnet").
        verbose:      Print per-fact progress to stderr.

    Returns:
        List of note dicts: [{note_key, title, fact}, ...] for each fact written.
        Empty list if extraction produced no facts or the LLM call failed.
    """
    date_str = session_date or "unknown date"
    transcript = _format_turns(turns)

    if not transcript.strip():
        return []

    prompt = _DISTILL_PROMPT.format(
        session_date=date_str,
        transcript=transcript,
    )

    if verbose:
        print(
            f"[distill] session {session_idx} ({date_str}): extracting facts from "
            f"{len(turns)} turns ...",
            file=sys.stderr,
        )

    raw = _claude_p(prompt, model=model)
    if raw is None:
        if verbose:
            print(f"[distill] session {session_idx}: LLM call failed", file=sys.stderr)
        return []

    facts = _parse_facts(raw)
    if verbose:
        print(f"[distill] session {session_idx}: extracted {len(facts)} fact(s)", file=sys.stderr)

    base_tags = [str(conv_id), str(date_str)] + (tags or [])
    written: list[dict[str, str]] = []

    for fact in facts:
        title = fact["title"]
        fact_text = fact["fact"]
        # Prefix the session date so the answerer can ground relative-time references.
        summary = f"Session date: {date_str}\n{fact_text}"

        try:
            resp = post_note(
                base_url=base_url,
                workspace=workspace,
                title=title,
                summary=summary,
                category=category,
                tags=base_tags,
                timeout=timeout,
            )
            note_key = resp.get("key") or resp.get("note_key") or ""
            if verbose:
                print(f"  [{note_key}] {title!r}", file=sys.stderr)
            if note_key:
                written.append({"note_key": note_key, "title": title, "fact": fact_text})

                # Phase 2: entity wiring — upsert entity node + link fact note to it.
                entity_name = fact.get("entity_name", "").strip()
                entity_type = fact.get("entity_type", "concept").strip() or "concept"
                if entity_name and note_key:
                    try:
                        # Upsert the entity node (idempotent by name).
                        entity_resp = _http_post(
                            f"{base_url.rstrip('/')}/entity",
                            {"workspace": workspace, "name": entity_name, "type": entity_type},
                            timeout,
                        )
                        entity_id = entity_resp.get("id")
                        if entity_id:
                            entity_key = f"entity:{entity_id}"
                            # Wire: note → entity with relation "subject_of".
                            _http_post(
                                f"{base_url.rstrip('/')}/entity/link",
                                {
                                    "workspace": workspace,
                                    "from": note_key,
                                    "to": entity_key,
                                    "relation": "subject_of",
                                },
                                timeout,
                            )
                            if verbose:
                                print(
                                    f"    entity [{entity_key}] {entity_name!r} ({entity_type})",
                                    file=sys.stderr,
                                )
                    except Exception as ent_exc:  # noqa: BLE001
                        # Entity wiring is best-effort — never fail fact ingest because of it.
                        print(
                            f"[distill] session {session_idx} entity wiring failed: {ent_exc}",
                            file=sys.stderr,
                        )
        except Exception as exc:  # noqa: BLE001
            print(f"[distill] session {session_idx} fact write failed: {exc}", file=sys.stderr)

    return written


# ---------------------------------------------------------------------------
# Distilling a full conversation
# ---------------------------------------------------------------------------

def distill_conversation(
    conv: dict[str, Any],
    *,
    base_url: str = "http://localhost:8787",
    workspace: str,
    category: str = "distilled-fact",
    tags: list[str] | None = None,
    timeout: int = 30,
    model: str | None = None,
    verbose: bool = True,
) -> dict[str, list[dict[str, str]]]:
    """Distill every session of *conv* (common-shape dict) into atomic fact notes.

    Returns a dict mapping session idx (str) to the list of note dicts written.
    """
    conv_id = str(conv.get("conv_id") or "unknown")
    sessions = conv.get("sessions") or []
    result: dict[str, list[dict[str, str]]] = {}

    for sess in sessions:
        idx = sess.get("idx", 0)
        date = sess.get("date")
        turns = sess.get("turns") or []
        notes = distill_session(
            turns, date,
            base_url=base_url,
            workspace=workspace,
            conv_id=conv_id,
            session_idx=idx,
            category=category,
            tags=tags,
            timeout=timeout,
            model=model,
            verbose=verbose,
        )
        result[str(idx)] = notes

    return result


# ---------------------------------------------------------------------------
# ConversationDistiller — same interface as ConversationIngester
# ---------------------------------------------------------------------------

class ConversationDistiller:
    """Distill one conversation (common-shape dict) into Zonoid as atomic fact notes.

    Drop-in replacement for ``ConversationIngester`` in the bench harness: same
    constructor signature, same ``workspace_for(conv_id)`` method, same return
    shape from ``ingest(conv)``.

    The difference: instead of writing one note per session (raw turn-text),
    we call ``distill_session`` per session and write one note per atomic fact.
    The ``ingest_map`` returned maps ``session_idx(str) → [{"note_key", "title"}, …]``
    exactly as the ingester does — so ``_build_session_candidates`` in
    ``probe_runner.py`` and ``run.py`` consume it unchanged.

    Args:
        base_url:       Daemon URL (default http://localhost:8787).
        workspace_root: Parent directory under which per-conversation workspace
                        dirs are created (absolute path required by daemon).
        timeout:        Per-HTTP-call timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8787",
        workspace_root: str | None = None,
        timeout: int = 120,
    ) -> None:
        import tempfile
        self.base_url = base_url.rstrip("/")
        if workspace_root is None:
            workspace_root = os.path.join(tempfile.gettempdir(), "zonoid-agent-memory-distill")
        self.workspace_root = os.path.abspath(workspace_root)
        self.timeout = timeout

    def workspace_for(self, conv_id: str) -> str:
        """Return the absolute workspace path for *conv_id* (created on demand)."""
        slug = re.sub(r"[^A-Za-z0-9._-]+", "-", conv_id).strip("-") or "conv"
        ws = os.path.join(self.workspace_root, slug)
        os.makedirs(ws, exist_ok=True)
        return ws

    def ingest(self, conv: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
        """Distill all sessions of *conv* into atomic fact notes.

        Returns the same shape as ``ConversationIngester.ingest``:
          {"<session_idx>": [{"note_key": "note:<id>", "title": "<fact>"}, …], …}

        A session that produces no facts is silently omitted from the result dict.
        """
        conv_id = str(conv.get("conv_id") or "unknown")
        workspace = self.workspace_for(conv_id)

        result: dict[str, list[dict[str, str]]] = {}
        errors: list[str] = []

        for sess in (conv.get("sessions") or []):
            sess_idx = sess.get("idx", 0)
            date = sess.get("date")
            turns = sess.get("turns") or []

            try:
                notes = distill_session(
                    turns,
                    date,
                    base_url=self.base_url,
                    workspace=workspace,
                    conv_id=conv_id,
                    session_idx=sess_idx,
                    timeout=self.timeout,
                    verbose=True,
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(f"session {sess_idx}: distillation failed: {exc}")
                continue

            if notes:
                result[str(sess_idx)] = notes

        if errors:
            print(
                f"[distill] {len(errors)} session error(s) for conv {conv_id!r}:",
                file=sys.stderr,
            )
            for e in errors:
                print(f"  - {e}", file=sys.stderr)

        return result


# ---------------------------------------------------------------------------
# CLI smoke / verify
# ---------------------------------------------------------------------------

def _smoke(base_url: str = "http://localhost:8787") -> int:
    """Quick verify: distill a two-turn synthetic session and assert a fact note appears."""
    import tempfile

    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass

    turns = [
        {"speaker": "user", "text": "I commute 45 minutes each way to my office in downtown."},
        {"speaker": "assistant", "text": "That's quite a commute! About 1.5 hours daily."},
        {"speaker": "user", "text": "Yes, I've been doing it since I started this job last week."},
    ]
    session_date = "2023-05-22"
    ws = tempfile.mkdtemp(prefix="distill-smoke-")
    print(f"[distill.smoke] workspace={ws}")

    from zonoid_lifecycle import warm_up, search as _search
    try:
        warm_up(base_url, timeout=60)
        print("[distill.smoke] daemon warm-up OK")
    except Exception as exc:
        print(f"[distill.smoke] FAIL warm-up: {exc}")
        return 1

    notes = distill_session(
        turns, session_date,
        base_url=base_url, workspace=ws,
        conv_id="smoke-conv", session_idx=1,
        verbose=True,
    )
    print(f"[distill.smoke] extracted {len(notes)} fact note(s):")
    for n in notes:
        print(f"  {n['note_key']}: {n['title']!r}")

    if not notes:
        print("[distill.smoke] FAIL: no notes produced")
        return 1

    time.sleep(2)
    hits = _search(base_url=base_url, workspace=ws, query="daily commute minutes", k=5, gated=False, timeout=30)
    found = any("45" in str(h.get("summary", "")) for h in hits)
    print(f"[distill.smoke] /search for '45 minutes commute': found={found} (hits={len(hits)})")
    if not found:
        for h in hits:
            print(f"  score={h.get('score'):.3f} summary={str(h.get('summary',''))[:100]!r}")
        print("[distill.smoke] FAIL: fact not retrievable")
        return 1

    print("[distill.smoke] PASS")
    return 0


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Phase-1 distiller smoke")
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--daemon", default="http://localhost:8787")
    a = p.parse_args()
    if a.smoke:
        sys.exit(_smoke(a.daemon))
    p.print_help()
    sys.exit(0)
