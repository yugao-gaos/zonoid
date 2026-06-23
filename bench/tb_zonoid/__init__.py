# Zonoid × Terminal-Bench adapter package.
#
# Named ``tb_zonoid`` (NOT ``terminal_bench``) on purpose: a local package literally named
# ``terminal_bench`` sitting next to ``bench/`` on sys.path would SHADOW the PyPI
# ``terminal_bench`` harness, so the adapter could never import the real BaseAgent/TmuxSession.
# TB resolves this package via its dotted import path ``bench.tb_zonoid.adapter:ZonoidAgent``
# (importlib), which only works with the repo root on sys.path/PYTHONPATH — runner.py guarantees that.
