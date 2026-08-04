"""Tests for the DEV-ONLY dev_ceiling script wiring (driven by FakeLlm — no CLI, no daemon).

These prove the ceiling harness threads the SAME production synthesis path: it loads a suite, builds
delta texts + the synth-context contract, and drives a SynthSession (graph off) that adopts and
validates a program. The frontier CLI is never invoked here.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from bench.arc_agi3_zonoid.ewm import dev_ceiling
from bench.arc_agi3_zonoid.ewm.llm_client import FakeLlm

# Reuse the toy-game fixtures + JSON scripting helpers from the synth_graph tests.
from bench.arc_agi3_zonoid.ewm.tests.test_synth_graph import (
    _SUITE,
    _analyze_json,
    _fenced,
    _plan_json,
)
from bench.arc_agi3_zonoid.ewm.tests.test_world_model import TOY_GAME_SOURCE


class InputBuildingTests(unittest.TestCase):
    def test_load_suite_roundtrips(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "transition-suite.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(_SUITE.to_json())
            loaded = dev_ceiling.load_suite(path)
        self.assertEqual(len(loaded), len(_SUITE))
        self.assertEqual(loaded[0].action, _SUITE[0].action)

    def test_build_synth_inputs_produces_deltas_and_contract(self):
        agent = dev_ceiling.build_offline_agent(_SUITE, "toy", FakeLlm([]))
        deltas, ctx = dev_ceiling.build_synth_inputs(agent, _SUITE)
        self.assertGreater(len(deltas), 0)
        # The contract appendix is always appended (the run-8 numpy-hallucination guard).
        self.assertIn("SYNTHESIS DATA", ctx)
        self.assertIn("rows x", ctx)


class SessionRunTests(unittest.TestCase):
    def test_run_session_adopts_and_validates(self):
        # One ANALYZE, one PLAN, one EDIT landing the toy program -> full suite green.
        llm = FakeLlm(
            [
                _analyze_json(("movement", "avatar shifts by action delta")),
                _plan_json(("write toy", "author the mover", [0, 1])),
                _fenced(TOY_GAME_SOURCE),
            ]
        )
        with tempfile.TemporaryDirectory() as d:
            agent = dev_ceiling.build_offline_agent(_SUITE, "toy", llm)
            deltas, ctx = dev_ceiling.build_synth_inputs(agent, _SUITE)
            result = dev_ceiling.run_session("toy", _SUITE, llm, deltas, ctx, d)
            # Per-EDIT artifact was written.
            self.assertTrue(os.path.exists(os.path.join(d, "edit-01.json")))
            with open(os.path.join(d, "edit-01.json"), encoding="utf-8") as fh:
                rec = json.load(fh)
        self.assertTrue(result["report"]["ok"])
        self.assertIn("def init_state", result["program_source"])
        self.assertTrue(rec["adopted"])

    def test_single_shot_validates_direct_program(self):
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE)])
        with tempfile.TemporaryDirectory() as d:
            agent = dev_ceiling.build_offline_agent(_SUITE, "toy", llm)
            _, ctx = dev_ceiling.build_synth_inputs(agent, _SUITE)
            shot = dev_ceiling.single_shot(_SUITE, llm, ctx, d)
            self.assertTrue(os.path.exists(os.path.join(d, "single-shot.json")))
        self.assertIsNotNone(shot["report"])
        self.assertTrue(shot["report"]["ok"])


if __name__ == "__main__":
    unittest.main()
