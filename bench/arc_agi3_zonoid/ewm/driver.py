"""Env driver: bridge :class:`~.agent.EwmAgent` to a runnable ARC-AGI-3 surface.

Two env implementations sit behind the exact callback seam the agent consumes
(:class:`~.agent.EwmAgent`):

    observe() -> {grid, level, step, valid_actions, score, remaining_actions?, done?}
    act(actions, expect=None) -> {current_frame, action_result, valid_actions?, executed, stop_reason, done}

* :class:`ScriptedEnv` — a deterministic, offline toy game (avatar=2 on 0-cells, wall=1 blocks,
  goal=3), extending the toy-game pattern used across the ewm tests. It includes at least one
  level transition and a final win, so the full agent loop (SYNTHESIZE -> PLAN -> EXECUTE) can be
  exercised with zero network/GPU/SDK. This is the surface ``--smoke`` runs against.

* :class:`ArcEnvAdapter` — wraps the live ARC-AGI-3 game contract exposed by the Mode B / official
  checkout path (a backend that yields *frame dicts* carrying a grid, a state, a score, and the set
  of available ARC actions). It translates those frame dicts into the seam dict, and translates
  seam action names (``ACTION1``..``ACTION6``) into the backend's ARC action calls. The real
  SDK/checkout is isolated behind a lazy import so this module imports and smoke-runs with **zero**
  network/GPU/SDK; when the live path is requested without the SDK present it raises a clear
  :class:`RuntimeError` naming what is missing.

CLI:

    python3 -m bench.arc_agi3_zonoid.ewm.driver --smoke

runs the FULL agent loop with ``FakeLlm`` + ``ScriptedEnv`` + KB disabled and prints one
run-summary JSON line. ``--game/--backend/--daemon-url`` route to :class:`ArcEnvAdapter` for the
future live path and fail with the clear RuntimeError if the SDK/checkout is absent.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Callable

from .agent import AgentConfig, EwmAgent
from .llm_client import FakeLlm
from .world_model import grids_match

# The five-function contract source the scripted smoke run's LLM "authors". Kept identical in shape
# to the world-model kit's toy game so the planner can BFS it to a win with zero guessing.
TOY_GAME_SOURCE = '''
import copy

AVATAR = 2
WALL = 1
GOAL = 3

DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}


def init_state(frame):
    rows = len(frame)
    cols = len(frame[0]) if rows else 0
    avatar = None
    goal = None
    walls = set()
    for r in range(rows):
        for c in range(cols):
            v = frame[r][c]
            if v == AVATAR:
                avatar = (r, c)
            elif v == GOAL:
                goal = (r, c)
            elif v == WALL:
                walls.add((r, c))
    return {"avatar": avatar, "goal": goal, "walls": frozenset(walls), "rows": rows, "cols": cols}


def legal_actions(state):
    return ["UP", "DOWN", "LEFT", "RIGHT"]


def step(state, action):
    state = copy.deepcopy(state)
    dr, dc = DELTAS[action]
    r, c = state["avatar"]
    nr, nc = r + dr, c + dc
    moved = False
    if 0 <= nr < state["rows"] and 0 <= nc < state["cols"] and (nr, nc) not in state["walls"]:
        state["avatar"] = (nr, nc)
        moved = True
    events = {"moved": moved}
    return state, events


def render(state):
    rows, cols = state["rows"], state["cols"]
    grid = [[0 for _ in range(cols)] for _ in range(rows)]
    for (r, c) in state["walls"]:
        grid[r][c] = WALL
    gr, gc = state["goal"]
    grid[gr][gc] = GOAL
    ar, ac = state["avatar"]
    grid[ar][ac] = AVATAR
    return grid


def is_win(state):
    return state["avatar"] == state["goal"]
'''


# --------------------------------------------------------------------------------------------------
# ScriptedEnv — deterministic offline toy game (the smoke-run surface)
# --------------------------------------------------------------------------------------------------

_DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}
_ACTIONS = ("UP", "DOWN", "LEFT", "RIGHT")


def _grid_from_rows(rows: list[str]) -> list[list[int]]:
    """Build an int grid from compact string rows ('.'=0, digits as-is)."""

    return [[0 if ch == "." else int(ch) for ch in row] for row in rows]


# A two-level game: clearing level 1's goal advances to level 2; clearing level 2's goal wins.
_DEFAULT_LEVELS: tuple[tuple[str, ...], ...] = (
    ("2.3",),      # level 1: avatar left, goal two cells right
    ("2..3",),     # level 2: avatar left, goal three cells right
)


class ScriptedEnv:
    """A faithful in-process toy game implementing the agent's ``observe``/``act`` seam.

    Levels are cleared one at a time; reaching a level's goal advances to the next level (a level
    transition) until the last level is cleared, which is the win. ``act(actions, expect=None)``
    applies the batch one action at a time and, when a per-action ``expect`` grid is supplied and
    the real next grid disagrees, stops with ``stop_reason='expect_mismatch'`` (mirroring the REPL
    budget guard) so the agent can route to DIVERGE/REPAIR.

    Counters (``actions_taken``, ``levels_completed``) are exposed for the smoke summary.
    """

    def __init__(
        self,
        levels: tuple[tuple[str, ...], ...] = _DEFAULT_LEVELS,
        budget: int = 100,
    ) -> None:
        if not levels:
            raise ValueError("ScriptedEnv requires at least one level.")
        self._levels = [list(rows) for rows in levels]
        self._level_index = 0
        self.remaining_actions = budget
        self.actions_taken = 0
        self.levels_completed = 0
        self._won = False
        self._load_level(0)

    # -- level geometry ---------------------------------------------------------------------------

    def _load_level(self, index: int) -> None:
        grid = _grid_from_rows(self._levels[index])
        self._rows = len(grid)
        self._cols = len(grid[0]) if grid else 0
        self._walls = frozenset(
            (r, c)
            for r in range(self._rows)
            for c in range(self._cols)
            if grid[r][c] == 1
        )
        self._avatar = next(
            (r, c)
            for r in range(self._rows)
            for c in range(self._cols)
            if grid[r][c] == 2
        )
        self._goal = next(
            (r, c)
            for r in range(self._rows)
            for c in range(self._cols)
            if grid[r][c] == 3
        )

    def _grid(self) -> list[list[int]]:
        grid = [[0] * self._cols for _ in range(self._rows)]
        for (r, c) in self._walls:
            grid[r][c] = 1
        gr, gc = self._goal
        grid[gr][gc] = 3
        ar, ac = self._avatar
        grid[ar][ac] = 2
        return grid

    def _at_goal(self) -> bool:
        return self._avatar == self._goal

    def _apply_one(self, action: str) -> bool:
        dr, dc = _DELTAS[action]
        ar, ac = self._avatar
        nr, nc = ar + dr, ac + dc
        if 0 <= nr < self._rows and 0 <= nc < self._cols and (nr, nc) not in self._walls:
            self._avatar = (nr, nc)
            return True
        return False

    # -- seam ---------------------------------------------------------------------------------------

    def observe(self) -> dict[str, Any]:
        return {
            "grid": self._grid(),
            "level": self._level_index + 1,
            "step": self.actions_taken,
            "valid_actions": list(_ACTIONS),
            "score": self.levels_completed,
            "remaining_actions": self.remaining_actions,
            "done": self._won,
        }

    def act(self, actions: list[Any], expect: list[Any] | None = None) -> dict[str, Any]:
        executed: list[Any] = []
        stop_reason = "completed"
        done = False
        level_transition = False

        for index, action in enumerate(actions):
            name = action.get("action") if isinstance(action, dict) else action
            name = str(name)
            self.remaining_actions = max(0, self.remaining_actions - 1)
            self.actions_taken += 1
            self._apply_one(name)
            executed.append(name)

            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                # UNKNOWN-aware: masked (partial-adoption) cells render UNKNOWN and are wildcards.
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break

            if self._at_goal():
                self.levels_completed += 1
                if self._level_index + 1 < len(self._levels):
                    # Advance to the next level: a level transition, not a win.
                    self._level_index += 1
                    self._load_level(self._level_index)
                    level_transition = True
                    stop_reason = "level_transition"
                else:
                    done = True
                    self._won = True
                    stop_reason = "done"
                break

        return {
            "current_frame": {
                "grid": self._grid(),
                "level": self._level_index + 1,
                "step": self.actions_taken,
                "score": self.levels_completed,
            },
            "action_result": {"score": self.levels_completed, "done": done},
            "valid_actions": list(_ACTIONS),
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "board_changed": bool(executed),
            "level_transition": level_transition,
            "done": done,
        }


# --------------------------------------------------------------------------------------------------
# ArcEnvAdapter — live ARC-AGI-3 surface (SDK isolated behind a lazy import)
# --------------------------------------------------------------------------------------------------

# The agent's reactive vocabulary uses the ARC action names ACTION1..ACTION6; the world-model path
# uses whatever legal_actions the synthesized program returns. The adapter maps the seam's ARC
# action names to the backend's action-invocation contract and back.
ARC_ACTIONS: tuple[str, ...] = (
    "ACTION1",
    "ACTION2",
    "ACTION3",
    "ACTION4",
    "ACTION5",
    "ACTION6",
)


def _lazy_import_arc_backend(name: str) -> Any:
    """Import the ARC-AGI-3 SDK/checkout backend lazily.

    Kept out of module import so the module (and ``--smoke``) stay SDK-free. Raises a clear
    :class:`RuntimeError` naming exactly what is missing when the real surface is requested.
    """

    import importlib

    try:
        return importlib.import_module(name)
    except Exception as exc:  # noqa: BLE001 - any import failure is a "not installed" for our purposes
        raise RuntimeError(
            f"ARC-AGI-3 live backend {name!r} is not importable ({exc!r}). "
            "The live path needs the ARC-AGI-3 SDK or an official benchmarking checkout on the "
            "Python path; install it (e.g. `pip install arc-agi`) or run offline with --smoke."
        ) from exc


class ArcEnvAdapter:
    """Wrap a live ARC-AGI-3 game backend behind the EwmAgent env seam.

    ``backend`` is any object exposing the ARC live-game contract the Mode B / official-checkout
    path drives:

        backend.reset() -> frame          (start / current frame)
        backend.step(arc_action) -> frame (apply one ARC action, return the resulting frame)

    where a *frame* is a dict carrying, under any of the tolerated aliases:

        grid:   ``grid`` | ``frame`` | ``state``      (list-of-lists of ints, or a nested [[...]] wrap)
        level:  ``level`` | ``level_index`` | ``guid``
        score:  ``score``
        actions:``available_actions`` | ``valid_actions`` | ``actions``   (ARC action names)
        done:   ``done`` | ``won`` | ``game_over``     (or state == 'WIN')

    Field names differ across ARC surfaces, so translation is defensive. When no ``backend`` is
    supplied, one is constructed lazily from ``backend_module`` (default ARC SDK candidates) — that
    import is where the clear RuntimeError fires if the SDK/checkout is absent.
    """

    def __init__(
        self,
        backend: Any = None,
        *,
        backend_module: str | None = None,
        game: str | None = None,
        daemon_url: str | None = None,
    ) -> None:
        self.game = game
        self.daemon_url = daemon_url
        if backend is None:
            module_name = backend_module or "arc_agi3"
            module = _lazy_import_arc_backend(module_name)
            factory = getattr(module, "make_env", None) or getattr(module, "Env", None)
            if factory is None:
                raise RuntimeError(
                    f"ARC backend module {module_name!r} exposes no make_env()/Env() live-game "
                    "factory; cannot start a live ARC-AGI-3 env."
                )
            backend = factory(game) if game is not None else factory()
        self.backend = backend
        self._last_frame: dict[str, Any] | None = None

    # -- frame <-> seam translation ----------------------------------------------------------------

    @staticmethod
    def _extract_grid(frame: dict[str, Any]) -> list[list[int]]:
        for key in ("grid", "frame", "state"):
            value = frame.get(key)
            if isinstance(value, list) and value:
                # Some ARC surfaces wrap the grid one level deeper as [[[...]]] (a stack of frames);
                # unwrap to the innermost list-of-list-of-ints.
                if value and isinstance(value[0], list) and value[0] and isinstance(value[0][0], list):
                    value = value[0]
                if isinstance(value[0], list):
                    return [list(row) for row in value]
        return []

    @staticmethod
    def _extract_actions(frame: dict[str, Any]) -> list[str]:
        for key in ("available_actions", "valid_actions", "actions"):
            value = frame.get(key)
            if isinstance(value, list) and value:
                return [ArcEnvAdapter._action_to_seam(a) for a in value]
        # Default to the full ARC action set when the frame does not enumerate them.
        return list(ARC_ACTIONS)

    @staticmethod
    def _action_to_seam(action: Any) -> str:
        """Normalize a backend action token to a seam ARC action name (``ACTIONk``)."""

        if isinstance(action, str):
            return action
        if isinstance(action, int):
            return f"ACTION{action}"
        # Enum-like: honor .name / .value.
        name = getattr(action, "name", None)
        if isinstance(name, str):
            return name
        value = getattr(action, "value", None)
        if isinstance(value, int):
            return f"ACTION{value}"
        return str(action)

    @staticmethod
    def _seam_action_to_arc(name: Any) -> str:
        """Translate a seam action name back to the ARC action token the backend expects.

        Reactive play emits ARC action names directly (``ACTION1``..``ACTION6``); these pass
        through. Any other token is forwarded as-is so a world-model program that names its own
        actions still reaches the backend.
        """

        return str(name.get("action") if isinstance(name, dict) else name)

    @staticmethod
    def _frame_done(frame: dict[str, Any]) -> bool:
        for key in ("done", "won", "game_over"):
            if bool(frame.get(key)):
                return True
        state = frame.get("state") or frame.get("status")
        if isinstance(state, str) and state.upper() in ("WIN", "WON"):
            return True
        return False

    def _to_seam_observation(self, frame: dict[str, Any]) -> dict[str, Any]:
        level = frame.get("level")
        if level is None:
            level = frame.get("level_index")
        return {
            "grid": self._extract_grid(frame),
            "level": level if level is not None else 1,
            "step": frame.get("step", frame.get("action_counter", 0)),
            "valid_actions": self._extract_actions(frame),
            "score": frame.get("score", 0),
            "remaining_actions": frame.get("remaining_actions"),
            "remaining_seconds": frame.get("remaining_seconds"),
            "done": self._frame_done(frame),
        }

    # -- seam --------------------------------------------------------------------------------------

    def observe(self) -> dict[str, Any]:
        frame = self.backend.reset() if self._last_frame is None else self._last_frame
        frame = frame if isinstance(frame, dict) else {}
        self._last_frame = frame
        return self._to_seam_observation(frame)

    def act(self, actions: list[Any], expect: list[Any] | None = None) -> dict[str, Any]:
        executed: list[str] = []
        frame: dict[str, Any] = self._last_frame or {}
        done = False
        for action in actions:
            arc_action = self._seam_action_to_arc(action)
            frame = self.backend.step(arc_action)
            frame = frame if isinstance(frame, dict) else {}
            executed.append(arc_action)
            self._last_frame = frame
            if self._frame_done(frame):
                done = True
                break

        seam_frame = self._to_seam_observation(frame)
        return {
            "current_frame": {
                "grid": seam_frame["grid"],
                "level": seam_frame["level"],
                "step": seam_frame["step"],
                "score": seam_frame["score"],
            },
            "action_result": {"score": seam_frame["score"], "done": done},
            "valid_actions": seam_frame["valid_actions"],
            "remaining_actions": seam_frame.get("remaining_actions"),
            "executed": executed,
            "stop_reason": "done" if done else "completed",
            "done": done,
        }


# --------------------------------------------------------------------------------------------------
# Smoke run
# --------------------------------------------------------------------------------------------------


class _SmokeLlm(FakeLlm):
    """A content-aware fake for the smoke run: authors the world model whenever a program is asked
    for, and returns a benign reflect otherwise.

    Probe-first seeding makes the reflect/decide call ordering data-dependent (the probe batch runs
    a variable number of real actions, each with a reflect call, BEFORE the first SYNTHESIZE decide).
    A positional script can't stay aligned under that, so this fake dispatches on the prompt: a
    SYNTHESIZE/REPAIR decide (which asks for a fenced program) always gets the correct source; every
    other call gets a benign prediction_ok reflect.
    """

    def __init__(self) -> None:
        super().__init__([])
        self._fenced = f"Here is the model:\n```python\n{TOY_GAME_SOURCE}\n```\n"
        self._reflect = '{"prediction_ok": true, "note": "matched"}'

    def chat(self, messages, max_tokens: int = 1024, temperature: float = 0.0):
        self.received.append(
            {"messages": messages, "max_tokens": max_tokens, "temperature": temperature}
        )
        self.calls += 1
        last = messages[-1]["content"] if messages else ""
        text = last if isinstance(last, str) else ""
        wants_program = "Current mode: SYNTHESIZE" in text or "Current mode: REPAIR" in text
        content = self._fenced if wants_program else self._reflect
        return {"content": content, "finish_reason": None, "raw": content}


def _smoke_llm() -> FakeLlm:
    """A content-aware fake that authors the correct world model on demand and reflects otherwise."""

    return _SmokeLlm()


def _make_artifacts_dir(game: str) -> str:
    """Allocate a per-run artifacts directory ``out/ewm-runs/{game}-{unix-ts}/`` (created lazily)."""

    return os.path.join("out", "ewm-runs", f"{game}-{int(time.time())}")


def smoke_run() -> dict[str, Any]:
    """Run the FULL EwmAgent loop with FakeLlm + ScriptedEnv + KB disabled; return a summary dict."""

    env = ScriptedEnv()
    llm = _smoke_llm()
    artifacts_dir = _make_artifacts_dir("scripted-toy")
    # KB disabled (kb=None) and vision off (no PIL dependency) keep the loop offline & deterministic.
    EwmAgent._vision_available = staticmethod(lambda: False)
    agent = EwmAgent(
        env,
        llm,
        kb=None,
        vision_enabled=False,
        config=AgentConfig(
            game_id="scripted-toy", max_turns=40, artifacts_dir=artifacts_dir,
            # Run-40: coverage persistence now has a KB-free LOCAL FILE store; keep the smoke run
            # stateless across invocations (pre-Run-40, kb=None alone made persistence a no-op).
            coverage_persistence=False,
        ),
    )
    summary = agent.run()

    modes_visited = sorted(set(summary.get("modes", [])))
    return {
        "artifacts_dir": artifacts_dir,
        "won": bool(summary.get("won")),
        "levels_completed": env.levels_completed,
        "actions_taken": env.actions_taken,
        "modes_visited": modes_visited,
        "program_adopted": bool(summary.get("program_accepted")),
        "decide_calls": summary.get("decide_calls", 0),
        "reflect_calls": summary.get("reflect_calls", 0),
        "synthesis_attempts": summary.get("synthesis_attempts", 0),
        "repair_attempts": summary.get("repair_attempts", 0),
        "suite_size": summary.get("suite_size", 0),
        "live_pass_rate": summary.get("live_pass_rate", 1.0),
    }


def _build_live_env(args: argparse.Namespace) -> ArcEnvAdapter:
    """Route --backend/--daemon-url to the generic live ARC adapter (raises if the SDK is absent)."""

    return ArcEnvAdapter(
        backend_module=args.backend,
        game=args.game,
        daemon_url=args.daemon_url,
    )


def _build_daemon_graph(game: str, artifacts_dir: str) -> Any:
    """Construct a :class:`~.synth_graph.DaemonGraph` for graph-native synthesis.

    Base URL comes from ``ZONOID_DAEMON_URL`` (default ``http://localhost:8787``); the workspace is
    the canonical zonoid checkout. ``data_dir`` points at the artifacts dir so task-minting stubs
    have a writable file-drop location. A daemon outage degrades every op to no-graph behavior (the
    DaemonGraph swallows HTTP errors), so this never blocks a live run.
    """

    from .synth_graph import DaemonGraph

    daemon_url = os.environ.get("ZONOID_DAEMON_URL", "http://localhost:8787")
    workspace = "/Users/imyu/Desktop/zonoid"
    return DaemonGraph(
        daemon_url,
        workspace,
        agent_id=f"ewm-synthgraph-{game}",
        session_id=f"ewm-synthgraph-{game}-{int(time.time())}",
        harness="local",
        data_dir=artifacts_dir,
    )


def _build_kb_gate(game: str) -> Any:
    """Construct a live KB :class:`~.kb_protocol.WriteGate` for the ORIENT warm-start path.

    Without a KB the agent's ORIENT/SYNTHESIZE searches are no-ops (``_kb_search`` returns [] when
    ``kb`` is None), so a program a prior run persisted for this game is never recalled. Wiring a
    real :class:`~.kb_protocol.KbClient` against ``ZONOID_DAEMON_URL`` + the canonical workspace lets
    ORIENT query ``game <id> world model program`` and adopt (or partial-adopt) a stored program.
    A daemon outage degrades to no-memory (every KbClient HTTP call swallows errors), so this never
    blocks a live run.
    """

    from .kb_protocol import KbClient, WriteGate

    daemon_url = os.environ.get("ZONOID_DAEMON_URL", "http://localhost:8787")
    workspace = "/Users/imyu/Desktop/zonoid"
    # Run-30: only a real user-supplied ZONOID_TASK_KEY may be wired into note writes. The
    # "ewm-live-<game>" fallback is not a graph task, and the daemon's phantom-node guard 404s any
    # wires_to naming it — which dropped run 30's five first-ever live interaction discoveries. The
    # synthetic key is kept for search-param tagging/logging; the client just omits wires_to.
    env_task_key = os.environ.get("ZONOID_TASK_KEY")
    task_key = env_task_key or f"ewm-live-{game}"
    # 60s (vs the 20s unit default): a live daemon under concurrent drains can take >20s to answer an
    # ORIENT /search or the native /note/get, and a timeout there silently drops the warm-start
    # program (the search error is swallowed to []). The generous budget keeps ORIENT's native
    # full-body read from timing out under load; a real outage still degrades to no-memory.
    return WriteGate(
        KbClient(
            daemon_url,
            workspace,
            task_key,
            timeout_s=60,
            synthetic_task_key=env_task_key is None,
        )
    )


def live_run(
    game: str,
    *,
    benchmarking_repo: str | None,
    max_actions: int,
    max_seconds: float,
    vision: bool = False,
    max_turns: int = 200,
    synth_model: str | None = None,
    graph: bool = False,
) -> dict[str, Any]:
    """Play ``game`` live on the official ARC-AGI-3 checkout with the ollama LlmClient.

    Builds a :class:`~.live.LiveArcSession` (SDK imported lazily from the checkout), an
    :class:`~.llm_client.LlmClient` from the environment (``ARC_LLM_BASE_URL`` / ``ARC_LLM_MODEL``),
    and runs the full :class:`~.agent.EwmAgent` loop against it. Returns a run-summary dict. Vision
    defaults OFF (the ollama backend is text-only). ``graph`` enables graph-native multi-step
    synthesis (config.graph_synthesis + a DaemonGraph client). The session is always closed
    (scorecard) even on error.
    """

    from .agent import EwmAgent
    from .live import build_live_session
    from .llm_client import LlmClient

    session = build_live_session(
        game,
        benchmarking_repo=benchmarking_repo,
        max_actions=max_actions,
        max_seconds=max_seconds,
    )
    artifacts_dir = _make_artifacts_dir(game)
    llm = LlmClient.from_env(timeout_s=300)
    # Optional per-role model for SYNTHESIZE/REPAIR: a second client on the SAME base_url/api_key
    # as the main llm, differing only in model id. None -> the agent falls back to the main llm.
    synth_llm = (
        LlmClient(llm.base_url, synth_model, api_key=llm.api_key, timeout_s=llm.timeout_s)
        if synth_model
        else None
    )
    graph_client = _build_daemon_graph(game, artifacts_dir) if graph else None
    kb_gate = _build_kb_gate(game)
    try:
        session.open()
        if not vision:
            EwmAgent._vision_available = staticmethod(lambda: False)
        agent = EwmAgent(
            session,
            llm,
            kb=kb_gate,
            vision_enabled=vision,
            config=AgentConfig(
                game_id=game,
                max_turns=max_turns,
                synth_llm=synth_llm,
                artifacts_dir=artifacts_dir,
                graph_synthesis=graph,
            ),
            graph=graph_client,
        )
        summary = agent.run()
        scorecard_url = session.scorecard_url()
        return {
            "game": game,
            "artifacts_dir": artifacts_dir,
            "won": bool(summary.get("won")),
            "levels_completed": session.levels_completed,
            "actions_taken": session.actions_taken,
            "decide_calls": summary.get("decide_calls", 0),
            "reflect_calls": summary.get("reflect_calls", 0),
            "modes_visited": sorted(set(summary.get("modes", []))),
            "program_adopted": bool(summary.get("program_accepted")),
            "program_synthesized": bool(summary.get("program_accepted")),
            "orient_adopted": bool(summary.get("orient_adopted")),
            "orient_diagnosis": summary.get("orient_diagnosis"),
            "orient_revalidation": summary.get("orient_revalidation"),
            "divergences": summary.get("reactive_turns", 0),
            "transitions": summary.get("transitions", 0),
            "synthesis_attempts": summary.get("synthesis_attempts", 0),
            "repair_attempts": summary.get("repair_attempts", 0),
            "suite_size": summary.get("suite_size", 0),
            "live_pass_rate": summary.get("live_pass_rate", 1.0),
            "stop_reason": summary.get("stop_reason"),
            "scorecard_url": scorecard_url,
            "max_actions": max_actions,
            "max_seconds": max_seconds,
            "vision": vision,
            "graph_synthesis": graph,
            "graph_synth_stats": summary.get("graph_synth_stats"),
            # Run-16 GOAL DISCOVERY + FAST PATH telemetry.
            "coverage_pct": summary.get("coverage_pct", 0.0),
            "actions_per_minute": summary.get("actions_per_minute", 0.0),
            "llm_calls_per_action": summary.get("llm_calls_per_action", 0.0),
            "frontier_batches": summary.get("frontier_batches", 0),
            "fast_path_batches": summary.get("fast_path_batches", 0),
            "reflect_skipped": summary.get("reflect_skipped", 0),
            "level_boundary_captured": summary.get("level_boundary_captured", False),
            "goal_note_written": summary.get("goal_note_written", False),
            "is_win_rederived": summary.get("is_win_rederived", False),
            "orient_kb_attempts": summary.get("orient_kb_attempts", 0),
            # Run-18 DIVERGENCE TOLERANCE telemetry.
            "transients_tolerated": summary.get("transients_tolerated", 0),
            "mask_auto_extensions": summary.get("mask_auto_extensions", 0),
            "repair_skips": summary.get("repair_skips", 0),
            # Run-19 INTERACTION DISCOVERY telemetry.
            "interactions_probed": summary.get("interactions_probed", 0),
            "interactions_found": summary.get("interactions_found", 0),
            # Run-20 BUMP PROBES + CROSS-RUN COVERAGE PERSISTENCE telemetry.
            "bumps_probed": summary.get("bumps_probed", 0),
            "bumps_found": summary.get("bumps_found", 0),
            # Run-32 MIN-BUMP HOIST telemetry: exploration batches run from the main turn loop in
            # place of a reactive/RECOVER turn to honor the min-bump floor. Run-38 extends the hoist
            # past the bump phase: hoisted_frontier_batches counts the FRONTIER batches hoisted once
            # the bump floor is met/exhausted (coverage growth, not luck-gated).
            "hoisted_bump_batches": summary.get("hoisted_bump_batches", 0),
            "hoisted_frontier_batches": summary.get("hoisted_frontier_batches", 0),
            # Run-39 REACH PROBES telemetry: hoisted walks that land the mover on rare special
            # cells (reach_arrived = the footprint actually covered the target on the live frame).
            "reach_probes": summary.get("reach_probes", 0),
            "reach_arrived": summary.get("reach_arrived", 0),
            # Run-40 HOIST PHASE echo: the last hoist phase that actually ran ("bump"/"reach"/
            # "frontier"/"stood_down"), so reach_probes=0 is diagnosable (no targets vs never engaged).
            "hoist_phase": summary.get("hoist_phase"),
            "coverage_resumed_pct": summary.get("coverage_resumed_pct", 0.0),
            "coverage_persisted": summary.get("coverage_persisted", False),
            # Run-23 SILENT-DROP DIAGNOSTICS + CONFIG ECHO: make a dropped field / no-op bump visible.
            "bump_due_batches": summary.get("bump_due_batches", 0),
            "bump_empty_batches": summary.get("bump_empty_batches", 0),
            "bump_skip_reason": summary.get("bump_skip_reason"),
            "player_colors": summary.get("player_colors"),
            # Run-27 EMPIRICAL APPROACH WALK telemetry: re-plans taken during per-step approach walks.
            "approach_retries": summary.get("approach_retries", 0),
            "config_echo": summary.get("config_echo"),
        }
    finally:
        session.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bench.arc_agi3_zonoid.ewm.driver",
        description="Bridge EwmAgent to a runnable ARC-AGI-3 env (offline smoke or live).",
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Run the full EwmAgent loop offline (FakeLlm + ScriptedEnv, KB disabled) and print a "
        "run-summary JSON line.",
    )
    parser.add_argument("--game", default=None, help="ARC game id for the live path (e.g. ls20).")
    parser.add_argument(
        "--backend",
        default=None,
        help="ARC backend module for the live path (default: ARC SDK candidate).",
    )
    parser.add_argument(
        "--daemon-url",
        default=None,
        help="Zonoid daemon URL for the live path.",
    )
    parser.add_argument(
        "--benchmarking-repo",
        default=None,
        help="Path to the official ARC-AGI-3 benchmarking checkout (or set "
        "ARC_BENCHMARKING_REPO). The ARC SDK is imported from here at runtime.",
    )
    parser.add_argument(
        "--max-actions",
        type=int,
        default=80,
        help="Hard cap on total actions submitted in a live run (default: 80).",
    )
    parser.add_argument(
        "--max-seconds",
        type=float,
        default=25 * 60,
        help="Hard wall-clock cap in seconds for a live run (default: 1500).",
    )
    parser.add_argument(
        "--vision",
        action="store_true",
        help="Enable vision composites (default off; the ollama backend is text-only).",
    )
    parser.add_argument(
        "--synth-model",
        default=None,
        help="Optional model id for SYNTHESIZE/REPAIR decide calls (same base_url as the main "
        "model). Reflect and reactive play stay on the main model.",
    )
    parser.add_argument(
        "--graph",
        choices=("on", "off"),
        default="off",
        help="Graph-native multi-step synthesis (default off). 'on' -> SYNTHESIZE delegates to a "
        "synth_graph.SynthSession backed by a DaemonGraph (ZONOID_DAEMON_URL, default "
        "http://localhost:8787).",
    )
    args = parser.parse_args(argv)

    if args.smoke:
        summary = smoke_run()
        print(json.dumps(summary))
        return 0

    if args.game and not args.backend:
        # Live path over the official checkout: run the full EwmAgent loop against a real game
        # session. build_live_session raises a clear RuntimeError when the checkout/SDK is absent.
        summary = live_run(
            args.game,
            benchmarking_repo=args.benchmarking_repo,
            max_actions=args.max_actions,
            max_seconds=args.max_seconds,
            vision=args.vision,
            synth_model=args.synth_model,
            graph=(args.graph == "on"),
        )
        print(json.dumps(summary))
        return 0

    if args.backend or args.daemon_url:
        # Generic backend-module path: construct the ARC adapter. This raises the clear
        # RuntimeError when the SDK/backend module is absent.
        env = _build_live_env(args)
        print(
            json.dumps(
                {
                    "live_env_ready": True,
                    "game": env.game,
                    "backend": args.backend,
                    "daemon_url": env.daemon_url,
                }
            )
        )
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
