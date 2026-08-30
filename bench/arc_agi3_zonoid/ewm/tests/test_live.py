"""Tests for the live ARC-AGI-3 game-session env (:mod:`bench.arc_agi3_zonoid.ewm.live`).

All tests run offline: a fake game client stands in for the official checkout's
``arc_agi``/``arcengine`` surface, so no network/SDK is required. Coverage:

* FrameDataRaw-like frame -> seam observation translation (grid/level/score/actions/done).
* seam ``ACTIONk`` names -> game-action submission; complex ACTION6 coord pass-through.
* session lifecycle: open (scorecard + reset), level transition, win, close.
* hard caps: max_actions and max_seconds surfaced through the seam and enforced in act().
* module import is SDK-free.
"""

from __future__ import annotations

import importlib
import os
import sys
import unittest
from unittest import mock

from bench.arc_agi3_zonoid.ewm import live as live_mod
from bench.arc_agi3_zonoid.ewm.live import (
    ARC_ACTIONS,
    ENV_BENCHMARKING_REPO,
    LiveArcSession,
    add_checkout_to_path,
)


# --------------------------------------------------------------------------------------------------
# Fakes standing in for the checkout's FrameDataRaw / EnvironmentWrapper / arc client.
# --------------------------------------------------------------------------------------------------


class _FakeState:
    """Enum-like GameState stand-in with a ``.name``."""

    def __init__(self, name: str) -> None:
        self.name = name


class _FakeFrame:
    """FrameDataRaw-like: ``.frame`` is a list of grids (each a list-of-lists), ``.state`` has ``.name``.

    ``grid`` is a 2D list; ``.frame`` returns a one-element animation stack ``[grid]`` (mirroring
    FrameDataRaw, whose ``.frame`` is a list of numpy 2D arrays).
    """

    def __init__(self, grid, levels_completed, state, available_actions):
        self._grids = [grid]
        self.levels_completed = levels_completed
        self.state = _FakeState(state)
        self.available_actions = available_actions

    @property
    def frame(self):
        return self._grids


class _FakeGameAction:
    def __init__(self, name, complex_=False, data=None):
        self.name = name
        self._complex = complex_
        self.data = data

    def is_complex(self):
        return self._complex

    def set_data(self, data):
        self.data = data
        return self


class _FakeArcWrapper:
    """A one-line corridor: RESET puts avatar at col 0, ACTION3 walks it right; last col wins level.

    ``levels`` is the number of corridor clears before the game reaches WIN. Records every action
    submitted (as GameAction objects) so tests can assert coord pass-through.
    """

    def __init__(self, width=3, levels=1):
        self.width = width
        self.total_levels = levels
        self.pos = 0
        self.levels_completed = 0
        self.state = "NOT_PLAYED"
        self.submitted: list = []
        self._last = None

    def _frame(self):
        row = [0] * self.width
        row[self.pos] = 2
        if self.pos != self.width - 1:
            row[self.width - 1] = 3
        actions = [1, 3]  # ACTION1, ACTION3 (as ARC ints)
        self._last = _FakeFrame([row], self.levels_completed, self.state, actions)  # 2D grid
        return self._last

    def step(self, action):
        self.submitted.append(action)
        name = action.name
        if name == "RESET":
            self.pos = 0
            self.state = "NOT_FINISHED"
            return self._frame()
        if name == "ACTION3" and self.pos < self.width - 1:
            self.pos += 1
        if self.pos == self.width - 1:
            self.levels_completed += 1
            if self.levels_completed >= self.total_levels:
                self.state = "WIN"
            else:
                self.pos = 0  # next corridor
        return self._frame()

    @property
    def observation_space(self):
        return self._last


class _FakeArcClient:
    """Implements the ArcClient surface over a _FakeArcWrapper (no network)."""

    def __init__(self, wrapper):
        self._wrapper = wrapper
        self.opened_tags = None
        self.closed = None

    def open_scorecard(self, tags=None):
        self.opened_tags = tags
        return "card-123"

    def make(self, game_id, card_id):
        self._wrapper.game_id = game_id
        self._wrapper.card_id = card_id
        return self._wrapper

    def game_action(self, name, x=None, y=None):
        complex_ = name == "ACTION6"
        action = _FakeGameAction(name, complex_=complex_)
        if complex_:
            action.set_data({"x": int(x or 0), "y": int(y or 0)})
        return action

    def close_scorecard(self, card_id):
        self.closed = card_id
        return {"card_id": card_id, "closed": True}

    def scorecard_url(self, card_id):
        return f"https://arcprize.org/scorecards/{card_id}" if card_id else None


