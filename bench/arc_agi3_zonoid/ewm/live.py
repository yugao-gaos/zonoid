"""Live ARC-AGI-3 game session env for :class:`~.agent.EwmAgent`.

This module wires the EWM agent's ``observe``/``act`` seam onto the *official* ARC-AGI-3
benchmarking checkout's game client (``arc_agi.Arcade`` -> ``EnvironmentWrapper`` from the
``arcengine`` SDK). It is the piece :class:`~.driver.ArcEnvAdapter` deliberately left out: a
concrete backend that opens a real game session, fetches frames, submits actions, and closes the
scorecard.

Design constraints (mirroring the rest of the ewm package):

* **SDK-free import.** Importing this module pulls in NO ARC SDK. The checkout / ``arcengine`` /
  ``arc_agi`` imports happen lazily inside :meth:`LiveArcSession.open`, after the checkout path has
  been added to ``sys.path`` (via the ``--benchmarking-repo`` flag or ``ARC_BENCHMARKING_REPO``).
  So this module and the whole ewm test suite stay import-clean without the SDK.
* **Seam-faithful.** :class:`LiveArcSession` exposes exactly ``observe()`` and ``act(actions,
  expect=None)`` in the shapes :class:`~.agent.EwmAgent` consumes, translating the checkout's
  ``FrameDataRaw`` <-> the seam dicts and the seam's ``ACTIONk`` names <-> ``GameAction``.
* **Testable without a network.** The SDK boundary is a small ``client`` object exposing
  ``make(...) -> wrapper``, ``open_scorecard(...) / close_scorecard(...)`` and a
  ``game_action(name) -> action`` factory. Tests inject a fake client; production builds a real one
  from the checkout.

The session translates:

    FrameDataRaw.frame (list[ndarray])        -> grid: list[list[int]]  (last/topmost frame)
    FrameDataRaw.available_actions (list[int]) -> valid_actions: ["ACTIONk", ...]
    FrameDataRaw.levels_completed              -> level (1-based) + score
    FrameDataRaw.state == WIN                  -> done
    seam "ACTIONk" (+ optional x,y)            -> GameAction.from_name(name).set_data({...})

Hard caps (``max_actions`` / ``max_seconds``) are enforced in :meth:`act` and surfaced through the
seam's ``remaining_actions`` / ``remaining_seconds`` so the agent's own budget check trips too.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any, Callable, Optional

from .world_model import grids_match

ENV_BENCHMARKING_REPO = "ARC_BENCHMARKING_REPO"

# Seam action vocabulary. ACTION6 is the ARC "complex" action taking (x, y) coords 0..63.
ARC_ACTIONS: tuple[str, ...] = (
    "ACTION1",
    "ACTION2",
    "ACTION3",
    "ACTION4",
    "ACTION5",
    "ACTION6",
    "ACTION7",
)
_COMPLEX_ACTIONS = frozenset({"ACTION6"})


# --------------------------------------------------------------------------------------------------
# SDK boundary — a thin client the session drives, so tests can substitute a fake.
# --------------------------------------------------------------------------------------------------


class ArcClient:
    """Thin adapter over the official checkout's ``arc_agi``/``arcengine`` game client.

    Constructed lazily (only when a live run is actually requested) so importing :mod:`live` stays
    SDK-free. Exposes the small surface :class:`LiveArcSession` needs:

        open_scorecard(tags) -> card_id
        make(game_id, card_id) -> EnvironmentWrapper
        game_action(name) -> GameAction   (with optional x/y coords set)
        close_scorecard(card_id) -> scorecard | None
        scorecard_url(card_id) -> str | None
    """

    def __init__(self, root_url: str | None = None) -> None:
        # Imported here (not at module top) so the module stays SDK-free until a live run.
        from arc_agi import Arcade, OperationMode  # type: ignore
        from arcengine import GameAction  # type: ignore

        self._GameAction = GameAction
        self._root_url = (root_url or os.environ.get("ARC_BASE_URL") or "https://arcprize.org").rstrip("/")
        self._arc = Arcade(operation_mode=OperationMode.ONLINE)

    def open_scorecard(self, tags: Optional[list[str]] = None) -> str:
        return str(self._arc.open_scorecard(tags=tags or []))

    def make(self, game_id: str, card_id: str) -> Any:
        return self._arc.make(game_id, scorecard_id=card_id)

    def game_action(self, name: str, x: int | None = None, y: int | None = None) -> Any:
        action = self._GameAction.from_name(name)
        if action.is_complex():
            action.set_data({"x": int(x or 0), "y": int(y or 0)})
        return action

    def close_scorecard(self, card_id: str) -> Any:
        try:
            return self._arc.close_scorecard(card_id)
        except Exception:  # noqa: BLE001 - closing is best-effort; never crash the run on it
            return None

    def scorecard_url(self, card_id: str) -> str | None:
        if not card_id:
            return None
        return f"{self._root_url}/scorecards/{card_id}"


def add_checkout_to_path(repo_path: str | None) -> str:
    """Add the official benchmarking checkout to ``sys.path`` and load its ``.env``.

    ``repo_path`` (or ``ARC_BENCHMARKING_REPO``) must point at a checkout that provides ``arc_agi``
    and ``arcengine`` importable and a ``.env`` carrying ``ARC_API_KEY`` / ``ARC_BASE_URL``. Returns
    the resolved absolute path. Raises :class:`RuntimeError` with a clear message if unset/missing.
    """

    repo = (repo_path or os.environ.get(ENV_BENCHMARKING_REPO) or "").strip()
    if not repo:
        raise RuntimeError(
            "Live ARC run needs the official benchmarking checkout: pass --benchmarking-repo "
            f"or set {ENV_BENCHMARKING_REPO} to the checkout directory."
        )
    repo = os.path.abspath(os.path.expanduser(repo))
    if not os.path.isdir(repo):
        raise RuntimeError(f"benchmarking checkout {repo!r} is not a directory.")
    if repo not in sys.path:
        sys.path.insert(0, repo)
    # Load the checkout's .env (ARC_API_KEY / ARC_BASE_URL) without a third-party dep.
    _load_env_file(os.path.join(repo, ".env"))
    return repo


def _load_env_file(path: str) -> None:
    """Minimal ``.env`` loader (stdlib only). Does not override already-set env vars."""

    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


# --------------------------------------------------------------------------------------------------
# LiveArcSession — the EwmAgent env seam over a real game session.
# --------------------------------------------------------------------------------------------------


class LiveArcSession:
    """A live ARC-AGI-3 game session behind the EwmAgent ``observe``/``act`` seam.

    ``client`` is any object exposing the :class:`ArcClient` surface. On :meth:`open` the session
    opens a scorecard, makes the game env, and RESETs it to fetch the first frame. :meth:`observe`
    returns the current frame as a seam dict; :meth:`act` submits a batch of seam actions one at a
    time (mapping ``ACTIONk`` -> ``GameAction``), stopping early on WIN, level transition, budget
    exhaustion, or an ``expect``-grid mismatch.

    Hard caps: ``max_actions`` (total submitted actions) and ``max_seconds`` (wall clock from
    :meth:`open`). Both are surfaced through the seam so the agent's own budget guard also trips.
    """

    def __init__(
        self,
        client: Any,
        game_id: str,
        *,
        max_actions: int = 80,
        max_seconds: float = 25 * 60,
        tags: Optional[list[str]] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.game_id = game_id
        self.max_actions = int(max_actions)
        self.max_seconds = float(max_seconds)
        self.tags = tags or ["ewm", "ewm-live"]
        self._clock = clock

        self.env: Any = None
        self.card_id: str | None = None
        self._last_frame: Any = None
        self._started_at: float | None = None

        # Counters exposed for the run summary.
        self.actions_taken = 0
        self.levels_completed = 0
        self.won = False
        self.game_over = False
        self.stop_reason: str | None = None
        # Non-RESET actions that reached playable frames. The deterministic history restores the
        # current position if the live ARC server evicts an idle session between model calls.
        self._action_log: list[tuple[str, int | None, int | None]] = []
        self._recoveries = 0

    # -- lifecycle ---------------------------------------------------------------------------------

    def open(self) -> "LiveArcSession":
        """Open the scorecard, make the env, RESET to the first frame."""

        self.card_id = self.client.open_scorecard(self.tags)
        self.env = self.client.make(self.game_id, self.card_id)
        if self.env is None:
            raise RuntimeError(
                f"could not make ARC env for game {self.game_id!r} "
                f"(scorecard {self.card_id!r}); check ARC_API_KEY / game id."
            )
        self._started_at = self._clock()
        # RESET yields the first playable frame.
        self._last_frame = self._submit("RESET")
        return self

    def close(self) -> Any:
        """Close the scorecard (best-effort). Returns the scorecard payload if the client gives one."""

        if self.card_id is None:
            return None
        card = self.card_id
        self.card_id = None
        return self.client.close_scorecard(card)

    def scorecard_url(self) -> str | None:
        getter = getattr(self.client, "scorecard_url", None)
        return getter(self.card_id) if callable(getter) and self.card_id else None

    def __enter__(self) -> "LiveArcSession":
        return self.open()

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- budget ------------------------------------------------------------------------------------

    def _elapsed(self) -> float:
        return 0.0 if self._started_at is None else self._clock() - self._started_at

    def remaining_actions(self) -> int:
        return max(0, self.max_actions - self.actions_taken)

    def remaining_seconds(self) -> float:
        return max(0.0, self.max_seconds - self._elapsed())

    def out_of_budget(self) -> bool:
        return self.remaining_actions() <= 0 or self.remaining_seconds() <= 0

    # -- frame <-> seam translation ----------------------------------------------------------------

    @staticmethod
    def _frame_grid(frame: Any) -> list[list[int]]:
        """Pull the grid (list-of-list-of-int) out of a FrameDataRaw-like object.

        ``FrameDataRaw.frame`` is a list of numpy arrays (a stack of animation frames); we take the
        last (most recent) and coerce to plain ints. Tolerates already-plain lists too.
        """

        frames = getattr(frame, "frame", None)
        if frames is None and isinstance(frame, dict):
            frames = frame.get("frame")
        if not frames:
            return []
        grid = frames[-1]
        tolist = getattr(grid, "tolist", None)
        if callable(tolist):
            grid = tolist()
        return [[int(v) for v in row] for row in grid]

    @staticmethod
    def _state_name(frame: Any) -> str:
        state = getattr(frame, "state", None)
        if state is None and isinstance(frame, dict):
            state = frame.get("state")
        name = getattr(state, "name", None)
        return str(name if name is not None else state or "").upper()

    @staticmethod
    def _available_actions(frame: Any) -> list[str]:
        raw = getattr(frame, "available_actions", None)
        if raw is None and isinstance(frame, dict):
            raw = frame.get("available_actions")
        out: list[str] = []
        for item in raw or []:
            if isinstance(item, int):
                out.append(f"ACTION{item}")
            elif isinstance(item, str):
                out.append(item)
            else:
                name = getattr(item, "name", None)
                out.append(str(name) if name else str(item))
        # Drop RESET from the agent's action menu — the session forces RESET on GAME_OVER itself.
        out = [a for a in out if a != "RESET"]
        return out or list(ARC_ACTIONS)

    def _to_seam_observation(self, frame: Any) -> dict[str, Any]:
        levels = int(getattr(frame, "levels_completed", 0) or (frame.get("levels_completed", 0) if isinstance(frame, dict) else 0))
        return {
            "grid": self._frame_grid(frame),
            "level": levels + 1,  # 1-based current level
            "step": self.actions_taken,
            "valid_actions": self._available_actions(frame),
            "score": levels,
            "remaining_actions": self.remaining_actions(),
            "remaining_seconds": self.remaining_seconds(),
            "done": self.won or self.out_of_budget(),
        }

    # -- action submission -------------------------------------------------------------------------

    @staticmethod
    def _parse_seam_action(action: Any) -> tuple[str, int | None, int | None]:
        """Normalize a seam action into (name, x, y). x/y only used for complex actions (ACTION6)."""

        if isinstance(action, dict):
            name = str(action.get("action") or action.get("name") or "")
            return name, action.get("x"), action.get("y")
        return str(action), None, None

    @staticmethod
    def _frame_is_playable(frame: Any) -> bool:
        """Return whether ``frame`` represents a started game with a non-empty grid."""

        if frame is None or LiveArcSession._state_name(frame) in {
            "NOT_STARTED",
            "GAME_NOT_STARTED",
        }:
            return False
        frames = getattr(frame, "frame", None)
        if frames is None and isinstance(frame, dict):
            frames = frame.get("frame")
        if not frames or frames[-1] is None:
            return False
        grid = frames[-1]
        size = getattr(grid, "size", None)
        return bool(size) if size is not None else bool(grid)

    def _raw_submit(self, name: str, x: int | None, y: int | None) -> Any:
        """Submit one action without touching counters or the replay log."""

        game_action = self.client.game_action(name, x, y)
        frame = self.env.step(game_action)
        if frame is None:
            # Fall back to the wrapper's last observation if step returns None.
            frame = getattr(self.env, "observation_space", None)
        return frame

    def _recover_session(self) -> Any:
        """Re-make an idle-evicted game, RESET it, and replay the deterministic action history."""

        self._recoveries += 1
        try:
            self.env = self.client.make(self.game_id, self.card_id)
            if self.env is None:
                return None
            frame = self._raw_submit("RESET", None, None)
            if not self._frame_is_playable(frame):
                return None
            for action_name, action_x, action_y in self._action_log:
                frame = self._raw_submit(action_name, action_x, action_y)
                if not self._frame_is_playable(frame):
                    return None
            return frame
        except Exception:  # noqa: BLE001 - recovery is best-effort; the failed frame is surfaced
            return None

    def _submit(self, name: str, x: int | None = None, y: int | None = None) -> Any:
        """Submit one action, recovering an idle-evicted live session once when needed."""

        frame = self._raw_submit(name, x, y)
        if name != "RESET" and not self._frame_is_playable(frame):
            restored = self._recover_session()
            if restored is not None:
                frame = self._raw_submit(name, x, y)
        self._last_frame = frame
        if name != "RESET":
            self.actions_taken += 1
            if self._frame_is_playable(frame):
                self._action_log.append((name, x, y))
        self._sync_progress(frame)
        return frame

    def _sync_progress(self, frame: Any) -> None:
        levels = int(getattr(frame, "levels_completed", 0) or (frame.get("levels_completed", 0) if isinstance(frame, dict) else 0))
        if levels > self.levels_completed:
            self.levels_completed = levels
        state = self._state_name(frame)
        if state == "WIN":
            self.won = True
        elif state == "GAME_OVER":
            self.game_over = True

    def observe(self) -> dict[str, Any]:
        frame = self._last_frame
        if frame is None:
            # Not opened via open(); do a lazy RESET so observe() is self-sufficient.
            self.open()
            frame = self._last_frame
        return self._to_seam_observation(frame)

    def act(self, actions: list[Any], expect: list[Any] | None = None) -> dict[str, Any]:
        executed: list[str] = []
        prev_levels = self.levels_completed
        stop_reason = "completed"
        level_transition = False

        for index, action in enumerate(actions):
            if self.out_of_budget():
                stop_reason = "budget"
                break
            name, x, y = self._parse_seam_action(action)
            if not name:
                continue
            frame = self._submit(name, x, y)
            executed.append(name)

            after = self._frame_grid(frame)
            if expect is not None and index < len(expect) and expect[index] is not None:
                # UNKNOWN-aware: a partially-adopted (masked) program renders UNKNOWN on cells it
                # does not model; those cells are wildcards, not divergences.
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break

            if self.won:
                stop_reason = "done"
                break
            if self.levels_completed > prev_levels:
                level_transition = True
                stop_reason = "level_transition"
                break
            if self.game_over:
                # The base agent's env would RESET; we surface it and let the loop continue/probe.
                stop_reason = "game_over"
                break

        seam_frame = self._to_seam_observation(self._last_frame)
        if self.out_of_budget() and stop_reason == "completed":
            stop_reason = "budget"
        self.stop_reason = stop_reason
        return {
            "current_frame": {
                "grid": seam_frame["grid"],
                "level": seam_frame["level"],
                "step": seam_frame["step"],
                "score": seam_frame["score"],
            },
            "action_result": {"score": seam_frame["score"], "done": self.won},
            "valid_actions": seam_frame["valid_actions"],
            "remaining_actions": self.remaining_actions(),
            "remaining_seconds": self.remaining_seconds(),
            "executed": executed,
            "stop_reason": stop_reason,
            "board_changed": bool(executed),
            "level_transition": level_transition,
            "done": self.won,
        }


def build_live_session(
    game_id: str,
    *,
    benchmarking_repo: str | None = None,
    max_actions: int = 80,
    max_seconds: float = 25 * 60,
    tags: Optional[list[str]] = None,
) -> LiveArcSession:
    """Resolve the checkout, build a real :class:`ArcClient`, and return an *unopened* session.

    This is the production entry point the driver calls. It adds the checkout to ``sys.path`` (the
    only place the ARC SDK is imported) and raises a clear :class:`RuntimeError` when the checkout /
    SDK is absent. Call :meth:`LiveArcSession.open` (or use it as a context manager) to start play.
    """

    add_checkout_to_path(benchmarking_repo)
    client = ArcClient()
    return LiveArcSession(
        client,
        game_id,
        max_actions=max_actions,
        max_seconds=max_seconds,
        tags=tags,
    )
