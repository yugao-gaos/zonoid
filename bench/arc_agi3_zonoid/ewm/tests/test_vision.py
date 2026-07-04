"""Tests for the EWM vision compositor.

Render tests are skipped unless Pillow is importable; they decode the emitted PNG back and assert
pixel colors, panel geometry, and byte-for-byte determinism. One PIL-free test asserts the module
imports and validates input shapes without requiring Pillow.
"""

from __future__ import annotations

import importlib
import io
import unittest

from bench.arc_agi3_zonoid.ewm import vision
from bench.arc_agi3_zonoid.ewm.vision import (
    ARC_PALETTE,
    DIM_FACTOR,
    GUTTER,
    LABEL_HEIGHT,
    composite_data_url,
    composite_png,
)

try:  # pragma: no cover - trivial availability probe
    from PIL import Image  # noqa: F401

    _HAVE_PIL = True
except ImportError:  # pragma: no cover
    _HAVE_PIL = False


def _dim(rgb):
    return tuple(int(round(ch * DIM_FACTOR)) for ch in rgb)


class InputValidationTests(unittest.TestCase):
    """These run without Pillow: shape/type validation happens before any render."""

    def test_module_imports_without_pil(self):
        # Importing the module and reaching validation must not require Pillow.
        importlib.reload(vision)
        self.assertTrue(hasattr(vision, "composite_png"))

    def test_empty_grid_rejected(self):
        with self.assertRaises(ValueError):
            composite_png([], [])

    def test_ragged_grid_rejected(self):
        with self.assertRaises(ValueError):
            composite_png([[0, 1], [2]], [[0, 1], [2, 3]])

    def test_mismatched_shapes_rejected(self):
        with self.assertRaises(ValueError):
            composite_png([[0, 1]], [[0, 1, 2]])

    def test_out_of_range_value_rejected(self):
        with self.assertRaises(ValueError):
            composite_png([[16]], [[0]])

    def test_non_int_value_rejected(self):
        with self.assertRaises(ValueError):
            composite_png([[0.5]], [[0]])

    def test_bad_scale_rejected(self):
        with self.assertRaises(ValueError):
            composite_png([[0]], [[1]], scale=0)


@unittest.skipUnless(_HAVE_PIL, "Pillow not installed")
class RenderTests(unittest.TestCase):
    def setUp(self):
        # 2x2 frames. Top-left cell changes (blue->red), the other three are unchanged.
        self.frame_a = [[9, 11], [14, 15]]
        self.frame_b = [[8, 11], [14, 15]]
        self.scale = 4

    def _decode(self, png_bytes):
        from PIL import Image

        return Image.open(io.BytesIO(png_bytes)).convert("RGB")

    def test_dimensions(self):
        rows, cols = 2, 2
        png = composite_png(self.frame_a, self.frame_b, scale=self.scale)
        img = self._decode(png)
        exp_w = (cols * 3 + GUTTER * 2) * self.scale
        exp_h = (LABEL_HEIGHT + rows) * self.scale
        self.assertEqual(img.size, (exp_w, exp_h))

    def test_diff_panel_pixel_colors(self):
        png = composite_png(self.frame_a, self.frame_b, scale=self.scale)
        img = self._decode(png).load()

        cols = 2
        # Diff panel is the third panel: x offset = 2*(cols + GUTTER), in unscaled units.
        panel_x0 = 2 * (cols + GUTTER)
        s = self.scale

        def cell_center(panel_col, panel_row):
            x = (panel_x0 + panel_col) * s + s // 2
            y = (LABEL_HEIGHT + panel_row) * s + s // 2
            return img[x, y]

        # Changed cell (0,0): full color from frame_b (red index 8).
        self.assertEqual(cell_center(0, 0), ARC_PALETTE[8])
        # Unchanged cell (0,1): dimmed frame_b color (yellow index 11 dimmed).
        self.assertEqual(cell_center(1, 0), _dim(ARC_PALETTE[11]))
        # Unchanged cell (1,0): dimmed green index 14.
        self.assertEqual(cell_center(0, 1), _dim(ARC_PALETTE[14]))

    def test_before_after_panels_show_source_colors(self):
        png = composite_png(self.frame_a, self.frame_b, scale=self.scale)
        img = self._decode(png).load()
        cols = 2
        s = self.scale

        def panel_cell(panel_idx, panel_col, panel_row):
            x0 = panel_idx * (cols + GUTTER)
            x = (x0 + panel_col) * s + s // 2
            y = (LABEL_HEIGHT + panel_row) * s + s // 2
            return img[x, y]

        # Panel 0 (BEFORE) top-left = frame_a value 9 (blue).
        self.assertEqual(panel_cell(0, 0, 0), ARC_PALETTE[9])
        # Panel 1 (AFTER) top-left = frame_b value 8 (red).
        self.assertEqual(panel_cell(1, 0, 0), ARC_PALETTE[8])

    def test_determinism(self):
        first = composite_png(self.frame_a, self.frame_b, scale=self.scale)
        second = composite_png(self.frame_a, self.frame_b, scale=self.scale)
        self.assertEqual(first, second)

    def test_data_url_wraps_same_bytes(self):
        import base64

        url = composite_data_url(self.frame_a, self.frame_b, scale=self.scale)
        self.assertTrue(url.startswith("data:image/png;base64,"))
        payload = base64.b64decode(url.split(",", 1)[1])
        self.assertEqual(payload, composite_png(self.frame_a, self.frame_b, scale=self.scale))


class MissingPilTests(unittest.TestCase):
    def test_render_raises_clear_import_error_without_pil(self):
        # Simulate Pillow being unavailable at render time; import-time must be unaffected.
        original = vision._require_pil

        def _boom():
            raise vision.VisionImportError("Pillow is required to render EWM vision composites.")

        vision._require_pil = _boom
        try:
            with self.assertRaises(ImportError):
                vision.composite_png([[0]], [[1]])
        finally:
            vision._require_pil = original


if __name__ == "__main__":
    unittest.main()
