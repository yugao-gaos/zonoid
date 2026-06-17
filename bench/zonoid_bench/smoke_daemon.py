"""
bench/zonoid_bench/smoke_daemon.py
===================================
Smoke test for daemon.py.

Run via the embeddable Python (use double-backslash or forward slashes):
    py312embed\\python.exe smoke_daemon.py

Checks:
  1. start() on a free port reaches phase:ready
  2. The port is NOT 8787
  3. stop() makes the process exit (returncode is set)

Prints a one-line PASS/FAIL summary and exits with 0/1.
"""

from __future__ import annotations

import sys
import time
import os

# ---- path bootstrap so the module is importable without pip install -------
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
_REPO  = os.path.dirname(_BENCH)
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

from zonoid_bench.daemon import start, stop  # noqa: E402  (after path tweak)


def main() -> int:
    print("[smoke] Starting isolated bench daemon ...", file=sys.stderr)
    t0 = time.monotonic()

    handle = start()  # auto-selects port and temp data_dir

    elapsed = time.monotonic() - t0
    port    = handle.port
    pid     = handle.proc.pid

    print(
        f"[smoke] daemon ready in {elapsed:.1f}s  port={port}  pid={pid}",
        file=sys.stderr,
    )

    # ---- assertions -------------------------------------------------------
    failures: list[str] = []

    if port == 8787:
        failures.append(f"FAIL: port must not be 8787, got {port}")

    rc = stop(handle)
    if handle.proc.poll() is None:
        failures.append("FAIL: process is still alive after stop()")

    # ---- report -----------------------------------------------------------
    if failures:
        for f in failures:
            print(f, file=sys.stderr)
        print(
            f"FAIL  port={port}  time_to_ready={elapsed:.1f}s",
            flush=True,
        )
        return 1

    print(
        f"PASS  port={port}  time_to_ready={elapsed:.1f}s  exit_code={rc}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
