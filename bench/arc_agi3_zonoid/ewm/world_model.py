"""Executable world-model kit for the ARC-AGI-3 EWM agent (Pillar 4).

An LLM synthesizes a Python program that models a game. The program must define the contract:

    init_state(frame)         -> state
    step(state, action)       -> (state, events)
    render(state)             -> grid
    is_win(state)             -> bool
    legal_actions(state)      -> list[action]

Grids are lists-of-lists of ints (grid-in / grid-out). Programs may declare PARTIAL FIDELITY:
render() may place the ``UNKNOWN`` sentinel in cells it cannot predict, and step() may return
events containing ``{"unknown": [..attribute names..]}``. The validator skips UNKNOWN cells.

Every observed real transition ``(before_grid, action, after_grid)`` becomes a regression test.
``validate`` replays them all through init_state + step and reports the FIRST failure with an
object-level (cell) diff.

The program source runs in a restricted namespace: a stdlib import whitelist only, and no
file/network/eval builtins.
"""

from __future__ import annotations

import builtins as _builtins
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator


# Sentinel a program may place in rendered cells (or name in event "unknown" lists) to mark a
# region/attribute it does not model. Distinct object so it never collides with a real int cell.
class _Unknown:
    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return "UNKNOWN"

    def __reduce__(self):  # keep the singleton identity across copy/deepcopy
        return (_get_unknown, ())


UNKNOWN = _Unknown()


def _get_unknown() -> _Unknown:
    return UNKNOWN


# stdlib modules a synthesized program is allowed to import. Deliberately small and pure.
ALLOWED_IMPORTS: frozenset[str] = frozenset(
    {"collections", "itertools", "math", "json", "copy", "heapq", "functools"}
)

Grid = list[list[Any]]
Action = Any


class SandboxError(RuntimeError):
    """Raised when program source violates the sandbox (import/builtin) policy."""


def _guarded_import(
    name: str,
    globals=None,
    locals=None,
    fromlist=(),
    level: int = 0,
):
    root = name.split(".", 1)[0]
    if level != 0 or root not in ALLOWED_IMPORTS:
        raise SandboxError(f"import of {name!r} is not permitted in the sandbox")
    return __import__(name, globals, locals, fromlist, level)


# Builtins a program may use. No open/exec/eval/compile/input/__import__(raw)/etc.
_SAFE_BUILTIN_NAMES = (
    "abs",
    "all",
    "any",
    "bool",
    "dict",
    "divmod",
    "enumerate",
    "filter",
    "float",
    "frozenset",
    "int",
    "len",
    "list",
    "map",
    "max",
    "min",
    "range",
    "reversed",
    "round",
    "set",
    "sorted",
    "str",
    "sum",
    "tuple",
    "zip",
    "True",
    "False",
    "None",
    "Exception",
    "ValueError",
    "KeyError",
    "IndexError",
    "TypeError",
)


def _build_safe_builtins() -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for attr in _SAFE_BUILTIN_NAMES:
        if hasattr(_builtins, attr):
            safe[attr] = getattr(_builtins, attr)
    safe["__import__"] = _guarded_import
    return safe


_CONTRACT_NAMES = ("init_state", "step", "render", "is_win", "legal_actions")


@dataclass
class WorldModelProgram:
    """A compiled LLM-authored world-model program exposing the contract functions."""

    source: str
    _ns: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, source: str) -> "WorldModelProgram":
        """Compile ``source`` in a restricted namespace and verify the contract is defined."""

        try:
            code = compile(source, "<world_model>", "exec")
        except SyntaxError as exc:
            raise SandboxError(f"program does not compile: {exc}") from exc

        ns: dict[str, Any] = {"UNKNOWN": UNKNOWN, "__builtins__": _build_safe_builtins()}
        try:
            exec(code, ns)  # noqa: S102 - intentional restricted exec
        except SandboxError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SandboxError(f"program failed to initialize: {exc!r}") from exc

        missing = [name for name in _CONTRACT_NAMES if not callable(ns.get(name))]
        if missing:
            raise SandboxError(f"program is missing contract functions: {missing}")

        return cls(source=source, _ns=ns)

    def _fn(self, name: str) -> Callable[..., Any]:
        return self._ns[name]

    def init_state(self, frame: Grid) -> Any:
        return self._fn("init_state")(frame)

    def step(self, state: Any, action: Action) -> tuple[Any, Any]:
        return self._fn("step")(state, action)

    def render(self, state: Any) -> Grid:
        return self._fn("render")(state)

    def is_win(self, state: Any) -> bool:
        return bool(self._fn("is_win")(state))

    def legal_actions(self, state: Any) -> list[Action]:
        return list(self._fn("legal_actions")(state))


