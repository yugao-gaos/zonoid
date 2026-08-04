# Zonoid bench namespace package.
#
# Marks ``bench/`` as an importable package so Terminal-Bench can resolve the
# Zonoid adapter via its dotted ``--agent-import-path bench.terminal_bench.adapter:ZonoidAgent``
# (TB calls ``importlib.import_module("bench.terminal_bench.adapter")``, which requires the repo
# root on sys.path / PYTHONPATH — bench/terminal_bench/runner.py guarantees that).
#
# NOTE: the existing SDK modules import as ``zonoid_bench.*`` (bench/ on sys.path), NOT
# ``bench.zonoid_bench.*``; adding this file does not change that — it only enables the
# fully-qualified ``bench.terminal_bench`` path TB needs for the agent import.
