"""Tests for the EWM env driver: ScriptedEnv seam, ArcEnvAdapter translation, and the smoke path.

All tests run offline (no network/GPU/SDK). The ArcEnvAdapter tests drive a fake in-process backend
so no ARC package is required; a separate test asserts the module import pulls in no ARC SDK.
"""

from __future__ import annotations

import importlib
import sys
import unittest

from bench.arc_agi3_zonoid.ewm import driver as driver_mod
from bench.arc_agi3_zonoid.ewm.driver import (
    ARC_ACTIONS,
    ArcEnvAdapter,
    ScriptedEnv,
    smoke_run,
)


class ScriptedEnvTests(unittest.TestCase):
    def test_observe_shape(self):
        env = ScriptedEnv()
        frame = env.observe()
        self.assertEqual(frame["grid"], [[2, 0, 3]])
        self.assertEqual(frame["level"], 1)
        self.assertEqual(frame["valid_actions"], ["UP", "DOWN", "LEFT", "RIGHT"])
        self.assertFalse(frame["done"])

    def test_level_transition_then_win(self):
        env = ScriptedEnv()
        # Level 1: avatar at (0,0), goal at (0,2) -> two RIGHTs clears level 1 (a transition).
        res = env.act(["RIGHT", "RIGHT"])
        self.assertEqual(res["stop_reason"], "level_transition")
        self.assertTrue(res["level_transition"])
        self.assertFalse(res["done"])
        self.assertEqual(env.levels_completed, 1)
        # Now on level 2 (avatar left, goal three cells right): "2..3".
        self.assertEqual(env.observe()["level"], 2)
        # Three RIGHTs clears level 2 -> win.
        res2 = env.act(["RIGHT", "RIGHT", "RIGHT"])
        self.assertEqual(res2["stop_reason"], "done")
        self.assertTrue(res2["done"])
        self.assertEqual(env.levels_completed, 2)
        self.assertTrue(env.observe()["done"])

    def test_expect_mismatch_stops_batch(self):
        env = ScriptedEnv()
        # Feed an expect grid that disagrees with reality on the first action.
        res = env.act(["RIGHT"], expect=[[[9, 9, 9]]])
        self.assertEqual(res["stop_reason"], "expect_mismatch")
        self.assertEqual(res["executed"], ["RIGHT"])

    def test_action_counter(self):
        env = ScriptedEnv()
        env.act(["UP"])  # blocked (top row) but still counts as an action taken
        self.assertEqual(env.actions_taken, 1)
        self.assertEqual(env.remaining_actions, 99)


class _FakeArcBackend:
    """In-process ARC live-game backend: yields frame dicts, walks the avatar on RIGHT.

    Uses ARC-style field names deliberately different from the seam: grid under ``state``, actions
    under ``available_actions``, win under ``done`` — so the adapter's translation is exercised.
    ``step`` takes an ARC action token (ACTION3 == RIGHT here).
    """

    RIGHT = "ACTION3"

    def __init__(self, width: int = 3):
        self.width = width
        self.pos = 0

    def _frame(self):
        row = [0] * self.width
        row[self.pos] = 2
        row[self.width - 1] = 3 if self.pos != self.width - 1 else 2
        return {
            "state": [row],
            "level": 1,
            "score": self.pos,
            "available_actions": ["ACTION1", "ACTION3"],
            "done": self.pos == self.width - 1,
        }

    def reset(self):
        self.pos = 0
        return self._frame()

    def step(self, arc_action):
        if arc_action == self.RIGHT and self.pos < self.width - 1:
            self.pos += 1
        return self._frame()


class ArcEnvAdapterTests(unittest.TestCase):
    def test_frame_to_seam_translation(self):
        # frame dict (ARC field names) -> seam observation dict.
        adapter = ArcEnvAdapter(backend=_FakeArcBackend(width=3))
        obs = adapter.observe()
        self.assertEqual(obs["grid"], [[2, 0, 3]])          # 'state' -> 'grid'
        self.assertEqual(obs["valid_actions"], ["ACTION1", "ACTION3"])  # 'available_actions' -> seam
        self.assertEqual(obs["level"], 1)
        self.assertEqual(obs["score"], 0)
        self.assertFalse(obs["done"])

    def test_seam_actions_to_arc_translation_and_win(self):
        # seam action names -> ARC action calls on the backend; drive it to the win.
        backend = _FakeArcBackend(width=3)
        adapter = ArcEnvAdapter(backend=backend)
        adapter.observe()  # prime last_frame via reset
        res = adapter.act(["ACTION3", "ACTION3"])
        self.assertEqual(res["executed"], ["ACTION3", "ACTION3"])  # seam names forwarded as ARC tokens
        self.assertTrue(res["done"])
        self.assertEqual(res["current_frame"]["grid"], [[0, 0, 2]])

    def test_action_normalization_int_and_enum(self):
        # A backend may enumerate actions as ints or enum-likes; normalize to ACTIONk seam names.
        class _Enum:
            def __init__(self, name):
                self.name = name

        frame = {"available_actions": [1, _Enum("ACTION5"), "ACTION3"]}
        self.assertEqual(
            ArcEnvAdapter._extract_actions(frame), ["ACTION1", "ACTION5", "ACTION3"]
        )

    def test_missing_sdk_raises_clear_runtime_error(self):
        # No backend supplied and the SDK module is absent -> a clear RuntimeError naming it.
        with self.assertRaises(RuntimeError) as ctx:
            ArcEnvAdapter(backend_module="definitely_not_an_arc_sdk_xyz")
        msg = str(ctx.exception)
        self.assertIn("definitely_not_an_arc_sdk_xyz", msg)
        self.assertIn("ARC-AGI-3", msg)


