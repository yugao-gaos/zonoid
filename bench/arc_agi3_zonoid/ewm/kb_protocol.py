"""KB protocol for the ARC-AGI-3 executable-world-model (EWM) agent.

Pillar 5 of the EWM design: the within-game program + test suite are the agent's short-term
memory; the KB (Zonoid daemon) is the version store + cross-game transfer layer. This module is
the thin, mode-aware seam an EWM agent uses to talk to the daemon over HTTP.

Two policies live here on top of a small stdlib HTTP client (`KbClient`):

* SEARCH is mode-scoped (`search_for_mode`). The agent's decision mode selects which KB query — if
  any — to run. PLAN/EXECUTE never touch the KB (they run against the local program/suite), so they
  return [] without any network call.
* WRITES only happen at acceptance events (`WriteGate` + `write_*` helpers): a program revision, a
  level solution, a cross-game mechanic pattern, a modelability verdict, or a failed-repair note.
  Writes are capped per decision turn and reject raw grid dumps in note bodies.

A KB outage must never crash gameplay, so — like the existing adapter in this package — every HTTP
call swallows network errors into a logged ``{"ok": False, "error": ...}`` result.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib import error, parse, request


logger = logging.getLogger(__name__)


# Decision modes the EWM agent moves through. Only the first four ever read the KB.
SEARCH_MODES: tuple[str, ...] = ("ORIENT", "SYNTHESIZE", "REPAIR", "RECOVER")
NO_SEARCH_MODES: tuple[str, ...] = ("PLAN", "EXECUTE")

# A cross-game hypothesis menu is NEVER stated as fact. Every menu the agent reads carries this
# preamble so a new game is never told "this is how it works" — only "these are guesses to test".
HYPOTHESIS_MENU_PREAMBLE: str = (
    "hypothesis menu — test before trusting; this game may match none of these"
)


# --------------------------------------------------------------------------------------------------
# Program-note chunking
# --------------------------------------------------------------------------------------------------
#
# The daemon mangles a note body at THREE points, and retrieval only round-trips a body that survives
# ALL of them:
#   * WRITE clip:  /overlay/note clips the stored `summary` to 2000 chars.
#   * READ cap:    /search with full_content=1 attaches a `content` field clipped to 1200 chars; the
#                  plain display `summary` is only 200 chars.
#   * SOURCE-CLUSTER REWRITE (the killer): lib/note-source-cluster.js `shouldClusterNote` REPLACES a
#                  note's stored summary with a compacted stub ("[Long raw evidence preserved as
#                  structured source chunks.]") whenever the body is >= 2400 chars OR (>= 1000 chars
#                  AND looks like source — backticks/`def `/`if (`/`;` etc.). A program chunk ALWAYS
#                  looks like source, so any chunk body >= SOURCE_LIKE_CHARS (1000) is silently gutted
#                  and its `content` returns the stub, NOT the code. This is the deeper reason run 12
#                  broke: the 3272-char program note was code-like and >= 1000, so it was clustered
#                  and its recallable body became a stub. Chunking only helps if EACH chunk stays
#                  UNDER 1000 chars so the source-cluster rewrite never fires.
# So the binding limit is min(write 2000, read 1200, source-cluster 1000) MINUS one, applied to the
# WHOLE chunk body (header + source slice). We use 999.
CHUNK_BODY_LIMIT: int = 999
# Header lines each chunk body carries before its source slice: a "chunk n of N" line the reassembler
# reads to order chunks, and a "len:" line the reassembler uses to verify the total byte length. We
# budget a fixed reserve for these so `source_per_chunk` leaves headroom no matter how big N gets.
_CHUNK_HEADER_RESERVE: int = 80
# Source bytes per chunk = the body limit minus the header reserve. Kept as a module constant so the
# writer, the reassembler, and the tests all agree on the split arithmetic.
SOURCE_PER_CHUNK: int = CHUNK_BODY_LIMIT - _CHUNK_HEADER_RESERVE

# Markers the chunk reassembler parses out of a chunk body. Kept standalone-token so they never fuse.
_CHUNK_HEADER_RE = re.compile(r"^chunk\s+(\d+)\s+of\s+(\d+)\b", re.IGNORECASE | re.MULTILINE)
# Index-note fields (written into the index-note body, parsed by ORIENT to drive reassembly).
_INDEX_CHUNKS_RE = re.compile(r"^chunk count:\s*(\d+)\s*$", re.IGNORECASE | re.MULTILINE)
_INDEX_LENGTH_RE = re.compile(r"^source length:\s*(\d+)\s*$", re.IGNORECASE | re.MULTILINE)


def program_chunk_title(game_id: str, n: int, total: int) -> str:
    """Exact title for chunk ``n`` of ``total`` of ``game_id``'s world-model program.

    DELIBERATELY omits the "world model" phrase the INDEX note carries: ``game ls20 program chunk 1
    of 4``, not ``game ls20 world model program chunk 1 of 4``. The ORIENT keyed lookup queries
    ``game <id> world model program`` — if chunk titles were supersets of that phrase they would each
    match (and outscore) the index note on that query and crowd it out of any reasonable top-k (they
    share all its tokens plus more). Dropping "world model" means the ORIENT query token set is NOT a
    subset of a chunk title, so chunks neither match the index token-superset filter nor bury the
    index in the ranking; ORIENT resolves the index cleanly, then fetches each chunk by its own exact
    title. Standalone-token so each chunk title round-trips verbatim.
    """

    return _title("game", game_id, "program chunk", n, "of", total)


def chunk_program_source(source: str, *, source_per_chunk: int = SOURCE_PER_CHUNK) -> list[str]:
    """Split ``source`` into ordered slices, each at most ``source_per_chunk`` BYTES.

    Byte-based (UTF-8) so the reassembled length check is exact. The ceiling program is pure ASCII, so
    a char split would suffice, but slicing on the encoded bytes keeps the invariant honest for any
    non-ASCII source. A slice never splits a multi-byte UTF-8 sequence: we advance byte offsets that
    land on a codepoint boundary (the decode below would raise otherwise).
    """

    if source_per_chunk <= 0:
        raise ValueError("source_per_chunk must be positive")
    raw = source.encode("utf-8")
    slices: list[str] = []
    pos = 0
    while pos < len(raw):
        end = min(pos + source_per_chunk, len(raw))
        # Back off `end` so it never lands in the middle of a multi-byte codepoint.
        while end < len(raw) and (raw[end] & 0xC0) == 0x80:
            end -= 1
        slices.append(raw[pos:end].decode("utf-8"))
        pos = end
    return slices or [""]


def reassemble_chunks(
    chunk_bodies: list[str],
    *,
    expected_count: int,
    expected_length: int,
) -> str | None:
    """Reassemble ordered program source from chunk NOTE BODIES, or ``None`` on any corruption.

    Each body is ``chunk n of N\\n<source slice>``. We parse the ``chunk n of N`` header off every
    body, order by ``n``, require exactly ``expected_count`` distinct chunks numbered 1..N with the
    header's N matching, concatenate their source payloads, and verify the reassembled UTF-8 byte
    length equals ``expected_length``. Any missing/duplicate/out-of-range chunk, header mismatch, or
    length mismatch returns ``None`` — the caller treats that as a clean refusal, never a partial
    reassembly.
    """

    if expected_count <= 0:
        return None
    by_index: dict[int, str] = {}
    for body in chunk_bodies:
        if not isinstance(body, str):
            continue
        m = _CHUNK_HEADER_RE.search(body)
        if not m:
            continue
        n = int(m.group(1))
        total = int(m.group(2))
        if total != expected_count or not (1 <= n <= expected_count) or n in by_index:
            # Wrong N, out-of-range index, or a duplicate chunk: refuse rather than guess.
            if total != expected_count or n in by_index:
                return None
            continue
        # Source payload = everything AFTER the header line.
        payload = body[m.end():]
        payload = payload[1:] if payload.startswith("\n") else payload
        by_index[n] = payload
    if len(by_index) != expected_count:
        return None
    source = "".join(by_index[i] for i in range(1, expected_count + 1))
    if len(source.encode("utf-8")) != expected_length:
        return None
    return source


class KbClient:
    """Minimal stdlib HTTP client for the Zonoid daemon KB.

    Wraps the two daemon endpoints the EWM protocol needs — ``GET /search`` and
    ``POST /overlay/note`` — pinning ``workspace``/``task_key`` on every call. Network failures are
    swallowed into a logged ``{"ok": False, "error": <repr>}`` so a KB outage degrades gameplay to
    "no memory" instead of crashing it.
    """

    def __init__(self, daemon_url: str, workspace: str, task_key: str, timeout_s: int = 20) -> None:
        self.daemon_url = daemon_url.rstrip("/")
        self.workspace = workspace
        self.task_key = task_key
        self.timeout_s = timeout_s

    def search(
        self, q: str, k: int, gated: bool = False, full_content: bool = False
    ) -> list[dict[str, Any]]:
        """GET {daemon_url}/search — return the parsed result list (empty on any failure).

        ``full_content=True`` asks the daemon to attach a fuller ``content`` field (up to the
        agentic-delivery budget, currently 1200 chars) to each hit instead of only the lean 200-char
        display ``summary``. Chunked-program retrieval MUST set this: a chunk body is stored whole but
        the plain ``summary`` is clipped to 200 chars, so only the ``content`` field round-trips a
        chunk large enough to matter (this is exactly what run 12 missed — it read the clipped summary).
        """

        params = {
            "workspace": self.workspace,
            "task_key": self.task_key,
            "q": q,
            "k": k,
            "gated": "true" if gated else "false",
        }
        if full_content:
            params["full_content"] = "1"
        query = parse.urlencode(params)
        url = f"{self.daemon_url}/search?{query}"
        try:
            req = request.Request(url, method="GET")
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:  # noqa: BLE001
            logger.warning("KB search failed for %r: %r", q, exc)
            return []
        return _extract_results(payload)

    def get_note_full(self, key: str) -> dict[str, Any]:
        """GET {daemon_url}/note/get?key&workspace&full=1 — the daemon's NATIVE full-body note read.

        The daemon reassembles a long/code-like note's FULL untruncated body from its stored
        source-chunk cluster (lib/note-full-body.js) in one call, so a stored program round-trips
        without the harness fetching + reassembling chunk notes by title itself. Returns the parsed
        response dict — ``{"ok": True, "key", "title", "summary", "full_body", "chunk_count",
        "byte_length"}`` on success, or a logged ``{"ok": False, "error"/"reason": ...}`` on any
        network/parse failure or a daemon-reported miss (so a KB outage degrades to "no memory").

        ``full=1`` is passed for forward-compatibility; the current endpoint always returns the full
        body and ignores the flag.
        """

        params = {"workspace": self.workspace, "key": key, "full": "1"}
        query = parse.urlencode(params)
        url = f"{self.daemon_url}/note/get?{query}"
        try:
            req = request.Request(url, method="GET")
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as exc:  # 404 unknown-note etc. — a clean miss, not a crash
            logger.warning("KB note/get failed for %r: HTTP %s", key, exc.code)
            return {"ok": False, "error": f"http {exc.code}"}
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:  # noqa: BLE001
            logger.warning("KB note/get failed for %r: %r", key, exc)
            return {"ok": False, "error": repr(exc)}
        if not isinstance(payload, dict):
            return {"ok": False, "error": "unexpected note/get payload"}
        return payload

    def note(
        self,
        title: str,
        summary: str,
        category: str = "arc-agi-3",
        supersedes: str | None = None,
    ) -> dict[str, Any]:
        """POST {daemon_url}/overlay/note — return the response dict (or a logged error dict)."""

        body: dict[str, Any] = {
            "workspace": self.workspace,
            "title": title,
            "summary": summary,
            "category": category,
            "wires_to": [self.task_key],
        }
        if supersedes:
            body["supersedes"] = supersedes

        data = json.dumps(body).encode("utf-8")
        url = f"{self.daemon_url}/overlay/note"
        try:
            req = request.Request(
                url,
                data=data,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:  # noqa: BLE001
            logger.warning("KB note write failed for %r: %r", title, exc)
            return {"ok": False, "error": repr(exc)}


def _extract_results(payload: Any) -> list[dict[str, Any]]:
    """Coerce a /search response into a plain result list.

    The daemon may return a bare list or a dict wrapping a 'results'/'hits'/'notes' list.
    """

    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("results", "hits", "notes", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


# --------------------------------------------------------------------------------------------------
# Mode-scoped search policy
# --------------------------------------------------------------------------------------------------


def _tokens(*parts: Any) -> list[str]:
    """Split assorted inputs into standalone lowercase word tokens (no camelCase/hyphen fusion)."""

    out: list[str] = []
    for part in parts:
        if part is None:
            continue
        if isinstance(part, (list, tuple, set)):
            for sub in part:
                out.extend(_tokens(sub))
            continue
        text = str(part)
        # break camelCase / hyphen / underscore / punctuation into separate words
        text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
        for word in re.split(r"[^0-9A-Za-z]+", text):
            if word:
                out.append(word.lower())
    return out


def _dedupe(words: list[str]) -> list[str]:
    """Order-preserving dedupe so query strings stay compact."""

    seen: set[str] = set()
    out: list[str] = []
    for word in words:
        if word not in seen:
            seen.add(word)
            out.append(word)
    return out


def _note_text(note: dict[str, Any]) -> str:
    """Concatenate a note's title + body text for cue-word overlap scoring."""

    return " ".join(
        str(note.get(key, ""))
        for key in ("title", "summary", "body", "prose", "dynamics")
    )


