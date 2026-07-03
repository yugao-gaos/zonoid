"""DEV-ONLY CLI-backed LLM client for the EWM synthesis *ceiling test*. NEVER SHIPS.

This module exists so a developer can point the offline synthesis state machine
(:class:`~.synth_graph.SynthSession`) at a *frontier* model — the local ``claude`` CLI — to answer
one question: can a strong model write a validating world-model program from the SAME recorded
transitions a weak local model failed on? It is a diagnostic harness, not a product code path:

  * It shells out to the ``claude`` binary on the developer's machine. There is no such binary in
    CI or production, and nothing in the shipped agent imports this file.
  * It satisfies ONLY the ``chat(messages, max_tokens, temperature) -> {content, ...}`` seam that
    :class:`~.llm_client.LlmClient` / :class:`~.llm_client.FakeLlm` expose, so it drops in wherever a
    real client would — but purely for local dev-time experiments (see ``dev_ceiling.py``).

It is deliberately minimal: flatten the chat messages to a single text prompt (system + user;
image parts are dropped with an ``[image omitted]`` marker since the CLI path is text-only), pipe
that prompt to ``claude -p --output-format text`` over stdin, and return the stdout as ``content``.
No tools, no permission bypass, no MCP — pure text generation.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any


def _flatten_content(content: Any) -> str:
    """Flatten one message's ``content`` (str OR list of OpenAI multimodal parts) to plain text.

    Image parts (``{"type": "image_url", ...}``) are text-unrepresentable on the CLI path, so they
    are replaced by a single ``[image omitted]`` marker rather than dropped silently — the model
    still sees that a frame image *would* have been here.
    """

    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        for part in content:
            if isinstance(part, dict):
                ptype = part.get("type")
                if ptype == "text":
                    pieces.append(str(part.get("text", "")))
                elif ptype == "image_url":
                    pieces.append("[image omitted]")
                else:
                    # Unknown part shape: keep any text-ish payload, else mark it omitted.
                    text = part.get("text")
                    pieces.append(str(text) if isinstance(text, str) else "[image omitted]")
            else:
                pieces.append(str(part))
        return "\n".join(pieces)
    return str(content or "")


def _messages_to_prompt(messages: list[dict[str, Any]]) -> str:
    """Flatten a chat ``messages`` list to one text prompt, labelling each turn by role.

    System and user turns are concatenated (in order) with ``ROLE:`` headers so the frontier model
    still sees the system instruction and the user payload as distinct sections, matching how the
    OpenAI-shaped client would have delivered them.
    """

    blocks: list[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "user")).upper()
        text = _flatten_content(msg.get("content"))
        blocks.append(f"{role}:\n{text}")
    return "\n\n".join(blocks)


class CliLlm:
    """DEV-ONLY :class:`chat` client that generates via the local ``claude`` CLI subprocess.

    Satisfies the same ``chat(messages, max_tokens, temperature) -> {content, finish_reason, raw}``
    interface as :class:`~.llm_client.LlmClient`. ``max_tokens`` / ``temperature`` are accepted for
    interface parity but not forwarded — the CLI owns those. Each call flattens the messages to one
    stdin prompt, runs ``claude -p --output-format text`` (120s timeout, one retry on
    timeout/failure), and returns stdout as ``content``.
    """

    def __init__(
        self,
        *,
        binary: str = "claude",
        timeout_s: int | None = None,
        retries: int = 1,
        runner: Any = None,
    ) -> None:
        self.binary = binary
        # Default 120s per the ceiling-test spec; overridable via EWM_CLI_TIMEOUT_S because a
        # cold-start frontier-CLI EDIT completion (whole world-model program) can exceed 120s.
        if timeout_s is None:
            env_val = os.environ.get("EWM_CLI_TIMEOUT_S")
            timeout_s = int(env_val) if env_val and env_val.isdigit() else 120
        self.timeout_s = timeout_s
        self.retries = retries
        # Injectable subprocess runner (defaults to subprocess.run) so tests can monkeypatch the
        # shell-out. Signature: runner(args, *, input, capture_output, text, timeout) -> CompletedProcess.
        self._runner = runner if runner is not None else subprocess.run

    def _invoke(self, prompt: str) -> str:
        args = [self.binary, "-p", "--output-format", "text"]
        attempts = self.retries + 1
        last_exc: Exception | None = None
        for _ in range(attempts):
            try:
                proc = self._runner(
                    args,
                    input=prompt,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_s,
                )
            except subprocess.TimeoutExpired as exc:
                last_exc = exc
                continue
            except OSError as exc:
                last_exc = exc
                continue
            if getattr(proc, "returncode", 1) == 0:
                return str(getattr(proc, "stdout", "") or "")
            # Non-zero exit: keep the stderr for the final error and retry.
            last_exc = RuntimeError(
                f"claude CLI exited {getattr(proc, 'returncode', '?')}: "
                f"{str(getattr(proc, 'stderr', '') or '').strip()[:500]}"
            )
        raise RuntimeError(f"claude CLI invocation failed after {attempts} attempt(s): {last_exc!r}")

    def chat(
        self,
        messages: list[dict[str, Any]],
        max_tokens: int = 1024,
        temperature: float = 0.0,
    ) -> dict[str, Any]:
        prompt = _messages_to_prompt(messages)
        content = self._invoke(prompt)
        return {"content": content, "finish_reason": "stop", "raw": {"cli": True}}