class SmokeRunTests(unittest.TestCase):
    def tearDown(self):
        # smoke_run monkeypatches EwmAgent._vision_available; restore the real probe.
        importlib.reload(sys.modules["bench.arc_agi3_zonoid.ewm.agent"])

    def test_smoke_wins_and_visits_model_modes(self):
        summary = smoke_run()
        self.assertTrue(summary["won"])
        self.assertTrue(summary["program_adopted"])
        self.assertEqual(summary["levels_completed"], 2)
        self.assertGreaterEqual(summary["actions_taken"], 1)
        # The model-based path must have been exercised: SYNTHESIZE + (PLAN|EXECUTE).
        modes = set(summary["modes_visited"])
        self.assertIn("SYNTHESIZE", modes)
        self.assertTrue(
            modes & {"PLAN", "EXECUTE"},
            f"expected PLAN or EXECUTE in modes, got {summary['modes_visited']}",
        )
        # Summary carries the required keys.
        for key in (
            "won",
            "levels_completed",
            "actions_taken",
            "modes_visited",
            "program_adopted",
            "decide_calls",
            "reflect_calls",
        ):
            self.assertIn(key, summary)


class SmokeArtifactTests(unittest.TestCase):
    """--smoke / smoke_run must create out/ewm-runs/{game}-{ts}/, pass it as artifacts_dir, expose
    it on the summary, and populate it with the expected attempt + run artifacts."""

    def tearDown(self):
        importlib.reload(sys.modules["bench.arc_agi3_zonoid.ewm.agent"])

    def test_smoke_run_populates_artifacts_dir(self):
        import json
        import os

        summary = smoke_run()
        artifacts_dir = summary.get("artifacts_dir")
        self.assertTrue(artifacts_dir)
        self.assertIn(os.path.join("out", "ewm-runs"), artifacts_dir)
        self.assertTrue(os.path.isdir(artifacts_dir))
        files = os.listdir(artifacts_dir)
        # At least one per-attempt artifact and the end-of-run suite dump.
        self.assertTrue(any(f.endswith("-SYNTHESIZE.json") for f in files), files)
        self.assertIn("transition-suite.json", files)
        # The smoke run wins (adopts a program) -> final-program.py is written.
        self.assertIn("final-program.py", files)
        # A synthesize artifact round-trips as JSON with the expected keys.
        synth_files = sorted(f for f in files if f.endswith("-SYNTHESIZE.json"))
        with open(os.path.join(artifacts_dir, synth_files[0]), encoding="utf-8") as fh:
            art = json.load(fh)
        for key in ("mode", "prompt_text", "raw_llm_response",
                    "extracted_program_source", "validation_report", "adopted"):
            self.assertIn(key, art)


