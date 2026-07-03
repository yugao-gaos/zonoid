"""Delta tests: object matching, move/grow/recolor/appear/disappear, per-action aggregate."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from arc_agi3_zonoid.ewm.deltas import (  # noqa: E402
    delta_text,
    summarize_suite,
    transition_deltas,
)
from arc_agi3_zonoid.ewm.world_model import TransitionSuite  # noqa: E402


def _deltas_by_id(record):
    return {d["object"]["id"]: d for d in record["deltas"]}


class TransitionDeltasTest(unittest.TestCase):
    def test_static_transition_flagged(self):
        grid = [
            [0, 0, 0],
            [0, 4, 0],
            [0, 0, 0],
        ]
        record = transition_deltas(grid, "ACTION1", grid)
        self.assertTrue(record.get("static"))
        self.assertEqual(record["deltas"], [])

    def test_movement_reported_as_relative_offset(self):
        # A single color-4 pixel moves down one row (and the background reshapes, which is
        # its own delta but not what we assert here).
        before = [
            [0, 0, 0],
            [0, 4, 0],
            [0, 0, 0],
        ]
        after = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 4, 0],
        ]
        record = transition_deltas(before, "ACTION1", after)
        moved = [d for d in record["deltas"] if d["kind"] == "moved"]
        self.assertEqual(len(moved), 1)
        self.assertEqual(moved[0]["detail"], (1, 0))
        self.assertEqual(moved[0]["object"]["color"], 4)

    def test_growth_via_overlap_identity_when_hash_changes(self):
        # A vertical bar of 3s grows by one cell. Hash changes (shape differs) so identity
        # comes from cell overlap, and the change is classified as a growth.
        before = [
            [0, 3, 0],
            [0, 3, 0],
            [0, 0, 0],
        ]
        after = [
            [0, 3, 0],
            [0, 3, 0],
            [0, 3, 0],
        ]
        record = transition_deltas(before, "ACTION2", after)
        grew = [d for d in record["deltas"] if d["kind"] == "grew"]
        self.assertEqual(len(grew), 1)
        self.assertEqual(grew[0]["detail"], 1)
        self.assertEqual(grew[0]["object"]["color"], 3)
        self.assertEqual(grew[0]["object"]["pixels"], 3)

    def test_shrink_reported_with_negative_detail(self):
        before = [
            [0, 3, 0],
            [0, 3, 0],
            [0, 3, 0],
        ]
        after = [
            [0, 3, 0],
            [0, 3, 0],
            [0, 0, 0],
        ]
        record = transition_deltas(before, "ACTION3", after)
        shrank = [d for d in record["deltas"] if d["kind"] == "shrank"]
        self.assertEqual(len(shrank), 1)
        self.assertEqual(shrank[0]["detail"], -1)

    def test_recolor_same_shape_different_color(self):
        # A 2x1 bar keeps its position and pixel count but changes color 4 -> 7. Same shape
        # + same location but different color -> the hash differs (color is hashed), so
        # identity is via overlap and the change is a recolor.
        before = [
            [0, 0, 0],
            [4, 4, 0],
            [0, 0, 0],
        ]
        after = [
            [0, 0, 0],
            [7, 7, 0],
            [0, 0, 0],
        ]
        record = transition_deltas(before, "ACTION4", after)
        recolored = [d for d in record["deltas"] if d["kind"] == "recolored"]
        self.assertEqual(len(recolored), 1)
        self.assertEqual(recolored[0]["detail"], (4, 7))

    def test_appear_and_disappear(self):
        # Object of 5s disappears; an unrelated object of 8s appears elsewhere with no
        # overlap, so they are not matched to each other.
        before = [
            [5, 0, 0, 0],
            [0, 0, 0, 0],
        ]
        after = [
            [0, 0, 0, 8],
            [0, 0, 0, 8],
        ]
        record = transition_deltas(before, "ACTION5", after)
        kinds = {d["kind"] for d in record["deltas"]}
        self.assertIn("appeared", kinds)
        self.assertIn("disappeared", kinds)
        appeared = [d for d in record["deltas"] if d["kind"] == "appeared"]
        disappeared = [d for d in record["deltas"] if d["kind"] == "disappeared"]
        self.assertEqual(appeared[0]["object"]["color"], 8)
        self.assertEqual(disappeared[0]["object"]["color"], 5)

    def test_translation_invariant_hash_matches_moved_object(self):
        # Same L-shape of 6s translated by (+1,+1). The hash is identical so identity comes
        # from the hash path (not overlap), yielding a clean move of the whole object.
        before = [
            [6, 0, 0, 0],
            [6, 6, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ]
        after = [
            [0, 0, 0, 0],
            [0, 6, 0, 0],
            [0, 6, 6, 0],
            [0, 0, 0, 0],
        ]
        record = transition_deltas(before, "ACTION6", after)
        moved = [d for d in record["deltas"] if d["kind"] == "moved" and d["object"]["color"] == 6]
        self.assertEqual(len(moved), 1)
        self.assertEqual(moved[0]["detail"], (1, 1))


class DeltaTextTest(unittest.TestCase):
    def test_static_line(self):
        grid = [[0, 0], [0, 0]]
        record = transition_deltas(grid, "ACTION1", grid)
        self.assertEqual(delta_text(record), "ACTION1: static")

    def test_move_line_format(self):
        before = [
            [0, 0, 0],
            [0, 4, 0],
            [0, 0, 0],
        ]
        after = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 4, 0],
        ]
        record = transition_deltas(before, "ACTION1", after)
        line = delta_text(record)
        self.assertIn("ACTION1:", line)
        self.assertIn("(color 4, 1px) moved (+1,0)", line)

    def test_grow_line_format(self):
        before = [
            [0, 3, 0],
            [0, 3, 0],
            [0, 0, 0],
        ]
        after = [
            [0, 3, 0],
            [0, 3, 0],
            [0, 3, 0],
        ]
        line = delta_text(transition_deltas(before, "ACTION2", after))
        self.assertIn("grew +1 cells", line)


class SummarizeSuiteTest(unittest.TestCase):
    def test_per_transition_and_per_action_aggregate(self):
        # Four transitions all under ACTION1, each moving a lone color-4 pixel down by one
        # row. The aggregate should report the consistent (+1,0) movement 4/4 times.
        suite = TransitionSuite()
        starts = [(0, 1), (0, 2), (0, 0), (0, 3)]
        for r0, c0 in starts:
            before = [[0, 0, 0, 0] for _ in range(3)]
            before[r0][c0] = 4
            after = [[0, 0, 0, 0] for _ in range(3)]
            after[r0 + 1][c0] = 4
            suite.append(before, "ACTION1", after)

        summary = summarize_suite(suite)
        self.assertEqual(len(summary["per_transition"]), 4)
        for line in summary["per_transition"]:
            self.assertIn("moved (+1,0)", line)
        self.assertEqual(len(summary["per_action"]), 1)
        agg = summary["per_action"][0]
        self.assertIn("ACTION1:", agg)
        self.assertIn("consistently", agg)
        self.assertIn("moves obj color 4 by (+1,0)", agg)
        self.assertIn("[4/4 transitions]", agg)

    def test_multiple_actions_kept_in_first_seen_order(self):
        suite = TransitionSuite()
        # ACTION_A: pixel moves right.
        suite.append([[7, 0]], "ACTION_A", [[0, 7]])
        # ACTION_B: pixel appears.
        suite.append([[0, 0]], "ACTION_B", [[0, 9]])
        summary = summarize_suite(suite)
        self.assertEqual(len(summary["per_action"]), 2)
        self.assertTrue(summary["per_action"][0].startswith("ACTION_A:"))
        self.assertTrue(summary["per_action"][1].startswith("ACTION_B:"))

    def test_static_action_reported(self):
        suite = TransitionSuite()
        grid = [[0, 4], [0, 0]]
        suite.append(grid, "NOOP", grid)
        summary = summarize_suite(suite)
        self.assertEqual(summary["per_transition"], ["NOOP: static"])
        self.assertIn("no object changes", summary["per_action"][0])


if __name__ == "__main__":
    unittest.main()
