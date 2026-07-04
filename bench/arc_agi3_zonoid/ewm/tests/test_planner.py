"""Tests for the EWM planner (BFS goal search + seeded rollout fallback)."""

from __future__ import annotations

import unittest

from bench.arc_agi3_zonoid.ewm.planner import (
    PlanResult,
    explore_frontier,
    plan,
    rollout_search,
)
from bench.arc_agi3_zonoid.ewm.tests.test_world_model import TOY_GAME_SOURCE, _grid
from bench.arc_agi3_zonoid.ewm.world_model import (
    UNKNOWN,
    WorldModelProgram,
    masked_program,
)


def _at_goal(state) -> bool:
    return state["avatar"] == state["goal"]


class PlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.program = WorldModelProgram.load(TOY_GAME_SOURCE)

    def test_bfs_finds_shortest_path(self) -> None:
        # Avatar (0,0), goal (0,2), open row: shortest is two RIGHTs.
        frame = _grid("2.3")
        result = plan(self.program, frame, _at_goal)
        self.assertIsNotNone(result)
        assert result is not None  # for type-checkers
        self.assertEqual(len(result.actions), 2)
        self.assertEqual(result.actions, ["RIGHT", "RIGHT"])

    def test_predicted_grids_match_manual_simulation(self) -> None:
        frame = _grid("2.3")
        result = plan(self.program, frame, _at_goal)
        assert result is not None
        # After RIGHT: avatar at (0,1); after RIGHT again: avatar at (0,2)==goal.
        self.assertEqual(result.predicted_grids[0], _grid(".23"))
        self.assertEqual(result.predicted_grids[1], _grid("..2"))
        self.assertEqual(len(result.predicted_grids), len(result.actions))

    def test_bfs_routes_around_wall(self) -> None:
        # Wall at (0,1) forces a detour down/right/up. Grid:
        #   2 1 3
        #   . . .
        frame = _grid("213", "...")
        result = plan(self.program, frame, _at_goal)
        assert result is not None
        # Shortest detour is DOWN, RIGHT, RIGHT, UP (4 moves).
        self.assertEqual(len(result.actions), 4)
        # Replaying the actions from the start reaches the goal.
        state = self.program.init_state(frame)
        for action in result.actions:
            state, _ = self.program.step(state, action)
        self.assertTrue(self.program.is_win(state))

    def test_already_at_goal(self) -> None:
        # Avatar already on goal: empty plan.
        frame = _grid("2")
        # Overlap avatar+goal by placing goal under avatar via a 1x1 win: avatar==goal.
        program = WorldModelProgram.load(
            TOY_GAME_SOURCE.replace(
                "    return {\"avatar\": avatar, \"goal\": goal,",
                "    goal = avatar if goal is None else goal\n"
                "    return {\"avatar\": avatar, \"goal\": goal,",
            )
        )
        result = plan(program, frame, _at_goal)
        self.assertEqual(result, PlanResult(actions=[], predicted_grids=[]))

    def test_unreachable_returns_none_within_budget(self) -> None:
        # Goal walled off completely -> no plan. Grid:
        #   2 1 3
        #   . 1 .
        #   . 1 .
        # Column of walls separates avatar (left) from goal (right).
        frame = _grid("213", ".1.", ".1.")
        result = plan(self.program, frame, _at_goal, max_nodes=5000)
        self.assertIsNone(result)


class MaskedProgramPlanTests(unittest.TestCase):
    """Planner over a partially-adopted (masked) program: UNKNOWN cells in rendered grids must not
    break BFS state hashing (the injected UNKNOWN singleton is hashable/stable in-process)."""

    def test_bfs_finds_path_with_unknown_masked_cell(self) -> None:
        # Mask the bottom-left corner (stays UNKNOWN every step, so it does not perturb the search
        # beyond adding a constant sentinel to every grid key). BFS must still solve "2.3".
        inner = WorldModelProgram.load(TOY_GAME_SOURCE)
        program = masked_program(inner, {(0, 0)})
        result = plan(program, _grid("2.3"), _at_goal)
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result.actions, ["RIGHT", "RIGHT"])
        # The masked cell renders UNKNOWN in every predicted grid and is hashable in the visited set.
        for grid in result.predicted_grids:
            self.assertIs(grid[0][0], UNKNOWN)

    def test_grid_key_hashes_unknown_singleton_stably(self) -> None:
        # The BFS visited-set relies on _grid_key being hashable with UNKNOWN cells present.
        from bench.arc_agi3_zonoid.ewm.planner import _grid_key

        k1 = _grid_key([[UNKNOWN, 0], [3, 2]])
        k2 = _grid_key([[UNKNOWN, 0], [3, 2]])
        self.assertEqual(k1, k2)
        self.assertEqual(len({k1, k2}), 1)  # hashable and identical


class RolloutSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.program = WorldModelProgram.load(TOY_GAME_SOURCE)

    def _neg_manhattan(self, state) -> float:
        (ar, ac) = state["avatar"]
        (gr, gc) = state["goal"]
        return -(abs(ar - gr) + abs(ac - gc))

    def test_seed_deterministic(self) -> None:
        frame = _grid("2..3")
        a = rollout_search(self.program, frame, self._neg_manhattan, n_rollouts=20, max_depth=6, seed=7)
        b = rollout_search(self.program, frame, self._neg_manhattan, n_rollouts=20, max_depth=6, seed=7)
        self.assertEqual(a.actions, b.actions)
        self.assertEqual(a.predicted_grids, b.predicted_grids)

    def test_different_seed_may_differ_but_both_valid(self) -> None:
        frame = _grid("2..3")
        result = rollout_search(
            self.program, frame, self._neg_manhattan, n_rollouts=50, max_depth=8, seed=1
        )
        # Predicted grids track the action prefix length.
        self.assertEqual(len(result.predicted_grids), len(result.actions))
        # Replaying the prefix from start reproduces the final predicted grid.
        if result.actions:
            state = self.program.init_state(frame)
            for action in result.actions:
                state, _ = self.program.step(state, action)
            self.assertEqual(self.program.render(state), result.predicted_grids[-1])

    def test_rollout_improves_toward_goal(self) -> None:
        # With enough rollouts the best prefix should move the avatar strictly closer to the goal.
        frame = _grid("2...3")
        result = rollout_search(
            self.program, frame, self._neg_manhattan, n_rollouts=200, max_depth=10, seed=42
        )
        start = self.program.init_state(frame)
        start_dist = -self._neg_manhattan(start)
        state = start
        for action in result.actions:
            state, _ = self.program.step(state, action)
        end_dist = -self._neg_manhattan(state)
        self.assertLess(end_dist, start_dist)


class ExploreFrontierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.program = WorldModelProgram.load(TOY_GAME_SOURCE)

    def _visited_player_cells(self, frame, result: PlanResult) -> set:
        """Replay a frontier plan and collect the cells the player (differs from start) occupied."""

        start = self.program.init_state(frame)
        start_grid = self.program.render(start)
        visited = set()
        for grid in result.predicted_grids:
            for r, (srow, row) in enumerate(zip(start_grid, grid)):
                for c, (s, v) in enumerate(zip(srow, row)):
                    if s != v:
                        visited.add((r, c))
        return visited

    def test_frontier_reaches_unvisited_regions(self) -> None:
        # An open 1x5 corridor with the goal at the far end: from (0,0) the explorer should drive the
        # avatar across new cells, covering more distinct player cells than a single step would.
        frame = _grid("2...3")
        result = explore_frontier(self.program, frame, max_depth=10)
        self.assertIsNotNone(result)
        assert result is not None
        visited = self._visited_player_cells(frame, result)
        # The avatar starts at (0,0); frontier exploration should reach the far end (new ground).
        self.assertIn((0, 3), visited)
        self.assertGreaterEqual(len(visited), 3)

    def test_frontier_prefix_is_a_valid_reachable_walk(self) -> None:
        frame = _grid("2...3")
        result = explore_frontier(self.program, frame, max_depth=10)
        assert result is not None
        # Every predicted grid must be the program's real render after the corresponding action.
        state = self.program.init_state(frame)
        for action, expected in zip(result.actions, result.predicted_grids):
            state, _ = self.program.step(state, action)
            self.assertEqual(self.program.render(state), expected)

    def test_frontier_detects_toy_level_transition_by_reaching_goal(self) -> None:
        # The frontier walk over the toy level's reachable graph must include the goal cell (0,2):
        # driving into it is exactly the level-boundary transition GOAL DISCOVERY watches for.
        frame = _grid("2.3")
        result = explore_frontier(self.program, frame, max_depth=10)
        assert result is not None
        state = self.program.init_state(frame)
        reached_goal = False
        for action in result.actions:
            state, _ = self.program.step(state, action)
            if self.program.is_win(state):
                reached_goal = True
                break
        self.assertTrue(reached_goal)

    def test_frontier_returns_none_when_no_move_possible(self) -> None:
        # Avatar (1,1) boxed in by walls on all four sides: no action moves it, nothing to explore.
        # Goal at (0,0) exists so the program still renders.
        frame = _grid("31.", "121", ".1.")
        result = explore_frontier(self.program, frame, max_depth=5)
        self.assertIsNone(result)

    def test_frontier_is_deterministic(self) -> None:
        frame = _grid("2...3")
        a = explore_frontier(self.program, frame, max_depth=10)
        b = explore_frontier(self.program, frame, max_depth=10)
        assert a is not None and b is not None
        self.assertEqual(a.actions, b.actions)


if __name__ == "__main__":
    unittest.main()
