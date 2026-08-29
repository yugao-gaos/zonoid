"""Tests for the ARC-AGI-3 adapter contract text and Zonoid context wiring."""

from __future__ import annotations

import unittest

from bench.arc_agi3_zonoid.adapter import (
    build_config,
    contract_summary,
    zonoid_task_instructions,
)


class ContractSummaryTests(unittest.TestCase):
    def test_mode_b_mentions_loop_wiring(self) -> None:
        summary = contract_summary()
        self.assertIn("Mode B - official arc-agi-3-benchmarking checkout", summary)
        self.assertIn("decide/reflect", summary)
        self.assertIn("vision composite", summary)
        self.assertIn("executable world model", summary)
        self.assertIn("KB protocol", summary)
        self.assertIn("REPL loop", summary)


class ZonoidTaskInstructionsTests(unittest.TestCase):
    def test_instructions_require_two_call_turn_structure(self) -> None:
        instructions = zonoid_task_instructions(
            daemon_url="http://127.0.0.1:8787",
            workspace="/tmp/zonoid-workspace",
            task_key="task-123",
        )
        self.assertIn("decide: inspect the current frame", instructions)
        self.assertIn("reflect: after the environment responds", instructions)
        self.assertIn("vision composite", instructions)
        self.assertIn("executable world model", instructions)
        self.assertIn("REPL", instructions)
        self.assertIn("before each decide call", instructions)
        self.assertIn("/search", instructions)
        self.assertIn("/overlay/note", instructions)

    def test_enabled_config_embeds_task_instructions(self) -> None:
        cfg = build_config(
            arm="zonoid_on",
            max_steps=3,
            task_ids=["task-123"],
            out_dir="/tmp/out",
            zonoid_enabled=True,
            daemon_url="http://127.0.0.1:8787",
            workspace="/tmp/zonoid-workspace",
            task_key="task-123",
        )
        self.assertTrue(cfg["zonoid"]["enabled"])
        self.assertIsInstance(cfg["zonoid"]["task_instructions"], str)
        self.assertIn("decide/reflect", cfg["zonoid"]["task_instructions"])


if __name__ == "__main__":
    unittest.main()
