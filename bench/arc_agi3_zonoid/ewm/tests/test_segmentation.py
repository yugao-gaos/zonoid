"""Segmentation tests: components, containment, adjacency, translation-invariant hash."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from arc_agi3_zonoid.ewm.segmentation import segment_grid  # noqa: E402


def _node_by_id(seg, node_id):
    return next(node for node in seg["nodes"] if node["id"] == node_id)


class SegmentationComponentsTest(unittest.TestCase):
    def test_uniform_grid_is_single_component(self):
        grid = [[3, 3], [3, 3]]
        seg = segment_grid(grid)
        self.assertEqual(len(seg["nodes"]), 1)
        node = seg["nodes"][0]
        self.assertEqual(node["id"], 0)
        self.assertEqual(node["color"], 3)
        self.assertEqual(node["pixels"], 4)
        self.assertEqual(node["children"], [])
        self.assertEqual(seg["adjacency_list"], [])

    def test_four_connectivity_splits_diagonal_touch(self):
        # Two color-5 cells touching only diagonally are separate components.
        grid = [
            [5, 0],
            [0, 5],
        ]
        seg = segment_grid(grid)
        fives = [n for n in seg["nodes"] if n["color"] == 5]
        self.assertEqual(len(fives), 2)
        for node in fives:
            self.assertEqual(node["pixels"], 1)

    def test_reading_order_ids(self):
        # Distinct single cells get ids in reading order.
        grid = [
            [1, 2],
            [3, 4],
        ]
        seg = segment_grid(grid)
        colors_in_id_order = [n["color"] for n in seg["nodes"]]
        self.assertEqual(colors_in_id_order, [1, 2, 3, 4])


class ContainmentTest(unittest.TestCase):
    def test_enclosed_object_is_child(self):
        # A ring of 1s (background 0) fully encloses a single 2 in the middle.
        grid = [
            [1, 1, 1, 1, 1],
            [1, 0, 0, 0, 1],
            [1, 0, 2, 0, 1],
            [1, 0, 0, 0, 1],
            [1, 1, 1, 1, 1],
        ]
        seg = segment_grid(grid)
        ring = next(n for n in seg["nodes"] if n["color"] == 1)
        inner_bg = next(n for n in seg["nodes"] if n["color"] == 0)
        dot = next(n for n in seg["nodes"] if n["color"] == 2)
        # Ring is the innermost encloser of the background hole; background is the
        # innermost encloser of the dot.
        self.assertIn(inner_bg["id"], ring["children"])
        self.assertIn(dot["id"], inner_bg["children"])
        # Dot is not a direct child of the ring (nesting is one level at a time).
        self.assertNotIn(dot["id"], ring["children"])

    def test_no_containment_when_border_reachable(self):
        # Two side-by-side blocks, neither encloses the other.
        grid = [
            [7, 7, 8, 8],
            [7, 7, 8, 8],
        ]
        seg = segment_grid(grid)
        for node in seg["nodes"]:
            self.assertEqual(node["children"], [])


class AdjacencyTest(unittest.TestCase):
    def test_touching_pairs_listed(self):
        grid = [
            [1, 2],
            [1, 2],
        ]
        seg = segment_grid(grid)
        # Components 0 (color 1) and 1 (color 2) share a vertical edge.
        self.assertEqual(seg["adjacency_list"], [[0, 1]])

    def test_ring_touches_inner_background(self):
        grid = [
            [1, 1, 1],
            [1, 0, 1],
            [1, 1, 1],
        ]
        seg = segment_grid(grid)
        ring = next(n for n in seg["nodes"] if n["color"] == 1)
        hole = next(n for n in seg["nodes"] if n["color"] == 0)
        pair = sorted([ring["id"], hole["id"]])
        self.assertIn(pair, seg["adjacency_list"])


class HashTest(unittest.TestCase):
    def test_translation_invariance(self):
        # An L-shaped color-4 object placed in two different positions hashes equally.
        grid_a = [
            [4, 0, 0, 0],
            [4, 4, 0, 0],
            [0, 0, 0, 0],
        ]
        grid_b = [
            [0, 0, 0, 0],
            [0, 0, 4, 0],
            [0, 0, 4, 4],
        ]
        node_a = next(n for n in segment_grid(grid_a)["nodes"] if n["color"] == 4)
        node_b = next(n for n in segment_grid(grid_b)["nodes"] if n["color"] == 4)
        self.assertEqual(node_a["hash"], node_b["hash"])
        self.assertEqual(node_a["pixels"], node_b["pixels"])

    def test_different_shape_different_hash(self):
        line = next(n for n in segment_grid([[4, 4, 4]])["nodes"] if n["color"] == 4)
        block = next(n for n in segment_grid([[4, 4], [4, 4]])["nodes"] if n["color"] == 4)
        self.assertNotEqual(line["hash"], block["hash"])

    def test_different_color_different_hash(self):
        a = next(n for n in segment_grid([[4, 4]])["nodes"] if n["color"] == 4)
        b = next(n for n in segment_grid([[5, 5]])["nodes"] if n["color"] == 5)
        self.assertNotEqual(a["hash"], b["hash"])


class BoundaryTest(unittest.TestCase):
    def test_single_cell_boundary(self):
        node = segment_grid([[9]])["nodes"][0]
        self.assertEqual(node["boundary"], [[0, 0]])

    def test_square_boundary_is_four_corners(self):
        grid = [
            [2, 2],
            [2, 2],
        ]
        node = segment_grid(grid)["nodes"][0]
        # A solid square reduces to its 4 corner points.
        self.assertEqual(len(node["boundary"]), 4)
        corners = {tuple(p) for p in node["boundary"]}
        self.assertEqual(corners, {(0, 0), (0, 1), (1, 1), (1, 0)})


if __name__ == "__main__":
    unittest.main()