def _is_game_scoped(note: dict[str, Any], game_id: str) -> bool:
    """A game-scoped FACT is keyed by the game id in its title (``game <id> ...``)."""

    gid = " ".join(_tokens(game_id))
    return gid in " ".join(_tokens(note.get("title", "")))


def _search_full_content(client: Any, q: str, k: int) -> list[dict[str, Any]]:
    """``client.search(q, k, full_content=True)``, degrading gracefully for a client whose ``search``
    predates the ``full_content`` kwarg (older fakes/adapters) by retrying without it."""

    try:
        return client.search(q, k=k, gated=False, full_content=True)
    except TypeError:
        return client.search(q, k=k, gated=False)


def _is_chunk_note(note: dict[str, Any]) -> bool:
    """A program CHUNK note carries the ``chunk`` token in its title (``... program chunk n of N``);
    the INDEX note does not. ORIENT keys on the index, so chunk notes are filtered out of the keyed
    lookup even though they share the program query tokens."""

    return "chunk" in _tokens(note.get("title", ""))


def _is_cluster_artifact(note: dict[str, Any]) -> bool:
    """A source-cluster artifact node emitted by the daemon's long-note splitter — a
    ``knowledge:source_doc/section/chunk`` key or an "evidence" title. These inherit the program's
    title tokens but carry only a stub body, so ORIENT must never mistake one for the index note."""

    key = str(note.get("key", "")).lower()
    if key.startswith("knowledge:source_"):
        return True
    return "evidence" in _tokens(note.get("title", ""))


