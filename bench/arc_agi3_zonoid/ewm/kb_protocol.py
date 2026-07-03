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

    def search(self, q: str, k: int, gated: bool = False) -> list[dict[str, Any]]:
        """GET {daemon_url}/search — return the parsed result list (empty on any failure)."""

        query = parse.urlencode(
            {
                "workspace": self.workspace,
                "task_key": self.task_key,
                "q": q,
                "k": k,
                "gated": "true" if gated else "false",
            }
        )
        url = f"{self.daemon_url}/search?{query}"
        try:
            req = request.Request(url, method="GET")
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:  # noqa: BLE001
            logger.warning("KB search failed for %r: %r", q, exc)
            return []
        return _extract_results(payload)

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
        hits = client.search(q, k=1, gated=False)
        scoped = [h for h in hits if _is_game_scoped(h, game_id)]
        if scoped:
            return scoped
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
