"""Executable-world-model (EWM) harness for the ARC-AGI-3 Zonoid benchmark.

Pillar 2 (REPL sandbox) and Pillar 3 (budget guards) plus a self-contained
connected-component segmentation helper. See :mod:`.repl_sandbox` and
:mod:`.segmentation`.
"""

from __future__ import annotations

from .repl_sandbox import OUTPUT_CAP, run_snippet
from .segmentation import segment_grid

__all__ = ["run_snippet", "segment_grid", "OUTPUT_CAP"]