def hypothesis_menu(
    game_id: str,
    vocabulary: list[str],
    *,
    k: int = 5,
    client: KbClient | None = None,
) -> dict[str, Any]:
    """Build a ranked cross-game hypothesis MENU for a game, never a set of facts.

    Searches the cross-game mechanism-hypothesis notes, ranks them by cue-word overlap with
    ``vocabulary`` (the game's segmentation words), keeps the top ``k``, and returns them together
    with a formatted block that ALWAYS opens with :data:`HYPOTHESIS_MENU_PREAMBLE`. The preamble is
    what keeps the menu honest: a new game is handed guesses to test, not rules to trust.
    """

    if client is None:
        raise ValueError("hypothesis_menu requires a KbClient (pass client=...)")

    vocab_tokens = set(_tokens(vocabulary))
    q = " ".join(_dedupe(["mechanism", "hypothesis", *sorted(vocab_tokens)]))
    # Pull a wider candidate pool than k so overlap ranking has something to sort.
    hits = client.search(q, k=max(k * 2, k), gated=False)

    def _overlap(note: dict[str, Any]) -> int:
        return len(vocab_tokens & set(_tokens(_note_text(note))))

    ranked = sorted(hits, key=_overlap, reverse=True)[:k]

    lines = [HYPOTHESIS_MENU_PREAMBLE, ""]
    for note in ranked:
        title = str(note.get("title", "")).strip()
        body = str(note.get("summary", note.get("body", ""))).strip()
        lines.append(f"- {title}: {body}" if body else f"- {title}")
    formatted = "\n".join(lines)

    return {
        "hypothesis_menu": True,
        "game_id": game_id,
        "preamble": HYPOTHESIS_MENU_PREAMBLE,
        "notes": ranked,
        "formatted": formatted,
    }