# --------------------------------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------------------------------


class SeamTranslationTests(unittest.TestCase):
    def test_observe_shape_after_open(self):
        client = _FakeArcClient(_FakeArcWrapper(width=3, levels=1))
        session = LiveArcSession(client, "ls20").open()
        obs = session.observe()
        self.assertEqual(obs["grid"], [[2, 0, 3]])            # frame -> grid (last frame, plain ints)
        self.assertEqual(obs["level"], 1)                      # levels_completed 0 -> level 1
        self.assertEqual(obs["score"], 0)
        self.assertEqual(obs["valid_actions"], ["ACTION1", "ACTION3"])  # ints -> ACTIONk, RESET dropped
        self.assertFalse(obs["done"])
        self.assertEqual(obs["remaining_actions"], 80)

    def test_open_opens_scorecard_and_resets(self):
        wrapper = _FakeArcWrapper()
        client = _FakeArcClient(wrapper)
        session = LiveArcSession(client, "ls20", tags=["ewm"]).open()
        self.assertEqual(client.opened_tags, ["ewm"])
        self.assertEqual(session.card_id, "card-123")
        # RESET was submitted first (does not count against the action budget).
        self.assertEqual(wrapper.submitted[0].name, "RESET")
        self.assertEqual(session.actions_taken, 0)

    def test_available_actions_default_when_missing(self):
        # A frame with no available_actions falls back to the full ARC action set.
        frame = _FakeFrame([[2, 0, 3]], 0, "NOT_FINISHED", [])
        self.assertEqual(LiveArcSession._available_actions(frame), list(ARC_ACTIONS))


class ActionSubmissionTests(unittest.TestCase):
    def test_walk_to_win(self):
        wrapper = _FakeArcWrapper(width=3, levels=1)
        client = _FakeArcClient(wrapper)
        session = LiveArcSession(client, "ls20").open()
        res = session.act(["ACTION3", "ACTION3"])
        self.assertEqual(res["executed"], ["ACTION3", "ACTION3"])
        self.assertEqual(res["stop_reason"], "done")
        self.assertTrue(res["done"])
        self.assertTrue(session.won)
        self.assertEqual(session.actions_taken, 2)
        self.assertEqual(session.levels_completed, 1)

    def test_level_transition_stops_batch(self):
        wrapper = _FakeArcWrapper(width=3, levels=2)
        client = _FakeArcClient(wrapper)
        session = LiveArcSession(client, "ls20").open()
        res = session.act(["ACTION3", "ACTION3", "ACTION3"])
        # First corridor clears after 2 rights -> level_transition, batch stops before 3rd.
        self.assertEqual(res["stop_reason"], "level_transition")
        self.assertTrue(res["level_transition"])
        self.assertFalse(res["done"])
        self.assertEqual(session.levels_completed, 1)
        self.assertEqual(res["executed"], ["ACTION3", "ACTION3"])

    def test_complex_action_coords_passed_through(self):
        wrapper = _FakeArcWrapper(width=3, levels=1)
        client = _FakeArcClient(wrapper)
        session = LiveArcSession(client, "ls20").open()
        session.act([{"action": "ACTION6", "x": 12, "y": 34}])
        complex_action = wrapper.submitted[-1]
        self.assertEqual(complex_action.name, "ACTION6")
        self.assertEqual(complex_action.data, {"x": 12, "y": 34})

    def test_idle_eviction_recovers_via_reset_and_replay(self):
        class _EvictOnceWrapper(_FakeArcWrapper):
            def __init__(self):
                super().__init__(width=4, levels=1)
                self.evict_next = False

            def step(self, action):
                if self.evict_next and action.name != "RESET":
                    self.evict_next = False
                    self.submitted.append(action)
                    self._last = _FakeFrame([], self.levels_completed, "NOT_STARTED", [])
                    return None
                return super().step(action)

        wrapper = _EvictOnceWrapper()
        session = LiveArcSession(_FakeArcClient(wrapper), "ls20").open()
        session.act(["ACTION3"])
        wrapper.evict_next = True

        result = session.act(["ACTION3"])

        self.assertEqual(session._recoveries, 1)
        self.assertEqual(session.actions_taken, 2)
        self.assertEqual(wrapper.pos, 2)
        self.assertEqual(session._action_log, [("ACTION3", None, None)] * 2)
        self.assertEqual(
            [action.name for action in wrapper.submitted],
            ["RESET", "ACTION3", "ACTION3", "RESET", "ACTION3", "ACTION3"],
        )
        self.assertEqual(result["executed"], ["ACTION3"])
        self.assertTrue(result["board_changed"])

    def test_dict_and_string_actions_both_accepted(self):
        wrapper = _FakeArcWrapper(width=4, levels=1)
        client = _FakeArcClient(wrapper)
        session = LiveArcSession(client, "ls20").open()
        res = session.act(["ACTION3", {"action": "ACTION3"}])
        self.assertEqual(res["executed"], ["ACTION3", "ACTION3"])


