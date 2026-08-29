"""Tests for the ARC-AGI-3 Zonoid runner contract.

These tests pin the CLI-agent path and the reusable Zonoid context hook so the benchmark runner
can drive a local authenticated CLI without provider API keys and can hand the official checkout a
single env-backed context payload.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from bench.arc_agi3_zonoid import adapter as adapter_mod
from bench.arc_agi3_zonoid import runner as runner_mod


class RunnerContractTests(unittest.TestCase):
    def test_context_payload_and_env_include_task_instructions(self) -> None:
        payload = adapter_mod.zonoid_context_payload(
            enabled=True,
            daemon_url="http://127.0.0.1:8787",
            workspace="/tmp/zonoid-workspace",
            task_key="task-123",
            kb_snapshot="snapshot-1",
        )

        self.assertTrue(payload["enabled"])
        self.assertEqual(payload["daemon_url"], "http://127.0.0.1:8787")
        self.assertEqual(payload["workspace"], "/tmp/zonoid-workspace")
        self.assertEqual(payload["task_key"], "task-123")
        self.assertEqual(payload["kb_snapshot"], "snapshot-1")
        self.assertIn("task-123", payload["task_instructions"])
        self.assertIn("overlay/note", payload["task_instructions"])

        with tempfile.TemporaryDirectory() as tmpdir:
            context_json = adapter_mod.write_zonoid_context_file(payload, tmpdir, arm="zonoid_on")
            env = adapter_mod.zonoid_context_env(payload, context_json=context_json)

            self.assertEqual(env["ZONOID_ENABLED"], "1")
            self.assertEqual(env["ZONOID_DAEMON_URL"], "http://127.0.0.1:8787")
            self.assertEqual(env["ZONOID_WORKSPACE"], "/tmp/zonoid-workspace")
            self.assertEqual(env["ZONOID_TASK_KEY"], "task-123")
            self.assertEqual(env["ZONOID_KB_SNAPSHOT"], "snapshot-1")
            self.assertEqual(env["ZONOID_CONTEXT_JSON"], context_json)
            self.assertIn("task-123", env["ZONOID_TASK_INSTRUCTIONS"])

            context_path = Path(context_json)
            self.assertTrue(context_path.is_file())
            parsed = json.loads(context_path.read_text(encoding="utf-8"))
            self.assertEqual(parsed["task_key"], "task-123")
            self.assertIn("/overlay/note", parsed["task_instructions"])

    def test_official_commands_use_local_cli_config_when_requested(self) -> None:
        self.assertEqual(
            runner_mod._official_commands(["ls20"], local_cli=True),
            [["uv", "run", "main.py", "--game=ls20", "--config=zonoid-local-cli"]],
        )
        self.assertEqual(
            runner_mod._official_commands([], local_cli=True),
            [["uv", "run", "main.py", "--config=zonoid-local-cli"]],
        )
        self.assertEqual(
            runner_mod._official_commands(["ls20"], local_cli=False),
            [["uv", "run", "main.py", "--game=ls20"]],
        )

    def test_enable_agent_tools_adds_claude_bypass_flag_once(self) -> None:
        self.assertEqual(
            runner_mod._enable_agent_tools("claude -p"),
            "claude -p --dangerously-skip-permissions",
        )
        self.assertEqual(
            runner_mod._enable_agent_tools("claude -p --dangerously-skip-permissions"),
            "claude -p --dangerously-skip-permissions",
        )

    def test_preflight_accepts_agent_command_without_provider_api_keys(self) -> None:
        def fake_which(name: str) -> str | None:
            if name == "codex":
                return "/opt/homebrew/bin/codex"
            if name in {"node", "uv"}:
                return f"/opt/homebrew/bin/{name}"
            return None

        fake_module = SimpleNamespace(__file__="/tmp/arc_agi.py")
        with mock.patch.object(runner_mod.shutil, "which", side_effect=fake_which), mock.patch.object(
            adapter_mod.importlib,
            "import_module",
            return_value=fake_module,
        ):
            report = runner_mod.preflight(agent_command="codex exec")

        self.assertTrue(report["ok"])
        self.assertEqual(report["checks"]["agent_command_program"], "/opt/homebrew/bin/codex")
        self.assertEqual(report["blockers"], [])

    def test_run_agent_arm_injects_zonoid_context_env(self) -> None:
        seen: dict[str, object] = {}

        class _Proc:
            def __init__(self) -> None:
                self.returncode = 0
                self.stdout = json.dumps(
                    {"task_id": "task-123", "predicted": "SOLVED", "correct": True}
                )
                self.stderr = ""

        def fake_run(command, *, input, env, text, capture_output):  # noqa: ANN001
            seen["command"] = command
            seen["input"] = input
            seen["env"] = env
            seen["text"] = text
            seen["capture_output"] = capture_output
            return _Proc()

        with tempfile.TemporaryDirectory() as tmpdir:
            config = adapter_mod.build_config(
                arm="zonoid_on",
                max_steps=3,
                task_ids=["task-123"],
                out_dir=tmpdir,
                zonoid_enabled=True,
                daemon_url="http://127.0.0.1:8787",
                workspace="/tmp/zonoid-workspace",
                task_key="task-123",
                kb_snapshot="snapshot-1",
            )
            context_json = adapter_mod.write_zonoid_context_file(
                config["zonoid"], tmpdir, arm="zonoid_on"
            )
            config["zonoid"]["context_json"] = context_json

            with mock.patch.object(runner_mod.subprocess, "run", side_effect=fake_run):
                records = adapter_mod.run_agent_arm(config, agent_command="codex exec")

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["question"], "task-123")
        self.assertEqual(records[0]["predicted"], "SOLVED")
        self.assertTrue(records[0]["correct"])
        self.assertEqual(seen["command"], ["codex", "exec"])
        self.assertIn("Task id: task-123", str(seen["input"]))
        env = seen["env"]
        self.assertEqual(env["ZONOID_ENABLED"], "1")
        self.assertEqual(env["ZONOID_TASK_KEY"], "task-123")
        self.assertEqual(env["ZONOID_CONTEXT_JSON"], context_json)


if __name__ == "__main__":
    unittest.main()
