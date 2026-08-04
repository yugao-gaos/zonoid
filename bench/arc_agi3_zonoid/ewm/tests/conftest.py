"""Per-test CWD isolation (Run-40).

The agent's local coverage-state store (``out/ewm-state/<game_id>-coverage.json``) and the
driver's artifact dirs are CWD-relative by design (the live driver runs from the repo root). Under
a shared repo CWD the store would do EXACTLY what it exists to do — resume state across runs —
between unrelated tests sharing a ``game_id`` (and across pytest invocations), and litter the repo
``out/`` tree. Every test therefore runs in its own temp CWD; tests that need repo files already
resolve them via ``__file__``, never the CWD.
"""

import os

import pytest


@pytest.fixture(autouse=True)
def _isolated_cwd(tmp_path):
    old = os.getcwd()
    os.chdir(tmp_path)
    try:
        yield
    finally:
        os.chdir(old)
