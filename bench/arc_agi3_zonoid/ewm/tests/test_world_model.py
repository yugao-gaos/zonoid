"""Tests for the executable world-model kit (contract + regression suite + sandbox)."""

from __future__ import annotations

import unittest

from bench.arc_agi3_zonoid.ewm.world_model import (
    MaskedProgram,
    SandboxError,
    TransitionSuite,
    UNKNOWN,
    WorldModelProgram,
    masked_program,
    mismatch_mask,
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


# A partial-fidelity program that redefines UNKNOWN = -1 in its OWN source (shadowing the injected
# singleton) and renders -1 at the unmodelled corner cell. This is the exact ls20 shadowing defect:
# the identity check `is UNKNOWN` skips nothing, so validation must recognise the integer -1 alias.
UNKNOWN_ALIAS_GAME_SOURCE = TOY_GAME_SOURCE.replace(
    "AVATAR = 2",
    "UNKNOWN = -1\nAVATAR = 2",
).replace(
    "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n    return grid",
    "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n    grid[0][0] = UNKNOWN\n    return grid",
)


# --- Object-relative toy program: locate the avatar via segment() each step -----------------
#
# The mechanics are expressed relative to OBJECTS, not absolute indices: init_state just stores
# the raw grid; step() re-segments the grid, finds the single-pixel avatar (color 2) by color,
# moves it by the action's (dr, dc) unless it would leave the grid, and rewrites the grid;
# render() returns the stored grid. This exercises the injected segment() helper end-to-end.

OBJECT_RELATIVE_SOURCE = '''
AVATAR = 2

DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}


def _find_avatar(grid):
    seg = segment(grid)
    for node in seg["nodes"]:
        if node["color"] == AVATAR:
            # single-pixel avatar: its boundary is the one cell it occupies
            r, c = node["boundary"][0]
            return r, c
    return None


def init_state(frame):
    return {"grid": [list(row) for row in frame]}


def legal_actions(state):
    return ["UP", "DOWN", "LEFT", "RIGHT"]


def step(state, action):
    grid = [list(row) for row in state["grid"]]
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    pos = _find_avatar(grid)
    moved = False
    if pos is not None:
        r, c = pos
        dr, dc = DELTAS[action]
        nr, nc = r + dr, c + dc
        if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 0:
            grid[r][c] = 0
            grid[nr][nc] = AVATAR
            moved = True
    return {"grid": grid}, {"moved": moved}


def render(state):
    return [list(row) for row in state["grid"]]


def is_win(state):
    return False
'''


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

    def test_unknown_integer_alias_minus_one_skipped(self) -> None:
        # A program that shadows UNKNOWN with -1 (redefining it in its own source) and renders -1 at
        # an unmodelled cell must still validate: -1 is not a valid ARC color (0..15), so the diff
        # treats it as the UNKNOWN sentinel and skips that cell. Everything else matches -> pass.
        program = WorldModelProgram.load(UNKNOWN_ALIAS_GAME_SOURCE)
        suite = TransitionSuite()
        # (0,0) observed as a "9" the model can't predict; program renders -1 there -> skipped.
        suite.append(_grid("923"), "RIGHT", _grid("9.2"))
        report = validate(program, suite)
        self.assertTrue(report.ok, msg=f"unexpected mismatches: {report.mismatches}")
        self.assertEqual(report.pass_count, 1)

    def test_minus_one_only_skips_at_unmodelled_cells_real_mismatch_still_fails(self) -> None:
        # The -1 alias must not mask REAL mismatches: a modelled cell that disagrees still fails.
        # Here the avatar lands at (0,1) per the model, but the observed after-grid puts it at (0,2)
        # — a genuine mispredict at a cell neither side marks -1 — so validation must report it.
        program = WorldModelProgram.load(UNKNOWN_ALIAS_GAME_SOURCE)
        suite = TransitionSuite()
        suite.append(_grid("2.3"), "RIGHT", _grid("..2"))  # wrong: RIGHT lands at (0,1), not (0,2)
        report = validate(program, suite)
        self.assertFalse(report.ok)

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


class SegmentInjectionTests(unittest.TestCase):
    def test_segment_callable_from_loaded_program(self) -> None:
        # A program that returns segment(grid) directly from init_state proves the helper is in
        # the compiled namespace (same ns dict as UNKNOWN) and callable at runtime.
        source = (
            "def init_state(frame):\n"
            "    return segment(frame)\n"
            "def step(state, action):\n    return state, {}\n"
            "def render(state):\n    return state\n"
            "def is_win(state):\n    return False\n"
            "def legal_actions(state):\n    return []\n"
        )
        program = WorldModelProgram.load(source)
        result = program.init_state(_grid("2.3"))
        self.assertIn("nodes", result)
        self.assertIn("adjacency_list", result)
        colors = sorted(node["color"] for node in result["nodes"])
        # Colors present: 0 (background), 2 (avatar), 3 (goal).
        self.assertEqual(colors, [0, 2, 3])

    def test_segment_tolerates_unknown_cells(self) -> None:
        # A grid holding the UNKNOWN singleton and its -1 alias must not crash segment(); those
        # cells segment as the distinct color -1 rather than raising or merging into a neighbour.
        source = (
            "def init_state(frame):\n"
            "    return segment(frame)\n"
            "def step(state, action):\n    return state, {}\n"
            "def render(state):\n    return state\n"
            "def is_win(state):\n    return False\n"
            "def legal_actions(state):\n    return []\n"
        )
        program = WorldModelProgram.load(source)
        grid = [[UNKNOWN, 2], [-1, 0]]
        result = program.init_state(grid)
        colors = sorted(node["color"] for node in result["nodes"])
        # UNKNOWN and -1 both normalize to -1: one component of color -1 (they are 4-adjacent).
        self.assertIn(-1, colors)
        self.assertEqual(colors.count(-1), 1)


class ObjectRelativeProgramTests(unittest.TestCase):
    def test_object_relative_program_passes_movement_suite(self) -> None:
        # An OBJECT-RELATIVE program (finds the avatar via segment() by color, moves it by delta)
        # must validate against a suite of real movement transitions. avatar=2 on 0-background.
        program = WorldModelProgram.load(OBJECT_RELATIVE_SOURCE)
        suite = TransitionSuite()
        # RIGHT then DOWN on a 2x3 board; avatar starts top-left.
        suite.append(_grid("2..", "..."), "RIGHT", _grid(".2.", "..."))
        suite.append(_grid(".2.", "..."), "DOWN", _grid("...", ".2."))
        suite.append(_grid("...", ".2."), "LEFT", _grid("...", "2.."))
        # A move into the grid edge is a no-op (avatar stays put).
        suite.append(_grid("2..", "..."), "UP", _grid("2..", "..."))
        report = validate(program, suite)
        self.assertTrue(report.ok, msg=f"unexpected mismatches: {report.mismatches}, err={report.error}")
        self.assertEqual(report.pass_count, 4)


class MaskAndPartialAdoptionTests(unittest.TestCase):
    """masked_program / mismatch_mask — the partial-adoption primitives (Run-9 fix)."""

    def _wrong_right_suite(self) -> TransitionSuite:
        # WRONG_GAME_SOURCE swaps LEFT/RIGHT: a RIGHT transition mispredicts. On "2.3" a real RIGHT
        # yields ".23", but the wrong model tries to move the avatar LEFT (no-op at the edge), so it
        # renders "2.3": cells (0,0) and (0,1) mismatch.
        suite = TransitionSuite()
        suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        return suite

    def test_mismatch_mask_aggregates_all_wrong_cells(self) -> None:
        program = WorldModelProgram.load(WRONG_GAME_SOURCE)
        mask = mismatch_mask(program, self._wrong_right_suite())
        self.assertEqual(mask, {(0, 0), (0, 1)})

    def test_mismatch_mask_empty_for_correct_program(self) -> None:
        program = WorldModelProgram.load(TOY_GAME_SOURCE)
        self.assertEqual(mismatch_mask(program, self._wrong_right_suite()), set())

    def test_mismatch_mask_unions_across_transitions(self) -> None:
        # Two transitions whose mismatches fall on DIFFERENT cells must union into one mask.
        program = WorldModelProgram.load(WRONG_GAME_SOURCE)
        suite = TransitionSuite()
        suite.append(_grid("2.3"), "RIGHT", _grid(".23"))    # real RIGHT: mismatches (0,0),(0,1)
        # Real LEFT on "32." (goal col0, avatar col1) moves the avatar onto col0 -> "2.." (avatar on
        # top of goal). The wrong model moves RIGHT to col2 -> "3.2", mismatching cell (0,2) (new).
        suite.append(_grid("32."), "LEFT", _grid("2.."))
        mask = mismatch_mask(program, suite)
        self.assertIn((0, 0), mask)
        self.assertIn((0, 1), mask)
        self.assertIn((0, 2), mask)

    def test_masked_program_passes_suite_the_inner_fails(self) -> None:
        inner = WorldModelProgram.load(WRONG_GAME_SOURCE)
        suite = self._wrong_right_suite()
        self.assertFalse(validate(inner, suite).ok)
        wrapped = masked_program(inner, mismatch_mask(inner, suite))
        report = validate(wrapped, suite)
        self.assertTrue(report.ok, msg=f"mismatches: {report.mismatches}")

    def test_masked_render_places_unknown_at_masked_cells_only(self) -> None:
        inner = WorldModelProgram.load(TOY_GAME_SOURCE)
        wrapped = masked_program(inner, {(0, 0)})
        state = wrapped.init_state(_grid("2.3"))
        grid = wrapped.render(state)
        self.assertIs(grid[0][0], UNKNOWN)
        # Every other cell is delegated unchanged from the inner render.
        self.assertEqual(grid[0][1], 0)
        self.assertEqual(grid[0][2], 3)

    def test_masked_program_source_delegates_to_inner(self) -> None:
        inner = WorldModelProgram.load(TOY_GAME_SOURCE)
        wrapped = masked_program(inner, {(0, 0)})
        self.assertIsInstance(wrapped, MaskedProgram)
        self.assertEqual(wrapped.source, inner.source)

    def test_masked_program_does_not_mutate_inner_state(self) -> None:
        # Rendering through the mask must not corrupt the inner program's own render.
        inner = WorldModelProgram.load(TOY_GAME_SOURCE)
        wrapped = masked_program(inner, {(0, 0)})
        state = inner.init_state(_grid("2.3"))
        _ = wrapped.render(state)
        self.assertEqual(inner.render(state)[0][0], 2)  # inner still sees the avatar, not UNKNOWN


if __name__ == "__main__":
    unittest.main()