@dataclass
class Transition:
    """One observed real transition: applying ``action`` to ``before_grid`` yielded ``after_grid``."""

    before_grid: Grid
    action: Action
    after_grid: Grid

    def to_dict(self) -> dict[str, Any]:
        return {
            "before_grid": self.before_grid,
            "action": self.action,
            "after_grid": self.after_grid,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Transition":
        return cls(
            before_grid=data["before_grid"],
            action=data["action"],
            after_grid=data["after_grid"],
        )


@dataclass
class TransitionSuite:
    """An ordered, (de)serializable collection of observed transitions used as regression tests."""

    transitions: list[Transition] = field(default_factory=list)

    def append(self, before_grid: Grid, action: Action, after_grid: Grid) -> None:
        self.transitions.append(Transition(before_grid, action, after_grid))

    def __len__(self) -> int:
        return len(self.transitions)

    def __iter__(self) -> Iterator[Transition]:
        return iter(self.transitions)

    def __getitem__(self, index: int) -> Transition:
        return self.transitions[index]

    def to_json(self, *, indent: int | None = None) -> str:
        return json.dumps([t.to_dict() for t in self.transitions], indent=indent)

    @classmethod
    def from_json(cls, text: str) -> "TransitionSuite":
        data = json.loads(text)
        return cls(transitions=[Transition.from_dict(item) for item in data])


@dataclass
class ValidationReport:
    """Result of replaying a suite against a program; ``ok`` iff every transition matched."""

    ok: bool
    pass_count: int
    total: int
    fail_index: int | None = None
    fail_action: Action = None
    mismatches: list[tuple[int, int, Any, Any]] = field(default_factory=list)
    error: str | None = None

    @property
    def pass_rate(self) -> float:
        return self.pass_count / self.total if self.total else 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "pass_count": self.pass_count,
            "total": self.total,
            "pass_rate": self.pass_rate,
            "fail_index": self.fail_index,
            "fail_action": self.fail_action,
            "mismatches": [list(m) for m in self.mismatches],
            "error": self.error,
        }


def _grid_shape(grid: Grid) -> tuple[int, int]:
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    return rows, cols


def _diff_grids(expected: Grid, got: Grid) -> list[tuple[int, int, Any, Any]]:
    """Cell-level diff of ``got`` vs ``expected``, skipping any cell where either side is UNKNOWN.

    Shape mismatches surface as a single sentinel-row diff at (-1, -1).
    """

    if _grid_shape(expected) != _grid_shape(got):
        return [(-1, -1, _grid_shape(expected), _grid_shape(got))]

    mismatches: list[tuple[int, int, Any, Any]] = []
    for r, (exp_row, got_row) in enumerate(zip(expected, got)):
        for c, (exp, act) in enumerate(zip(exp_row, got_row)):
            if exp is UNKNOWN or act is UNKNOWN:
                continue
            if exp != act:
                mismatches.append((r, c, exp, act))
    return mismatches


def validate(program: WorldModelProgram, suite: TransitionSuite) -> ValidationReport:
    """Replay every transition through the program, stopping at the FIRST mismatch.

    For each transition we ``init_state(before_grid)``, ``step`` it with the action, then compare
    ``render(next_state)`` to ``after_grid`` ignoring UNKNOWN cells. The report carries the first
    failing index/action and its cell-level diff, plus running pass counts.
    """

    total = len(suite)
    pass_count = 0

    for index, transition in enumerate(suite):
        try:
            state = program.init_state(transition.before_grid)
            next_state, _events = program.step(state, transition.action)
            got = program.render(next_state)
        except Exception as exc:  # noqa: BLE001 - a crashing program is a validation failure
            return ValidationReport(
                ok=False,
                pass_count=pass_count,
                total=total,
                fail_index=index,
                fail_action=transition.action,
                mismatches=[],
                error=f"{type(exc).__name__}: {exc}",
            )

        mismatches = _diff_grids(transition.after_grid, got)
        if mismatches:
            return ValidationReport(
                ok=False,
                pass_count=pass_count,
                total=total,
                fail_index=index,
                fail_action=transition.action,
                mismatches=mismatches,
            )
        pass_count += 1

    return ValidationReport(ok=True, pass_count=pass_count, total=total)
