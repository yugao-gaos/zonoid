"""OpenAI-compatible chat client for the ARC-AGI-3 EWM agent (stdlib only).

The EWM agent makes two LLM calls per decision turn (a ``decide`` and a ``reflect``), each
potentially multimodal: a message's ``content`` may be a plain string or a list of parts, where
each part is ``{"type": "text", "text": ...}`` or
``{"type": "image_url", "image_url": {"url": ...}}`` (the ``url`` is a ``data:image/png;base64,...``
composite from :mod:`.vision`). This module wraps the OpenAI-compatible ``POST /chat/completions``
endpoint using only :mod:`urllib`, so the harness has no third-party HTTP dependency.

``LlmClient`` reads its config from the environment (``ARC_LLM_BASE_URL``, ``ARC_LLM_MODEL``,
``ARC_LLM_API_KEY``) via :meth:`LlmClient.from_env`, or takes it explicitly. ``FakeLlm`` is a
deterministic scripted stand-in for tests: it returns queued responses in order and records every
``messages`` list it received, so a test can assert on the exact prompt the agent built.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib import error, request

# Config environment variables (documented on the module so the agent and tests agree on names).
ENV_BASE_URL = "ARC_LLM_BASE_URL"
ENV_MODEL = "ARC_LLM_MODEL"
ENV_API_KEY = "ARC_LLM_API_KEY"
# Optional: disable/adjust chain-of-thought on thinking models (e.g. qwen35b-arc). Ollama's
# OpenAI-compatible endpoint honors `reasoning_effort:"none"`, which makes such models emit the
# answer directly in `message.content` instead of spending the whole token budget in `reasoning`.
ENV_REASONING_EFFORT = "ARC_LLM_REASONING_EFFORT"


class LlmError(RuntimeError):
    """Raised when a chat completion cannot be obtained (network/transport/protocol failure)."""


class LlmClient:
    """Minimal stdlib client for an OpenAI-compatible ``/chat/completions`` endpoint."""

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str | None = None,
        timeout_s: int = 120,
        reasoning_effort: str | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("LlmClient requires a base_url.")
        if not model:
            raise ValueError("LlmClient requires a model.")
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout_s = timeout_s
        self.reasoning_effort = reasoning_effort or None

    @classmethod
    def from_env(cls, timeout_s: int = 120) -> "LlmClient":
        """Build a client from ``ARC_LLM_BASE_URL`` / ``ARC_LLM_MODEL`` / ``ARC_LLM_API_KEY``.

        Honors the optional ``ARC_LLM_REASONING_EFFORT`` (e.g. ``"none"``) to disable
        chain-of-thought on thinking models so the answer lands in ``message.content``.
        """

        base_url = os.environ.get(ENV_BASE_URL, "")
        model = os.environ.get(ENV_MODEL, "")
        api_key = os.environ.get(ENV_API_KEY) or None
        reasoning_effort = os.environ.get(ENV_REASONING_EFFORT) or None
        if not base_url or not model:
            raise ValueError(
                f"set {ENV_BASE_URL} and {ENV_MODEL} to use LlmClient.from_env()"
            )
        return cls(
            base_url,
            model,
            api_key=api_key,
            timeout_s=timeout_s,
            reasoning_effort=reasoning_effort,
        )

    def chat(
        self,
        messages: list[dict[str, Any]],
        max_tokens: int = 1024,
        temperature: float = 0.0,
    ) -> dict[str, Any]:
        """POST a chat completion and return ``{content, raw, finish_reason}``.

        ``messages`` follow the OpenAI schema; a message's ``content`` may be a string or a list of
        multimodal parts. Returns a dict whose ``content`` is the assistant text; ``raw`` is the
        full decoded response. Raises :class:`LlmError` on any transport/protocol failure.
        """

        url = f"{self.base_url}/chat/completions"
        body = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if self.reasoning_effort is not None:
            body["reasoning_effort"] = self.reasoning_effort
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        req = request.Request(url, data=data, method="POST", headers=headers)
        try:
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:  # noqa: BLE001
            raise LlmError(f"chat completion failed: {exc!r}") from exc

        return _parse_completion(payload)


def _parse_completion(payload: Any) -> dict[str, Any]:
    """Extract ``{content, finish_reason, raw}`` from an OpenAI-compatible response body."""

    content = ""
    finish_reason = None
    if isinstance(payload, dict):
        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict):
                    content = message.get("content") or ""
                    # Thinking models (e.g. qwen35b-arc) may leave `content` empty and put the
                    # answer under `reasoning`. Fall back to it so the agent can still extract a
                    # fenced program / JSON when reasoning was not disabled.
                    if not content:
                        content = message.get("reasoning") or ""
                finish_reason = first.get("finish_reason")
    return {"content": str(content), "finish_reason": finish_reason, "raw": payload}


class FakeLlm:
    """Deterministic scripted chat client for tests.

    ``script`` is an ordered list of responses; each :meth:`chat` call pops the next one and
    records the ``messages`` it was given (in :attr:`received`). A script entry may be a plain
    string (returned as ``content``) or a full ``{content, ...}`` dict. Running past the end of the
    script raises, so a test that under-provisions responses fails loudly instead of hanging.
    """

    def __init__(self, script: list[Any] | None = None) -> None:
        self.script: list[Any] = list(script or [])
        self.received: list[dict[str, Any]] = []
        self.calls = 0

    def chat(
        self,
        messages: list[dict[str, Any]],
        max_tokens: int = 1024,
        temperature: float = 0.0,
    ) -> dict[str, Any]:
        self.received.append(
            {"messages": messages, "max_tokens": max_tokens, "temperature": temperature}
        )
        if self.calls >= len(self.script):
            raise LlmError(
                f"FakeLlm script exhausted after {self.calls} call(s); "
                "provide more scripted responses."
            )
        item = self.script[self.calls]
        self.calls += 1
        if isinstance(item, dict):
            content = str(item.get("content", ""))
            out = {"content": content, "finish_reason": item.get("finish_reason"), "raw": item}
            return out
        return {"content": str(item), "finish_reason": None, "raw": item}

    def last_messages(self) -> list[dict[str, Any]]:
        """The ``messages`` list from the most recent :meth:`chat` call (or ``[]``)."""

        return self.received[-1]["messages"] if self.received else []