def search_for_mode(
    mode: str,
    game_id: str,
    *,
    level: Any = None,
    vocabulary: Any = None,
    divergence: Any = None,
    client: KbClient | None = None,
) -> list[dict[str, Any]]:
    """Run the KB search prescribed for ``mode`` (or none for PLAN/EXECUTE).

    Per the EWM spec search table:

    * ORIENT    — keyed lookup of this game's world-model program, k=1.
    * SYNTHESIZE— semantic search over segmentation vocabulary (object/color/mechanic words), k=4.
    * REPAIR    — failed-repair + mechanic-pattern notes matching the divergence, k=4.
    * RECOVER   — failure + modelability notes for this game, k=4.
    * PLAN/EXECUTE — never touch the KB; return [] WITHOUT any HTTP call.

    Query strings are standalone-token prose built from game/level/vocabulary words.
    """

    mode = mode.upper()
    if mode in NO_SEARCH_MODES:
        return []
    if mode not in SEARCH_MODES:
        raise ValueError(
            f"unknown search mode {mode!r}; expected one of {SEARCH_MODES + NO_SEARCH_MODES}"
        )
    if client is None:
        raise ValueError("search_for_mode requires a KbClient (pass client=...)")

    if mode == "ORIENT":
        q = " ".join(_dedupe(["game", *_tokens(game_id), "world", "model", "program"]))
        # k>1 and full_content: a CHUNKED program shares the query tokens with every chunk note
        # ("game <id> world model program chunk n of N"), so a k=1 lookup can return a chunk instead
        # of the INDEX note. Fetch a small candidate pool, then prefer the index note — the
        # game-scoped hit whose title carries NO "chunk" token — so ORIENT keys on the index, which
        # carries the chunk count + source length it needs to reassemble. full_content lifts the index
        # body past the 200-char summary clip so those fields survive retrieval.
        # k is generous: the daemon always PREPENDS ~5 system notes (score 1.0) AND, for a chunked
        # program, every chunk note outscores the index note on this exact query — so the index note
        # can sit well past rank 8. A small k would return only system notes + chunks and miss the
        # index entirely. 20 comfortably clears the system-note + chunk band.
        hits = _search_full_content(client, q, k=20)
        scoped = [h for h in hits if _is_game_scoped(h, game_id)]
        if scoped:
            # The INDEX note is a game-scoped note that is NOT a chunk note and NOT a source-cluster
            # artifact. The daemon's long-note splitter (lib/note-source-cluster.js) emits
            # `knowledge:source_*` "evidence" nodes whose titles inherit the program tokens; those are
            # never the index and must be filtered out or ORIENT keys on an empty stub.
            index_hits = [
                h for h in scoped if not _is_chunk_note(h) and not _is_cluster_artifact(h)
            ]
            # Prefer a note whose body actually carries the chunk-count field (a real chunked index)
            # over any bare same-title note left over from an older single-note write.
            chunked = [h for h in index_hits if _INDEX_CHUNKS_RE.search(_note_text(h) + " " + str(h.get("content", "")))]
            return chunked or index_hits or scoped
        # New game: no game-scoped program note. Hand back a hypothesis menu, NOT raw semantic hits.
        return [hypothesis_menu(game_id, list(_tokens(vocabulary)), client=client)]

    if mode == "SYNTHESIZE":
        q = " ".join(
            _dedupe(["mechanic", "pattern", *_tokens(game_id), *_tokens(vocabulary)])
        )
        hits = client.search(q, k=4, gated=False)
        scoped = [h for h in hits if _is_game_scoped(h, game_id)]
        if scoped:
            return scoped
        # New game: no game-scoped facts. Fall back to the tagged cross-game hypothesis menu.
        return [hypothesis_menu(game_id, list(_tokens(vocabulary)), client=client)]

    if mode == "REPAIR":
        q = " ".join(
            _dedupe(
                [
                    "failed",
                    "repair",
                    *_tokens(game_id),
                    "mechanic",
                    "pattern",
                    *_tokens(divergence),
                ]
            )
        )
        return client.search(q, k=4, gated=False)

    # RECOVER
    q = " ".join(_dedupe(["failure", "modelability", *_tokens(game_id), *_tokens(vocabulary)]))
    return client.search(q, k=4, gated=False)


