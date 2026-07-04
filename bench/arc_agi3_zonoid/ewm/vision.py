"""EWM vision compositor: render one composite PNG per decision turn.

Pillar 1 (VISION) of the EWM design spec. Each LLM call in a decision turn receives ONE
composite image built here: panel 1 is frame A (labeled ``BEFORE``), panel 2 is frame B
(labeled ``AFTER``), panel 3 is a diff mask where cells that changed between A and B are drawn
at full color from frame B and unchanged cells are dimmed to ~25% brightness. Text labels are
baked into the image above each panel, thin separator gutters divide the panels, and the whole
composite is upscaled by nearest-neighbor so individual grid cells are legible.

The module imports without Pillow; ``composite_png``/``composite_data_url`` raise a clear
``ImportError`` at call time when Pillow is not installed. Rendering is deterministic: the same
input frames always produce byte-identical PNG output.
"""

from __future__ import annotations

import base64
from typing import List, Sequence

Grid = Sequence[Sequence[int]]


# 16-color ARC palette (index -> RGB). Named constant so it can be tuned in one place; values
# follow the ARC rendering convention (0 is the empty/background family, then a distinct hue per
# index). Kept module-level and immutable-by-convention.
ARC_PALETTE: List[tuple] = [
    (255, 255, 255),  # 0  white (background)
    (204, 204, 204),  # 1  light gray
    (153, 153, 153),  # 2  gray
    (102, 102, 102),  # 3  dark gray
    (51, 51, 51),     # 4  charcoal
    (0, 0, 0),        # 5  black
    (229, 58, 163),   # 6  magenta
    (255, 123, 204),  # 7  pink
    (249, 60, 49),    # 8  red
    (30, 147, 255),   # 9  blue
    (136, 216, 241),  # 10 sky
    (255, 220, 0),    # 11 yellow
    (255, 133, 27),   # 12 orange
    (146, 18, 49),    # 13 maroon
    (79, 204, 48),    # 14 green
    (163, 86, 214),   # 15 purple
]

# Fraction of full brightness applied to unchanged cells in the diff panel.
DIM_FACTOR = 0.25

# Layout constants (in unscaled, pre-upscale pixels).
GUTTER = 1               # separator gutter width between panels
# Rows reserved above each panel for the baked-in text label. Sized to fully clear the default
# font glyphs (including descenders) so antialiased text never bleeds into the panel cells below.
LABEL_HEIGHT = 14
_GUTTER_RGB = (64, 64, 64)
_LABEL_BG = (0, 0, 0)
_LABEL_FG = (255, 255, 255)


class VisionImportError(ImportError):
    """Raised when a render is requested but Pillow (PIL) is not importable."""


def _require_pil():
    try:
        from PIL import Image, ImageDraw  # noqa: F401
    except ImportError as exc:  # pragma: no cover - exercised via monkeypatch in tests
        raise VisionImportError(
            "Pillow is required to render EWM vision composites; install it with "
            "'pip install Pillow'."
        ) from exc
    return Image, ImageDraw


def _validate_grid(grid: Grid, name: str) -> tuple:
    """Validate a grid and return ``(rows, cols)``. Does not require Pillow."""

    if not isinstance(grid, (list, tuple)) or len(grid) == 0:
        raise ValueError(f"{name} must be a non-empty grid (list of rows).")
    rows = len(grid)
    cols = None
    for r, row in enumerate(grid):
        if not isinstance(row, (list, tuple)) or len(row) == 0:
            raise ValueError(f"{name} row {r} must be a non-empty list of ints.")
        if cols is None:
            cols = len(row)
        elif len(row) != cols:
            raise ValueError(
                f"{name} is ragged: row {r} has {len(row)} cells, expected {cols}."
            )
        for c, value in enumerate(row):
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError(f"{name}[{r}][{c}] must be an int, got {type(value).__name__}.")
            if not 0 <= value <= 15:
                raise ValueError(f"{name}[{r}][{c}]={value} out of palette range 0..15.")
    return rows, cols


