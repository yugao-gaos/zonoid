"""bench/zonoid_bench/smoke_warm.py — DRY verification for warm.py.

Checks:
  1. load_snapshot builds the correct onboard-learn.js --inject argv for a
     given workspace (argv shape, flags, env vars).
  2. produce_snapshot resolves warm_start.js at the expected path.
  3. Both scripts actually exist on disk.

Does NOT run an LLM, does NOT hit a live daemon.
Prints PASS / FAIL for each check.
"""

from __future__ import annotations

import pathlib
import sys
import os


def _check(name: str, cond: bool, detail: str = "") -> bool:
    status = "PASS" if cond else "FAIL"
    msg = f"[smoke_warm] {status}: {name}"
    if detail:
        msg += f"\n         {detail}"
    print(msg)
    return cond


def main() -> int:
    all_pass = True
    repo_root = pathlib.Path(__file__).resolve().parent.parent.parent

    # ------------------------------------------------------------------
    # 1. Script existence
    # ------------------------------------------------------------------
    onboard_learn = repo_root / "scripts" / "onboard-learn.js"
    warm_start = repo_root / "bench" / "swe-bench-cl" / "warm_start.js"

    all_pass &= _check(
        "scripts/onboard-learn.js exists",
        onboard_learn.is_file(),
        str(onboard_learn),
    )
    all_pass &= _check(
        "bench/swe-bench-cl/warm_start.js exists",
        warm_start.is_file(),
        str(warm_start),
    )

    # ------------------------------------------------------------------
    # 2. Import warm module
    # ------------------------------------------------------------------
    try:
        # Ensure bench/zonoid_bench is importable without install
        bench_pkg = repo_root / "bench"
        if str(bench_pkg) not in sys.path:
            sys.path.insert(0, str(bench_pkg))
        from zonoid_bench import warm  # noqa: F401
        import_ok = True
    except Exception as exc:
        import_ok = False
        _check("warm module imports cleanly", False, str(exc))
        return 1

    all_pass &= _check("warm module imports cleanly", import_ok)

    # ------------------------------------------------------------------
    # 3. load_snapshot argv construction
    # ------------------------------------------------------------------
    # Patch _run to capture argv instead of executing.
    captured: list[list[str]] = []
    captured_env: list[dict] = []
    orig_run = warm._run

    def fake_run(argv, extra_env=None, **kwargs):
        captured.append(list(argv))
        captured_env.append(dict(extra_env or {}))

    warm._run = fake_run  # type: ignore[assignment]

    try:
        # Provide a fake snapshot dir with onboard-notes.json
        import tempfile, json as _json

        with tempfile.TemporaryDirectory() as snap_tmp:
            snap_path = pathlib.Path(snap_tmp)
            # write a minimal onboard-notes.json so load_snapshot doesn't raise
            (snap_path / "onboard-notes.json").write_text(
                _json.dumps({"kept": [], "rejected": []}), encoding="utf-8"
            )

            fake_ws = "/tmp/bench-test-ws"
            try:
                warm.load_snapshot(
                    snapshot=str(snap_path),
                    workspace=fake_ws,
                    daemon="http://localhost:8787",
                )
            except FileNotFoundError as exc:
                # node not on PATH is acceptable in a CI sandbox
                if "node" in str(exc).lower():
                    _check(
                        "load_snapshot argv shape (node not found — skipped)",
                        True,
                        "Node.js unavailable; argv check skipped.",
                    )
                    captured.clear()
                    captured_env.clear()
                    warm._run = orig_run
                    # still check produce_snapshot path
                    _check_produce(warm, warm_start, all_pass)
                    return 0 if all_pass else 1
                raise

        if captured:
            argv = captured[0]
            env = captured_env[0]

            has_inject_flag = "--inject" in argv
            has_confirm = "--confirm" in argv
            has_workspace = "--workspace" in argv
            ws_val_idx = argv.index("--workspace") + 1 if has_workspace else -1
            ws_val = argv[ws_val_idx] if ws_val_idx > 0 and ws_val_idx < len(argv) else ""
            ws_is_abs = os.path.isabs(ws_val)
            has_model = "--model" in argv and argv[argv.index("--model") + 1] == "sonnet"
            env_gate_off = env.get("ORCH_GATE_OFF") == "1"
            env_daemon_set = "ORCH_DAEMON" in env
            node_is_first = len(argv) > 0 and ("node" in pathlib.Path(argv[0]).name.lower())
            script_is_onboard = len(argv) > 1 and "onboard-learn" in argv[1]

            all_pass &= _check("argv[0] is node", node_is_first, argv[0] if argv else "(empty)")
            all_pass &= _check("argv[1] is onboard-learn.js", script_is_onboard, argv[1] if len(argv) > 1 else "(missing)")
            all_pass &= _check("--inject flag present", has_inject_flag)
            all_pass &= _check("--confirm flag present", has_confirm)
            all_pass &= _check("--workspace flag present", has_workspace)
            all_pass &= _check("--workspace value is absolute", ws_is_abs, ws_val)
            all_pass &= _check("--model sonnet present", has_model)
            all_pass &= _check("ORCH_GATE_OFF=1 in env", env_gate_off)
            all_pass &= _check("ORCH_DAEMON set in env", env_daemon_set)
        else:
            _check("load_snapshot produced an argv", False, "no argv captured")
            all_pass = False

    finally:
        warm._run = orig_run  # type: ignore[assignment]

    # ------------------------------------------------------------------
    # 4. produce_snapshot path resolution
    # ------------------------------------------------------------------
    all_pass = _check_produce(warm, warm_start, all_pass)

    # ------------------------------------------------------------------
    # 5. absolute-workspace guard
    # ------------------------------------------------------------------
    try:
        with tempfile.TemporaryDirectory() as snap_tmp:
            (pathlib.Path(snap_tmp) / "onboard-notes.json").write_text(
                _json.dumps({"kept": [], "rejected": []}), encoding="utf-8"
            )
            warm.load_snapshot(
                snapshot=snap_tmp,
                workspace="relative/path",  # should raise
                daemon="http://localhost:8787",
            )
        all_pass &= _check("relative workspace raises ValueError", False, "no exception raised")
    except ValueError:
        all_pass &= _check("relative workspace raises ValueError", True)
    except Exception as exc:
        all_pass &= _check("relative workspace raises ValueError", False, str(exc))

    return 0 if all_pass else 1


def _check_produce(warm, warm_start: pathlib.Path, all_pass: bool) -> bool:
    # Verify produce_snapshot resolves warm_start.js to the correct path.
    resolved = warm._WARM_START_JS.resolve()
    expected = warm_start.resolve()
    ok = resolved == expected
    all_pass &= _check(
        "produce_snapshot resolves warm_start.js",
        ok,
        f"resolved={resolved}  expected={expected}",
    )
    return all_pass


if __name__ == "__main__":
    sys.exit(main())
