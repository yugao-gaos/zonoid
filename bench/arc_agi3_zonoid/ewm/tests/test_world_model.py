"""Tests for the executable world-model kit (contract + regression suite + sandbox)."""

from __future__ import annotations

import unittest

from bench.arc_agi3_zonoid.ewm.world_model import (
    SandboxError,
    TransitionSuite,
    UNKNOWN,
    WorldModelProgram,
    validate,
)


# --- Toy game program source (avatar=2 on 0-cells, wall=1 blocks, goal=3) --------------------
#
# State is a dict {"avatar": (r, c), "walls": frozenset, "goal": (r, c), "rows", "cols"}.
# Actions UP/DOWN/LEFT/RIGHT move the avatar one cell; moving into a wall or off-grid is a no-op.

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


# A deliberately wrong program: LEFT and RIGHT are swapped, so a RIGHT transition mispredicts.
WRONG_GAME_SOURCE = TOY_GAME_SOURCE.replace(
    'DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}',
    'DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, 1), "RIGHT": (0, -1)}',
)


# A partial-fidelity program: render() marks the top-left corner cell UNKNOWN.
UNKNOWN_GAME_SOURCE = TOY_GAME_SOURCE.replace(
    "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n    return grid",
    "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n    grid[0][0] = UNKNOWN\n    return grid",
)


def _grid(*rows: str) -> list[list[int]]:
    """Build an int grid from compact string rows ('.'=0, digits as-is)."""

    out = []
    for row in rows:
        out.append([0 if ch == "." else int(ch) for ch in row])
    return out


class LoadContractTests(unittest.TestCase):
    def test_load_exposes_contract(self) -> None:
        program = WorldModelProgram.load(TOY_GAME_SOURCE)
        frame = _grid("2.3")
        state = program.init_state(frame)
        self.assertEqual(program.render(state), frame)
        self.assertEqual(sorted(program.legal_actions(state)), ["DOWN", "LEFT", "RIGHT", "UP"])
        self.assertFalse(program.is_win(state))

    def test_missing_contract_rejected(self) -> None:
        with self.assertRaises(SandboxError):
            WorldModelProgram.load("def init_state(frame):\n    return frame\n")


class ValidateTests(unittest.TestCase):
    def _suite(self) -> TransitionSuite:
        # Avatar at (0,0), goal at (0,2). One RIGHT step: (0,0) -> (0,1).
        suite = TransitionSuite()
        suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        # From that position, another RIGHT reaches the goal.
        suite.append(_grid(".23"), "RIGHT", _grid("..2"))
        return suite

    def test_correct_program_passes(self) -> None:
        program = WorldModelProgram.load(TOY_GAME_SOURCE)
        report = validate(program, self._suite())
        self.assertTrue(report.ok)
        self.assertEqual(report.pass_count, 2)
        self.assertEqual(report.total, 2)
        self.assertEqual(report.pass_rate, 1.0)
        self.assertIsNone(report.fail_index)

    def test_wrong_program_reports_first_mismatch(self) -> None:
        program = WorldModelProgram.load(WRONG_GAME_SOURCE)
        report = validate(program, self._suite())
        self.assertFalse(report.ok)
        # First transition already fails: RIGHT should land avatar at (0,1) but swapped delta
        # keeps it at (0,0) (a LEFT into the grid edge is a no-op).
        self.assertEqual(report.fail_index, 0)
        self.assertEqual(report.fail_action, "RIGHT")
        self.assertEqual(report.pass_count, 0)
        # Expected after_grid ".23": (0,0)=0, (0,1)=2. Got "2.3": (0,0)=2, (0,1)=0.
        self.assertIn((0, 0, 0, 2), report.mismatches)
        self.assertIn((0, 1, 2, 0), report.mismatches)

    def test_unknown_cells_skipped(self) -> None:
        program = WorldModelProgram.load(UNKNOWN_GAME_SOURCE)
        # after_grid has a *different* value at (0,0) than the program would render, but the
        # program marks (0,0) UNKNOWN, so validation must ignore it and still pass.
        suite = TransitionSuite()
        # Avatar (0,1) -> RIGHT -> (0,2)==goal. (0,0) in observed grid is a "9" the model can't
        # predict; the program renders UNKNOWN there, so validation must ignore that cell.
        suite.append(_grid("923"), "RIGHT", _grid("9.2"))
        report = validate(program, suite)
        self.assertTrue(report.ok, msg=f"unexpected mismatches: {report.mismatches}")
        self.assertEqual(report.pass_count, 1)

    def test_unknown_sentinel_survives_events(self) -> None:
        # A program may name UNKNOWN attributes in its step() events; the sentinel is exported.
        program = WorldModelProgram.load(TOY_GAME_SOURCE)
        state = program.init_state(_grid("2.3"))
        _next_state, events = program.step(state, "RIGHT")
        self.assertIn("moved", events)
        self.assertIsNot(UNKNOWN, None)


class SuiteSerializationTests(unittest.TestCase):
    def test_json_round_trip(self) -> None:
        suite = TransitionSuite()
        suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        suite.append(_grid(".23"), "DOWN", _grid(".23"))
        text = suite.to_json()
        restored = TransitionSuite.from_json(text)
        self.assertEqual(len(restored), 2)
        self.assertEqual(restored[0].action, "RIGHT")
        self.assertEqual(restored[1].before_grid, _grid(".23"))
        # Iteration yields the same transitions in order.
        actions = [t.action for t in restored]
        self.assertEqual(actions, ["RIGHT", "DOWN"])


class SandboxTests(unittest.TestCase):
    def test_import_os_rejected(self) -> None:
        with self.assertRaises(SandboxError):
            WorldModelProgram.load("import os\n")

    def test_open_rejected(self) -> None:
        source = (
            "def init_state(frame):\n"
            "    return open('/etc/passwd')\n"
            "def step(state, action):\n    return state, {}\n"
            "def render(state):\n    return state\n"
            "def is_win(state):\n    return False\n"
            "def legal_actions(state):\n    return []\n"
        )
        program = WorldModelProgram.load(source)
        with self.assertRaises(NameError):
            # open is not in the sandbox builtins -> NameError at call time.
            program.init_state([[0]])

    def test_allowed_import_ok(self) -> None:
        # A whitelisted import (collections) must load fine.
        source = TOY_GAME_SOURCE.replace("import copy", "import copy\nimport collections")
        program = WorldModelProgram.load(source)
        self.assertTrue(callable(program.render))


if __name__ == "__main__":
    unittest.main()