class BudgetTests(unittest.TestCase):
    def test_max_actions_cap_enforced(self):
        wrapper = _FakeArcWrapper(width=10, levels=1)  # long corridor, never wins in 2 steps
        client = _FakeArcClient(wrapper)
        session = LiveArcSession(client, "ls20", max_actions=2).open()
        res = session.act(["ACTION1", "ACTION1", "ACTION1", "ACTION1"])
        self.assertEqual(session.actions_taken, 2)
        self.assertEqual(res["stop_reason"], "budget")
        self.assertEqual(session.remaining_actions(), 0)
        self.assertTrue(session.out_of_budget())

    def test_max_seconds_cap_surfaced(self):
        # First clock read (open -> _started_at) is 0.0; every read after jumps past the cap.
        state = {"first": True}

        def clock():
            if state["first"]:
                state["first"] = False
                return 0.0
            return 100.0

        wrapper = _FakeArcWrapper(width=10, levels=1)
        client = _FakeArcClient(wrapper)
        session = LiveArcSession(client, "ls20", max_seconds=10.0, clock=clock).open()
        self.assertTrue(session.out_of_budget())
        self.assertEqual(session.remaining_seconds(), 0.0)
        res = session.act(["ACTION1"])
        self.assertEqual(res["stop_reason"], "budget")
        self.assertEqual(res["executed"], [])  # budget checked before submitting


class LifecycleTests(unittest.TestCase):
    def test_close_returns_scorecard_and_url(self):
        client = _FakeArcClient(_FakeArcWrapper())
        session = LiveArcSession(client, "ls20").open()
        url = session.scorecard_url()
        self.assertEqual(url, "https://arcprize.org/scorecards/card-123")
        card = session.close()
        self.assertEqual(client.closed, "card-123")
        self.assertTrue(card["closed"])
        # Double close is a no-op.
        self.assertIsNone(session.close())

    def test_context_manager_opens_and_closes(self):
        client = _FakeArcClient(_FakeArcWrapper())
        with LiveArcSession(client, "ls20") as session:
            self.assertEqual(session.card_id, "card-123")
        self.assertEqual(client.closed, "card-123")


class CheckoutResolutionTests(unittest.TestCase):
    def test_missing_repo_raises_clear_error(self):
        env = {k: v for k, v in os.environ.items() if k != ENV_BENCHMARKING_REPO}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError) as ctx:
                add_checkout_to_path(None)  # no arg and no env var
        self.assertIn("benchmarking checkout", str(ctx.exception))

    def test_nonexistent_repo_raises(self):
        with self.assertRaises(RuntimeError) as ctx:
            add_checkout_to_path("/definitely/not/a/real/checkout/xyz")
        self.assertIn("not a directory", str(ctx.exception))


class ImportPurityTests(unittest.TestCase):
    def test_module_import_is_sdk_free(self):
        importlib.reload(live_mod)
        sdk = {"arc_agi", "arcengine", "arc_agi3", "arcagi3"}
        self.assertFalse(sdk & set(sys.modules), sdk & set(sys.modules))


if __name__ == "__main__":
    unittest.main()
