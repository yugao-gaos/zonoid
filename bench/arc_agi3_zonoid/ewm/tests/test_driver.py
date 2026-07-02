"""Tests for the EWM env driver: ScriptedEnv seam, ArcEnvAdapter translation, and the smoke path.

All tests run offline (no network/GPU/SDK). The ArcEnvAdapter tests drive a fake in-process backend
so no ARC package is required; a separate test asserts the module import pulls in no ARC SDK.
"""

from __future__ import annotations

import importlib
import sys
import unittest

from bench.arc_agi3_zonoid.ewm import driver as driver_mod
from bench.arc_agi3_zonoid.ewm.driver import (
    ARC_ACTIONS,
    ArcEnvAdapter,
    ScriptedEnv,
    smoke_run,
)


class ScriptedEnvTests(unittest.TestCase):
    def test_observe_shape(self):
        env = ScriptedEnv()
        frame = env.observe()
        self.assertEqual(frame["grid"], [[2, 0, 3]])
        self.assertEqual(frame["level"], 1)
        self.assertEqual(frame["valid_actions"], ["UP", "DOWN", "LEFT", "RIGHT"])
        self.assertFalse(frame["done"])

    def test_level_transition_then_win(self):
        env = ScriptedEnv()
        # Level 1: avatar at (0,0), goal at (0,2) -> two RIGHTs clears level 1 (a transition).
        res = env.act(["RIGHT", "RIGHT"])
        self.assertEqual(res["stop_reason"], "level_transition")
        self.assertTrue(res["level_transition"])
        self.assertFalse(res["done"])
        self.assertEqual(env.levels_completed, 1)
        # Now on level 2 (avatar left, goal three cells right): "2..3".
        self.assertEqual(env.observe()["level"], 2)
        # Three RIGHTs clears level 2 -> win.
        res2 = env.act(["RIGHT", "RIGHT", "RIGHT"])
        self.assertEqual(res2["stop_reason"], "done")
        self.assertTrue(res2["done"])
        self.assertEqual(env.levels_completed, 2)
        self.assertTrue(env.observe()["done"])

    def test_expect_mismatch_stops_batch(self):
        env = ScriptedEnv()
        # Feed an expect grid that disagrees with reality on the first action.
        res = env.act(["RIGHT"], expect=[[[9, 9, 9]]])
        self.assertEqual(res["stop_reason"], "expect_mismatch")
        self.assertEqual(res["executed"], ["RIGHT"])

    def test_action_counter(self):
        env = ScriptedEnv()
        env.act(["UP"])  # blocked (top row) but still counts as an action taken
        self.assertEqual(env.actions_taken, 1)
        self.assertEqual(env.remaining_actions, 99)


class _FakeArcBackend:
    """In-process ARC live-game backend: yields frame dicts, walks the avatar on RIGHT.

    Uses ARC-style field names deliberately different from the seam: grid under ``state``, actions
    under ``available_actions``, win under ``done`` — so the adapter's translation is exercised.
    ``step`` takes an ARC action token (ACTION3 == RIGHT here).
    """

    RIGHT = "ACTION3"

    def __init__(self, width: int = 3):
        self.width = width
        self.pos = 0

    def _frame(self):
        row = [0] * self.width
        row[self.pos] = 2
        row[self.width - 1] = 3 if self.pos != self.width - 1 else 2
        return {
            "state": [row],
            "level": 1,
            "score": self.pos,
            "available_actions": ["ACTION1", "ACTION3"],
            "done": self.pos == self.width - 1,
        }

    def reset(self):
        self.pos = 0
        return self._frame()

    def step(self, arc_action):
        if arc_action == self.RIGHT and self.pos < self.width - 1:
            self.pos += 1
        return self._frame()


class ArcEnvAdapterTests(unittest.TestCase):
    def test_frame_to_seam_translation(self):
        # frame dict (ARC field names) -> seam observation dict.
        adapter = ArcEnvAdapter(backend=_FakeArcBackend(width=3))
        obs = adapter.observe()
        self.assertEqual(obs["grid"], [[2, 0, 3]])          # 'state' -> 'grid'
        self.assertEqual(obs["valid_actions"], ["ACTION1", "ACTION3"])  # 'available_actions' -> seam
        self.assertEqual(obs["level"], 1)
        self.assertEqual(obs["score"], 0)
        self.assertFalse(obs["done"])

    def test_seam_actions_to_arc_translation_and_win(self):
        # seam action names -> ARC action calls on the backend; drive it to the win.
        backend = _FakeArcBackend(width=3)
        adapter = ArcEnvAdapter(backend=backend)
        adapter.observe()  # prime last_frame via reset
        res = adapter.act(["ACTION3", "ACTION3"])
        self.assertEqual(res["executed"], ["ACTION3", "ACTION3"])  # seam names forwarded as ARC tokens
        self.assertTrue(res["done"])
        self.assertEqual(res["current_frame"]["grid"], [[0, 0, 2]])

    def test_action_normalization_int_and_enum(self):
        # A backend may enumerate actions as ints or enum-likes; normalize to ACTIONk seam names.
        class _Enum:
            def __init__(self, name):
                self.name = name

        frame = {"available_actions": [1, _Enum("ACTION5"), "ACTION3"]}
        self.assertEqual(
            ArcEnvAdapter._extract_actions(frame), ["ACTION1", "ACTION5", "ACTION3"]
        )

    def test_missing_sdk_raises_clear_runtime_error(self):
        # No backend supplied and the SDK module is absent -> a clear RuntimeError naming it.
        with self.assertRaises(RuntimeError) as ctx:
            ArcEnvAdapter(backend_module="definitely_not_an_arc_sdk_xyz")
        msg = str(ctx.exception)
        self.assertIn("definitely_not_an_arc_sdk_xyz", msg)
        self.assertIn("ARC-AGI-3", msg)


class SmokeRunTests(unittest.TestCase):
    def tearDown(self):
        # smoke_run monkeypatches EwmAgent._vision_available; restore the real probe.
        importlib.reload(sys.modules["bench.arc_agi3_zonoid.ewm.agent"])

    def test_smoke_wins_and_visits_model_modes(self):
        summary = smoke_run()
        self.assertTrue(summary["won"])
        self.assertTrue(summary["program_adopted"])
        self.assertEqual(summary["levels_completed"], 2)
        self.assertGreaterEqual(summary["actions_taken"], 1)
        # The model-based path must have been exercised: SYNTHESIZE + (PLAN|EXECUTE).
        modes = set(summary["modes_visited"])
        self.assertIn("SYNTHESIZE", modes)
        self.assertTrue(
            modes & {"PLAN", "EXECUTE"},
            f"expected PLAN or EXECUTE in modes, got {summary['modes_visited']}",
        )
        # Summary carries the required keys.
        for key in (
            "won",
            "levels_completed",
            "actions_taken",
            "modes_visited",
            "program_adopted",
            "decide_calls",
            "reflect_calls",
        ):
            self.assertIn(key, summary)


class ImportPurityTests(unittest.TestCase):
    def test_module_import_is_sdk_free(self):
        # Importing the driver must not pull in any ARC SDK candidate or PIL.
        importlib.reload(driver_mod)
        sdk = {"arc_agi", "arc_agi_3", "arc_agi3", "arcagi3", "arc"}
        self.assertFalse(sdk & set(sys.modules), sdk & set(sys.modules))

    def test_arc_actions_constant(self):
        self.assertEqual(ARC_ACTIONS[0], "ACTION1")
        self.assertEqual(len(ARC_ACTIONS), 6)


if __name__ == "__main__":
    unittest.main()