class GraphFlagTests(unittest.TestCase):
    """The --graph on|off flag (default off) and the DaemonGraph builder used by the live path."""

    def test_graph_flag_rejects_bad_choice(self):
        # argparse enforces choices=("on","off"); a bad value exits non-zero before any live run.
        with self.assertRaises(SystemExit):
            driver_mod.main(["--game", "ls20", "--graph", "bogus"])

    def test_live_run_accepts_graph_kwarg(self):
        self.assertIn("graph", driver_mod.live_run.__code__.co_varnames)

    def test_max_actions_passes_through_to_live_session(self):
        # The driver must forward --max-actions cleanly into build_live_session so a larger action
        # budget reaches the live session (Run-22: run 22 fires with a raised budget). We monkeypatch
        # build_live_session to capture the kwarg and short-circuit before any SDK/LLM work.
        from bench.arc_agi3_zonoid.ewm import live as live_mod

        captured = {}

        class _Sentinel(RuntimeError):
            pass

        def _fake_build(game, *, benchmarking_repo, max_actions, max_seconds):
            captured["max_actions"] = max_actions
            raise _Sentinel("short-circuit after capturing the budget")

        prev = live_mod.build_live_session
        live_mod.build_live_session = _fake_build
        try:
            with self.assertRaises(_Sentinel):
                driver_mod.live_run(
                    "ls20", benchmarking_repo=None, max_actions=240, max_seconds=60.0,
                )
        finally:
            live_mod.build_live_session = prev
        self.assertEqual(captured["max_actions"], 240)

    def test_main_forwards_max_actions_to_live_run(self):
        # End-to-end argparse -> live_run wiring: `--max-actions 240` reaches live_run's max_actions.
        captured = {}

        def _fake_live_run(game, **kwargs):
            captured.update(kwargs)
            captured["game"] = game
            return {"won": False}

        prev = driver_mod.live_run
        driver_mod.live_run = _fake_live_run
        try:
            driver_mod.main(["--game", "ls20", "--max-actions", "240"])
        finally:
            driver_mod.live_run = prev
        self.assertEqual(captured["max_actions"], 240)

    def test_default_max_actions_is_eighty(self):
        # The default budget is unchanged (80); Run-22 raises it via the flag, not the default.
        captured = {}

        def _fake_live_run(game, **kwargs):
            captured.update(kwargs)
            return {"won": False}

        prev = driver_mod.live_run
        driver_mod.live_run = _fake_live_run
        try:
            driver_mod.main(["--game", "ls20"])
        finally:
            driver_mod.live_run = prev
        self.assertEqual(captured["max_actions"], 80)

    def test_build_daemon_graph_uses_env_url(self):
        import os

        prev = os.environ.get("ZONOID_DAEMON_URL")
        os.environ["ZONOID_DAEMON_URL"] = "http://localhost:9999"
        try:
            graph = driver_mod._build_daemon_graph("ls20", "/tmp/artifacts-x")
        finally:
            if prev is None:
                os.environ.pop("ZONOID_DAEMON_URL", None)
            else:
                os.environ["ZONOID_DAEMON_URL"] = prev
        from bench.arc_agi3_zonoid.ewm.synth_graph import DaemonGraph

        self.assertIsInstance(graph, DaemonGraph)
        self.assertEqual(graph.daemon_url, "http://localhost:9999")
        self.assertEqual(graph.workspace, "/Users/imyu/Desktop/zonoid")
        self.assertEqual(graph.data_dir, "/tmp/artifacts-x")

    def test_build_daemon_graph_default_url(self):
        import os

        prev = os.environ.pop("ZONOID_DAEMON_URL", None)
        try:
            graph = driver_mod._build_daemon_graph("ls20", "/tmp/a")
        finally:
            if prev is not None:
                os.environ["ZONOID_DAEMON_URL"] = prev
        self.assertEqual(graph.daemon_url, "http://localhost:8787")


class BuildKbGateTaskKeyTests(unittest.TestCase):
    """Run-30: only a real ZONOID_TASK_KEY wires note writes into the graph — the "ewm-live-<game>"
    fallback is a synthetic key the daemon's phantom-node guard 404s, so the client must be marked
    synthetic (wires_to omitted) whenever the env var is unset."""

    def test_fallback_key_marks_client_synthetic(self):
        import os

        prev = os.environ.pop("ZONOID_TASK_KEY", None)
        try:
            gate = driver_mod._build_kb_gate("ls20")
        finally:
            if prev is not None:
                os.environ["ZONOID_TASK_KEY"] = prev
        self.assertEqual(gate.client.task_key, "ewm-live-ls20")
        self.assertTrue(gate.client.synthetic_task_key)

    def test_env_key_keeps_wiring(self):
        import os

        prev = os.environ.get("ZONOID_TASK_KEY")
        os.environ["ZONOID_TASK_KEY"] = "codex/some-real-task"
        try:
            gate = driver_mod._build_kb_gate("ls20")
        finally:
            if prev is None:
                os.environ.pop("ZONOID_TASK_KEY", None)
            else:
                os.environ["ZONOID_TASK_KEY"] = prev
        self.assertEqual(gate.client.task_key, "codex/some-real-task")
        self.assertFalse(gate.client.synthetic_task_key)