# --------------------------------------------------------------------------------------------------
# Acceptance-event writes
# --------------------------------------------------------------------------------------------------

_DIGITS_SEP_LINE = re.compile(r"^[\s0-9,/|.\-]+$")
_LONG_DIGIT_RUN = re.compile(r"\d{12,}")

# Absolute-coordinate patterns forbidden in a cross-game hypothesis body. Cross-game mechanism
# notes must describe dynamics in RELATIVE terms — a hypothesis that fires "at row 40" or
# "(40,34)" has smuggled one game's screen layout into another game's menu, which is exactly the
# fact-vs-hypothesis leak this schema forbids.
_ABS_COORD_PATTERNS: tuple[re.Pattern[str], ...] = (
    # "row 40", "col 12", "cols 34-38", "column 7", "rows 1-3"
    re.compile(r"\b(?:row|rows|col|cols|column|columns)\s+\d+", re.IGNORECASE),
    # "(40,34)" / "(40, 34)" — an explicit coordinate pair
    re.compile(r"\(\s*\d+\s*,\s*\d+\s*\)"),
    # bare digit-pair coordinate like "40,34" or "40, 34"
    re.compile(r"\b\d+\s*,\s*\d+\b"),
)


def contains_absolute_coordinates(text: str) -> bool:
    """Heuristic guard: does ``text`` pin a mechanism to an absolute screen coordinate?

    Cross-game hypotheses must stay coordinate-free (relative dynamics only). We reject any
    ``row N`` / ``cols N-M`` / ``(N,M)`` / bare ``N,M`` coordinate pattern.
    """

    return any(pat.search(text) for pat in _ABS_COORD_PATTERNS)


