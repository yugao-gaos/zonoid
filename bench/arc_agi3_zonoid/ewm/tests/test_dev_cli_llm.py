"""Tests for the DEV-ONLY CliLlm ceiling-test client (subprocess monkeypatched — never shells out)."""

from __future__ import annotations

import subprocess
import unittest

from bench.arc_agi3_zonoid.ewm.dev_cli_llm import (
    CliLlm,
    _flatten_content,
    _messages_to_prompt,
)


class _FakeProc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FlattenTests(unittest.TestCase):
    def test_string_content_passthrough(self):
        self.assertEqual(_flatten_content("hello"), "hello")

    def test_text_parts_joined(self):
        parts = [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]
        self.assertEqual(_flatten_content(parts), "a\nb")

    def test_image_part_dropped_with_marker(self):
        parts = [
            {"type": "text", "text": "look:"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,zzz"}},
        ]
        out = _flatten_content(parts)
        self.assertIn("look:", out)
        self.assertIn("[image omitted]", out)
        self.assertNotIn("base64", out)

    def test_messages_to_prompt_labels_roles(self):
        prompt = _messages_to_prompt(
            [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "usr"},
            ]
        )
        self.assertIn("SYSTEM:\nsys", prompt)
        self.assertIn("USER:\nusr", prompt)


class CliLlmTests(unittest.TestCase):
    def test_chat_invokes_claude_and_returns_stdout(self):
        seen = {}

        def runner(args, *, input, capture_output, text, timeout):
            seen["args"] = args
            seen["input"] = input
            seen["timeout"] = timeout
            return _FakeProc(returncode=0, stdout="```python\nx = 1\n```")

        llm = CliLlm(runner=runner, timeout_s=120)
        out = llm.chat(
            [
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "write code"},
            ]
        )
        self.assertEqual(out["content"], "```python\nx = 1\n```")
        self.assertEqual(seen["args"], ["claude", "-p", "--output-format", "text"])
        self.assertEqual(seen["timeout"], 120)
        # The prompt is delivered on stdin (input=), flattened with role labels.
        self.assertIn("SYSTEM:\nbe terse", seen["input"])
        self.assertIn("USER:\nwrite code", seen["input"])

    def test_image_parts_omitted_from_stdin_prompt(self):
        seen = {}

        def runner(args, *, input, capture_output, text, timeout):
            seen["input"] = input
            return _FakeProc(returncode=0, stdout="ok")

        llm = CliLlm(runner=runner)
        llm.chat(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "grid:"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                    ],
                }
            ]
        )
        self.assertIn("grid:", seen["input"])
        self.assertIn("[image omitted]", seen["input"])
        self.assertNotIn("AAAA", seen["input"])

    def test_retry_once_on_timeout_then_succeeds(self):
        calls = {"n": 0}

        def runner(args, *, input, capture_output, text, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                raise subprocess.TimeoutExpired(cmd=args, timeout=timeout)
            return _FakeProc(returncode=0, stdout="recovered")

        llm = CliLlm(runner=runner, retries=1)
        out = llm.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(out["content"], "recovered")
        self.assertEqual(calls["n"], 2)

    def test_raises_after_exhausting_retries(self):
        def runner(args, *, input, capture_output, text, timeout):
            raise subprocess.TimeoutExpired(cmd=args, timeout=timeout)

        llm = CliLlm(runner=runner, retries=1)
        with self.assertRaises(RuntimeError):
            llm.chat([{"role": "user", "content": "hi"}])

    def test_nonzero_exit_raises_with_stderr(self):
        def runner(args, *, input, capture_output, text, timeout):
            return _FakeProc(returncode=2, stdout="", stderr="boom")

        llm = CliLlm(runner=runner, retries=0)
        with self.assertRaises(RuntimeError) as ctx:
            llm.chat([{"role": "user", "content": "hi"}])
        self.assertIn("boom", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