class LiveConfigWiringTests(unittest.TestCase):
    """Run-23 regression: the config knobs (bump quota + coverage persistence) must survive the REAL
    live_run AgentConfig constructor to the agent — NOT a bespoke test config.

    The Run-17..22 live silent-drop hypothesis was that live_run builds AgentConfig without a new
    exploration field, so the mechanism was test-green (bespoke configs) yet live-silent. These tests
    go through driver.live_run's own AgentConfig(...) call and assert the effective knob values reach
    the agent AND appear in the run summary's config_echo, so a dropped field FAILS here forever."""

    def _drive_live_run(self):
        """Call driver.live_run with a fake session + fake LLM, capturing the AgentConfig the driver
        actually constructs. Returns (captured_config, summary)."""
        from bench.arc_agi3_zonoid.ewm import live as live_mod
        from bench.arc_agi3_zonoid.ewm import llm_client as llm_mod
        from bench.arc_agi3_zonoid.ewm import agent as agent_mod

        captured = {}

        class _FakeSession:
            levels_completed = 0
            actions_taken = 0

            def open(self):
                return self

            def scorecard_url(self):
                return None

            def close(self):
                return None

        def _fake_build(game, *, benchmarking_repo, max_actions, max_seconds):
            return _FakeSession()

        class _FakeLlm:
            base_url = "http://x"
            api_key = "k"
            timeout_s = 300

        # Capture the config by wrapping EwmAgent: record the config, then short-circuit run().
        class _CapturingAgent:
            def __init__(self, *args, config=None, **kwargs):
                captured["config"] = config
                self._config = config

            def run(self):
                # Return a summary shaped like the real one; config_echo is what _finalize_telemetry
                # would emit, so the driver's summary passthrough is exercised too.
                cfg = self._config
                return {
                    "won": False,
                    "config_echo": {
                        "bump_probes": cfg.bump_probes,
                        "bump_quota_fraction": cfg.bump_quota_fraction,
                        "coverage_persistence": cfg.coverage_persistence,
                        "coverage_plateau_exhaust": cfg.coverage_plateau_exhaust,
                        "exploration_min_bump_actions": cfg.exploration_min_bump_actions,
                    },
                    "bumps_probed": 0,
                    "bump_due_batches": 0,
                    "bump_empty_batches": 0,
                    "hoist_phase": "reach",
                }

        # live_run does `from .agent import EwmAgent` at call time, so patch the source module attribute.
        prev_build = live_mod.build_live_session
        prev_from_env = llm_mod.LlmClient.from_env
        prev_agent = agent_mod.EwmAgent
        live_mod.build_live_session = _fake_build
        llm_mod.LlmClient.from_env = classmethod(lambda cls, timeout_s=120: _FakeLlm())
        agent_mod.EwmAgent = _CapturingAgent
        try:
            summary = driver_mod.live_run(
                "ls20", benchmarking_repo=None, max_actions=160, max_seconds=60.0, graph=False,
            )
        finally:
            live_mod.build_live_session = prev_build
            llm_mod.LlmClient.from_env = prev_from_env
            agent_mod.EwmAgent = prev_agent
        return captured["config"], summary

    def test_bump_and_persistence_knobs_survive_live_config_constructor(self):
        cfg, _summary = self._drive_live_run()
        # The exact fields whose live silence run 22 could not explain: they must reach the agent ON.
        self.assertTrue(cfg.bump_probes, "bump_probes dropped from live AgentConfig")
        self.assertGreater(cfg.bump_quota_fraction, 0.0, "bump_quota_fraction dropped/zeroed")
        self.assertTrue(cfg.coverage_persistence, "coverage_persistence dropped from live AgentConfig")

    def test_config_echo_surfaces_effective_knobs_in_summary(self):
        _cfg, summary = self._drive_live_run()
        echo = summary.get("config_echo")
        self.assertIsNotNone(echo, "config_echo missing from live_run summary — a drop would be silent")
        self.assertTrue(echo["bump_probes"])
        self.assertGreater(echo["bump_quota_fraction"], 0.0)
        self.assertTrue(echo["coverage_persistence"])
        # The driver must also forward the Run-23 diagnostics so a live drop is visible in the arm.
        for key in ("bump_due_batches", "bump_empty_batches", "bump_skip_reason", "player_colors"):
            self.assertIn(key, summary, f"driver dropped Run-23 diagnostic {key!r} from the summary")
        # And the Run-40 hoist-phase echo (next to the hoisted counters), so reach_probes=0 is
        # diagnosable live (no targets vs the phase never engaging — the run-39 ambiguity).
        self.assertEqual(summary.get("hoist_phase"), "reach",
                         "driver dropped the Run-40 hoist_phase echo from the summary")


class ImportPurityTests(unittest.TestCase):
    def test_module_import_is_sdk_free(self):
        # Importing the driver must not pull in any ARC SDK candidate or PIL.
        importlib.reload(driver_mod)
        sdk = {"arc_agi", "arc_agi_3", "arc_agi3", "arcagi3", "arc"}
        self.assertFalse(sdk & set(sys.modules), sdk & set(sys.modules))

    def test_arc_actions_constant(self):
        self.assertEqual(ARC_ACTIONS[0], "ACTION1")
        self.assertEqual(len(ARC_ACTIONS), 6)


if __name__ == "__main__":
    unittest.main()