def _dim(rgb: tuple) -> tuple:
    return tuple(int(round(channel * DIM_FACTOR)) for channel in rgb)


def composite_png(
    frame_a: Grid,
    frame_b: Grid,
    label_a: str = "BEFORE",
    label_b: str = "AFTER",
    scale: int = 4,
) -> bytes:
    """Render the three-panel composite and return raw PNG bytes.

    ``frame_a`` and ``frame_b`` are grids (rows of ints 0..15) and MUST share the same shape.
    Raises :class:`ValueError` on bad input and :class:`VisionImportError` if Pillow is absent.
    """

    rows_a, cols_a = _validate_grid(frame_a, "frame_a")
    rows_b, cols_b = _validate_grid(frame_b, "frame_b")
    if (rows_a, cols_a) != (rows_b, cols_b):
        raise ValueError(
            f"frame_a shape {(rows_a, cols_a)} != frame_b shape {(rows_b, cols_b)}; "
            "both frames must be the same size."
        )
    if not isinstance(scale, int) or scale < 1:
        raise ValueError(f"scale must be an int >= 1, got {scale!r}.")

    Image, ImageDraw = _require_pil()

    rows, cols = rows_a, cols_a
    panel_w, panel_h = cols, rows

    # Composite (pre-upscale) canvas: three panels stacked horizontally with a label strip on top.
    total_w = panel_w * 3 + GUTTER * 2
    total_h = LABEL_HEIGHT + panel_h
    canvas = Image.new("RGB", (total_w, total_h), _GUTTER_RGB)
    pixels = canvas.load()

    diff_grid = _diff_panel_colors(frame_a, frame_b)
    panels = (
        _panel_colors(frame_a),
        _panel_colors(frame_b),
        diff_grid,
    )

    for panel_idx, colors in enumerate(panels):
        x0 = panel_idx * (panel_w + GUTTER)
        # Fill label strip background.
        for y in range(LABEL_HEIGHT):
            for x in range(panel_w):
                pixels[x0 + x, y] = _LABEL_BG
        # Paint panel cells.
        for r in range(rows):
            for c in range(cols):
                pixels[x0 + c, LABEL_HEIGHT + r] = colors[r][c]

    # Bake in text labels with the PIL default bitmap font.
    draw = ImageDraw.Draw(canvas)
    labels = (label_a, label_b, "DIFF")
    for panel_idx, text in enumerate(labels):
        x0 = panel_idx * (panel_w + GUTTER)
        draw.text((x0 + 1, 1), str(text), fill=_LABEL_FG)

    if scale > 1:
        canvas = canvas.resize((total_w * scale, total_h * scale), Image.Resampling.NEAREST)

    return _to_png_bytes(canvas)


def composite_data_url(
    frame_a: Grid,
    frame_b: Grid,
    label_a: str = "BEFORE",
    label_b: str = "AFTER",
    scale: int = 4,
) -> str:
    """Return the composite as a ``data:image/png;base64,...`` URL string."""

    png = composite_png(frame_a, frame_b, label_a=label_a, label_b=label_b, scale=scale)
    encoded = base64.b64encode(png).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _panel_colors(frame: Grid) -> List[List[tuple]]:
    return [[ARC_PALETTE[int(v)] for v in row] for row in frame]


def _diff_panel_colors(frame_a: Grid, frame_b: Grid) -> List[List[tuple]]:
    """Diff panel: changed cells at full color from frame_b, unchanged cells dimmed."""

    out: List[List[tuple]] = []
    for row_a, row_b in zip(frame_a, frame_b):
        row: List[tuple] = []
        for a, b in zip(row_a, row_b):
            rgb = ARC_PALETTE[int(b)]
            row.append(rgb if a != b else _dim(rgb))
        out.append(row)
    return out


def _to_png_bytes(image) -> bytes:
    import io

    buffer = io.BytesIO()
    # Deterministic: no timestamp chunk so identical input yields identical bytes.
    image.save(buffer, format="PNG")
    return buffer.getvalue()