def looks_like_grid_dump(body: str) -> bool:
    """Heuristic guard: does ``body`` embed a raw grid dump?

    Raw grids never belong in note bodies (they blow up embeddings and leak per-frame state). We
    reject a body if either:

    * it has >= 3 CONSECUTIVE lines that are only digits/separators (a stacked grid), or
    * any single line packs 12+ digit characters (a flattened grid row).
    """

    run = 0
    for line in body.splitlines():
        stripped = line.strip()
        digit_count = sum(ch.isdigit() for ch in stripped)
        if stripped and _DIGITS_SEP_LINE.match(stripped) and digit_count >= 2:
            run += 1
            if run >= 3:
                return True
        else:
            run = 0
        if _LONG_DIGIT_RUN.search(stripped.replace(" ", "")):
            return True
    return False


class WriteGate:
    """Per-turn acceptance-event write gate over a :class:`KbClient`.

    Writes only fire at acceptance events, at most ``max_writes_per_turn`` per decision turn, and
    never carry raw grid dumps. Call :meth:`begin_turn` at the start of each decision turn to reset
    the counter. Each ``write_*`` helper builds a standalone-token title and returns either the
    daemon response dict or a refusal dict (``{"ok": False, "reason": ...}``).
    """

    def __init__(self, client: KbClient, max_writes_per_turn: int = 2) -> None:
        self.client = client
        self.max_writes_per_turn = max_writes_per_turn
        self._writes_this_turn = 0

    def begin_turn(self) -> None:
        """Reset the per-turn write counter. Call once per decision turn."""

        self._writes_this_turn = 0

    def _guarded_note(
        self,
        title: str,
        summary: str,
        *,
        supersedes: str | None = None,
    ) -> dict[str, Any]:
        if self._writes_this_turn >= self.max_writes_per_turn:
            logger.warning("KB write refused (turn cap %d hit): %r", self.max_writes_per_turn, title)
            return {"ok": False, "reason": "write cap"}
        if looks_like_grid_dump(summary):
            logger.warning("KB write refused (raw grid dump in body): %r", title)
            return {"ok": False, "reason": "grid dump"}
        result = self.client.note(title, summary, category="arc-agi-3", supersedes=supersedes)
        self._writes_this_turn += 1
        return result

    def write_program_revision(
        self,
        game_id: str,
        prose_summary: str,
        program_source: str,
        pass_rate: Any,
        supersedes: str | None = None,
    ) -> dict[str, Any]:
        """Acceptance: a revised world-model program for this game (supersedes the prior program).

        Body = prose summary (the retrieval key) + program source + suite pass rate.
        """

        title = _title("game", game_id, "world model program")
        body = (
            f"{prose_summary}\n\n"
            f"pass rate: {pass_rate}\n\n"
            f"program source:\n{program_source}"
        )
        return self._guarded_note(title, body, supersedes=supersedes)

    def write_program_revision_chunked(
        self,
        game_id: str,
        prose_summary: str,
        program_source: str,
        pass_rate: Any,
        *,
        supersedes: str | None = None,
    ) -> dict[str, Any]:
        """Acceptance: persist a world-model program TOO LARGE to survive the daemon's note clip.

        The daemon clips a note body to 2000 chars on write and returns at most 1200 chars on a
        full_content read, so a program bigger than ~1200 chars cannot round-trip as one note (the run
        12 break). This writer splits ``program_source`` across N chunk notes — each titled
        ``game <id> world model program chunk <n> of <N>`` with a body of ``chunk n of N\\n<slice>``
        that stays under :data:`CHUNK_BODY_LIMIT` — then writes the INDEX note
        ``game <id> world model program`` carrying the prose retrieval key, the pass rate, the chunk
        count, and the exact source byte length. ORIENT fetches the index note, then the chunks by
        their exact titles, reassembles in order, and verifies the byte length.

        This is NOT gated by the per-turn write cap: a chunked revision is ONE acceptance event whose
        note count is a function of program size, not a burst of independent writes. It writes the
        chunks FIRST, then the index note last, so the index (the entry point ORIENT keys on) never
        points at chunks that were not written. The prose summary is grid-dump guarded like every
        other write. Returns ``{"ok": True, "chunks": N, "length": L, "index": <resp>, "chunk_ids":
        [...]}`` or a refusal/error dict.
        """

        if looks_like_grid_dump(prose_summary):
            logger.warning("chunked program revision refused (grid dump in prose): %r", game_id)
            return {"ok": False, "reason": "grid dump"}

        slices = chunk_program_source(program_source)
        total = len(slices)
        source_length = len(program_source.encode("utf-8"))

        chunk_ids: list[Any] = []
        for i, slice_text in enumerate(slices, start=1):
            title = program_chunk_title(game_id, i, total)
            body = f"chunk {i} of {total}\n{slice_text}"
            resp = self.client.note(title, body, category="arc-agi-3")
            if not (isinstance(resp, dict) and resp.get("ok", True) and "error" not in resp):
                return {"ok": False, "reason": "chunk write failed", "chunk": i, "response": resp}
            chunk_ids.append(resp.get("id") or resp.get("key"))

        index_title = _title("game", game_id, "world model program")
        index_body = (
            f"{prose_summary}\n\n"
            f"pass rate: {pass_rate}\n\n"
            f"chunk count: {total}\n"
            f"source length: {source_length}\n\n"
            "program stored in chunk notes titled "
            f"'{program_chunk_title(game_id, 1, total)}' .. "
            f"'{program_chunk_title(game_id, total, total)}'."
        )
        index_resp = self.client.note(index_title, index_body, category="arc-agi-3", supersedes=supersedes)
        if not (isinstance(index_resp, dict) and index_resp.get("ok", True) and "error" not in index_resp):
            return {"ok": False, "reason": "index write failed", "response": index_resp}
        return {
            "ok": True,
            "chunks": total,
            "length": source_length,
            "index": index_resp,
            "chunk_ids": chunk_ids,
        }

    def write_level_solution(
        self,
        game_id: str,
        level: Any,
        actions: Any,
        insight: str,
    ) -> dict[str, Any]:
        """Acceptance: a solved level (game+level, action sequence + unlocking insight)."""

        title = _title("game", game_id, "level", level, "solution")
        actions_text = _actions_text(actions)
        body = f"unlocking insight: {insight}\n\naction sequence: {actions_text}"
        return self._guarded_note(title, body)

    def write_goal_evidence(
        self,
        game_id: str,
        level: Any,
        player_position: Any,
        insight: str,
    ) -> dict[str, Any]:
        """Acceptance: FIRST-observed level/score boundary — the goal-contact evidence GOAL DISCOVERY
        captures so a re-derived ``is_win`` (goal-contact predicate) has real ground truth.

        Body records the player position/state that IMMEDIATELY PRECEDED the boundary (what the
        avatar touched to trip the level clear) plus a one-line insight. Standalone-token title
        ``game <id> level <n> goal evidence`` so it round-trips for the exact query GOAL DISCOVERY
        writes it to answer. Not a grid dump (a single coordinate), so it clears the dump guard."""

        title = _title("game", game_id, "level", level, "goal evidence")
        body = (
            f"goal contact at player position: {player_position}\n\n"
            f"boundary insight: {insight}"
        )
        return self._guarded_note(title, body)

    def write_mechanism_hypothesis(
        self,
        name: str,
        cues: list[str],
        probe: str,
        dynamics: str,
        observed_in: list[str],
        *,
        _legacy: bool = False,
    ) -> dict[str, Any]:
        """Acceptance: a cross-game mechanism HYPOTHESIS (never a fact).

        The body is rendered in hypothesis form — "SOME games {dynamics}." — so a future game reads
        it as a guess to test, not a rule to obey. To keep the note transferable we REJECT any
        ``dynamics``/``cues`` text that:

        * pins a mechanism to an absolute coordinate (``row 40``, ``cols 34-38``, ``(40,34)``,
          bare ``40,34``) — that is one game's screen layout leaking into another game's menu; or
        * names a game id that is not in ``observed_in`` — a hypothesis can only claim the games it
          was actually observed in.

        Returns a refusal dict (``{"ok": False, "reason": ...}``) on either violation.
        """

        coord_fields = [dynamics, *(cues or [])]
        for field in coord_fields:
            if contains_absolute_coordinates(str(field)):
                logger.warning("mechanism hypothesis refused (absolute coordinate): %r", name)
                return {"ok": False, "reason": "absolute coordinate"}

        foreign = _foreign_game_ids(coord_fields, observed_in or [])
        if foreign:
            logger.warning(
                "mechanism hypothesis refused (game id %r not in observed_in): %r",
                foreign[0],
                name,
            )
            return {"ok": False, "reason": "foreign game id"}

        title = _title("mechanism hypothesis", name)
        cues_text = ", ".join(cues) if cues else ""
        observed_text = ", ".join(observed_in) if observed_in else ""
        body = (
            f"SOME games {dynamics}. "
            f"Cues: {cues_text}. "
            f"Probe: {probe}. "
            f"Observed in: {observed_text}."
        )
        if _legacy:
            body = f"{body}\n\n(legacy — migrated from write_mechanic_pattern; empty cues/probe)"
        return self._guarded_note(title, body)

    def write_mechanic_pattern(
        self,
        name: str,
        prose: str,
        code_snippet: str,
    ) -> dict[str, Any]:
        """DEPRECATED alias for :meth:`write_mechanism_hypothesis`.

        Kept for callers on the old fact-shaped signature. Maps ``prose`` -> ``dynamics`` and passes
        empty ``cues``/``probe`` (allowed, but the note body is flagged "legacy"). ``code_snippet``
        is dropped — a cross-game hypothesis carries a probe, not a game-specific code snippet.
        """

        return self.write_mechanism_hypothesis(
            name,
            cues=[],
            probe="",
            dynamics=prose,
            observed_in=[],
            _legacy=True,
        )

    def write_modelability_verdict(
        self,
        game_id: str,
        verdict: str,
        evidence: str,
        supersedes: str | None = None,
    ) -> dict[str, Any]:
        """Acceptance: a modelability verdict for this game (supersedes the prior verdict)."""

        title = _title("game", game_id, "modelability verdict")
        body = f"verdict: {verdict}\n\nevidence: {evidence}"
        return self._guarded_note(title, body, supersedes=supersedes)

    def write_failed_repair(
        self,
        game_id: str,
        description: str,
    ) -> dict[str, Any]:
        """Acceptance: a failed-repair note for this game (what was tried and why it did not hold)."""

        title = _title("game", game_id, "failed repair")
        return self._guarded_note(title, description)


# A game id in this benchmark looks like letters immediately followed by digits, e.g. "ls20".
_GAME_ID_TOKEN = re.compile(r"\b([a-z]{2,}\d+)\b", re.IGNORECASE)


def _foreign_game_ids(fields: list[Any], observed_in: list[str]) -> list[str]:
    """Return game-id-shaped tokens in ``fields`` that are not present in ``observed_in``.

    Cross-game hypotheses may only name the games they were observed in; any other game id in the
    dynamics/cues is a fact leaking from a game the hypothesis has no evidence for.
    """

    allowed = {gid.lower() for gid in observed_in}
    foreign: list[str] = []
    for field in fields:
        for match in _GAME_ID_TOKEN.finditer(str(field)):
            gid = match.group(1).lower()
            if gid not in allowed and gid not in foreign:
                foreign.append(gid)
    return foreign


def _title(*parts: Any) -> str:
    """Build a standalone-token title: words separated by spaces, no camelCase/hyphen fusion."""

    return " ".join(_tokens(*parts))


def _actions_text(actions: Any) -> str:
    if isinstance(actions, (list, tuple)):
        return " ".join(str(a) for a in actions)
    return str(actions)
