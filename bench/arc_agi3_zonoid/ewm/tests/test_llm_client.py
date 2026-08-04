"""Tests for the EWM LLM client: stdlib transport, multimodal messages, and the scripted FakeLlm."""

from __future__ import annotations

import io
import json
import unittest
from unittest import mock
from urllib import error

from bench.arc_agi3_zonoid.ewm import llm_client
from bench.arc_agi3_zonoid.ewm.llm_client import FakeLlm, LlmClient, LlmError


class _FakeResponse(io.BytesIO):
    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        self.close()
        return False


class _Recorder:
    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.calls: list[dict[str, object]] = []

    def __call__(self, req, timeout=None):  # noqa: ANN001
        self.calls.append(
            {
                "url": req.full_url,
                "method": req.get_method(),
                "headers": dict(req.header_items()),
                "body": None if req.data is None else json.loads(req.data.decode("utf-8")),
                "timeout": timeout,
            }
        )
        return _FakeResponse(json.dumps(self.payload).encode("utf-8"))


def _ok_payload(content: str) -> dict:
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}


class LlmClientTest(unittest.TestCase):
    def _client(self) -> LlmClient:
        return LlmClient("http://localhost:9000/v1", "toy-model", api_key="sk-test", timeout_s=5)

    def test_chat_route_body_and_auth(self) -> None:
        rec = _Recorder(_ok_payload("hello"))
        with mock.patch.object(llm_client.request, "urlopen", rec):
            out = self._client().chat(
                [{"role": "user", "content": "hi"}], max_tokens=64, temperature=0.0
            )
        self.assertEqual(out["content"], "hello")
        self.assertEqual(out["finish_reason"], "stop")
        call = rec.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "http://localhost:9000/v1/chat/completions")
        self.assertEqual(call["timeout"], 5)
        self.assertEqual(call["headers"].get("Authorization"), "Bearer sk-test")
        self.assertEqual(call["body"]["model"], "toy-model")
        self.assertEqual(call["body"]["max_tokens"], 64)

    def test_multimodal_message_passthrough(self) -> None:
        rec = _Recorder(_ok_payload("ok"))
        multimodal = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            }
        ]
        with mock.patch.object(llm_client.request, "urlopen", rec):
            self._client().chat(multimodal)
        sent = rec.calls[0]["body"]["messages"]
        self.assertEqual(sent[0]["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA")

    def test_no_api_key_omits_auth_header(self) -> None:
        rec = _Recorder(_ok_payload("x"))
        client = LlmClient("http://h/v1", "m")
        with mock.patch.object(llm_client.request, "urlopen", rec):
            client.chat([{"role": "user", "content": "q"}])
        self.assertNotIn("Authorization", rec.calls[0]["headers"])

    def test_network_error_raises_llm_error(self) -> None:
        def boom(req, timeout=None):  # noqa: ANN001
            raise error.URLError("refused")

        with mock.patch.object(llm_client.request, "urlopen", boom):
            with self.assertRaises(LlmError):
                self._client().chat([{"role": "user", "content": "q"}])

    def test_from_env(self) -> None:
        env = {
            llm_client.ENV_BASE_URL: "http://env/v1",
            llm_client.ENV_MODEL: "env-model",
            llm_client.ENV_API_KEY: "sk-env",
        }
        with mock.patch.dict("os.environ", env, clear=False):
            client = LlmClient.from_env()
        self.assertEqual(client.base_url, "http://env/v1")
        self.assertEqual(client.model, "env-model")
        self.assertEqual(client.api_key, "sk-env")

    def test_from_env_requires_base_and_model(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ValueError):
                LlmClient.from_env()

    def test_reasoning_effort_sent_in_body(self) -> None:
        rec = _Recorder(_ok_payload("ok"))
        client = LlmClient("http://h/v1", "m", reasoning_effort="none")
        with mock.patch.object(llm_client.request, "urlopen", rec):
            client.chat([{"role": "user", "content": "q"}])
        self.assertEqual(rec.calls[0]["body"]["reasoning_effort"], "none")

    def test_reasoning_effort_omitted_when_unset(self) -> None:
        rec = _Recorder(_ok_payload("ok"))
        with mock.patch.object(llm_client.request, "urlopen", rec):
            self._client().chat([{"role": "user", "content": "q"}])
        self.assertNotIn("reasoning_effort", rec.calls[0]["body"])

    def test_from_env_reads_reasoning_effort(self) -> None:
        env = {
            llm_client.ENV_BASE_URL: "http://env/v1",
            llm_client.ENV_MODEL: "env-model",
            llm_client.ENV_REASONING_EFFORT: "none",
        }
        with mock.patch.dict("os.environ", env, clear=True):
            client = LlmClient.from_env()
        self.assertEqual(client.reasoning_effort, "none")

    def test_empty_content_falls_back_to_reasoning(self) -> None:
        payload = {
            "choices": [
                {
                    "message": {"content": "", "reasoning": "```python\nx = 1\n```"},
                    "finish_reason": "length",
                }
            ]
        }
        rec = _Recorder(payload)
        with mock.patch.object(llm_client.request, "urlopen", rec):
            out = self._client().chat([{"role": "user", "content": "q"}])
        self.assertIn("x = 1", out["content"])


class FakeLlmTest(unittest.TestCase):
    def test_returns_queued_and_records_messages(self) -> None:
        fake = FakeLlm(["first", {"content": "second", "finish_reason": "stop"}])
        r1 = fake.chat([{"role": "user", "content": "a"}])
        r2 = fake.chat([{"role": "user", "content": "b"}], max_tokens=10)
        self.assertEqual(r1["content"], "first")
        self.assertEqual(r2["content"], "second")
        self.assertEqual(r2["finish_reason"], "stop")
        self.assertEqual(len(fake.received), 2)
        self.assertEqual(fake.received[1]["max_tokens"], 10)
        self.assertEqual(fake.last_messages(), [{"role": "user", "content": "b"}])

    def test_exhausted_script_raises(self) -> None:
        fake = FakeLlm(["only"])
        fake.chat([{"role": "user", "content": "a"}])
        with self.assertRaises(LlmError):
            fake.chat([{"role": "user", "content": "b"}])


if __name__ == "__main__":
    unittest.main()
