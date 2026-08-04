"""Subprocess-based Python REPL for LLM-written world-model code.

The parent exposes a single entry point, :func:`run_snippet`, which launches an
isolated Python subprocess, streams a bootstrap program into it, feeds in a snapshot
of the current game state, and services ``action()`` calls the snippet makes by
driving a caller-supplied ``step_env_callback``. Budget guards live entirely on the
parent side (the action handler): the child asks to run a batch of actions and the
parent decides how many actually execute and why it stopped.

Design goals:

  - The snippet sees FrameView-style objects (``grid``, ``ascii``, ``level``,
    ``step``, lazy ``.segmentation``), ``previous_frame``, ``history``,
    ``transitions``, ``last_transition``, ``valid_actions``, ``last_action_result``,
    ``remaining_actions``, ``remaining_seconds``, and a callable
    ``action(actions, expect=None)``.
  - Only whitelisted builtins and a small set of stdlib modules are importable.
  - Snippet stdout is captured and capped so a runaway ``print`` can't flood the LLM
    context.

Standard-library only; no project imports at module load (the segmentation source is
inlined into the child bootstrap so the sandbox can call it without a project path).
"""

from __future__ import annotations

import inspect
import json
import os
import queue
import signal
import subprocess
import sys
import textwrap
import threading
import time
from typing import Any, Callable

from . import segmentation as _segmentation

# Cap on snippet stdout returned to the caller (characters), so a runaway print
# cannot flood the LLM context window.
OUTPUT_CAP = 4096
_TRUNCATION_MARKER = "\n... [output truncated]"

# Whitelisted stdlib modules importable inside the sandbox.
SAFE_MODULES = (
    "bisect",
    "collections",
    "copy",
    "fractions",
    "functools",
    "heapq",
    "itertools",
    "json",
    "math",
    "operator",
    "random",
    "re",
    "statistics",
    "string",
)


def _cap_output(text: str) -> str:
    if len(text) <= OUTPUT_CAP:
        return text
    keep = OUTPUT_CAP - len(_TRUNCATION_MARKER)
    return text[:keep] + _TRUNCATION_MARKER


# --------------------------------------------------------------------------- #
# Child bootstrap program.
#
# Runs in an isolated ``python3 -I -S`` process. It speaks newline-delimited JSON
# over stdin/stdout with the parent: an initial state message, then ``action``
# requests answered by the parent, then a final ``final``/``error`` message.
# --------------------------------------------------------------------------- #
_SANDBOX_BOOTSTRAP = textwrap.dedent(
    r'''
    import builtins
    import contextlib
    import io
    import json
    import sys
    import traceback

    __SEGMENTATION_SOURCE__

    HOST_STDOUT = sys.stdout

    SAFE_MODULES = __SAFE_MODULES__
    SAFE_BUILTINS = {
        "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes",
        "callable", "chr", "complex", "dict", "dir", "divmod", "enumerate",
        "Exception", "filter", "float", "format", "frozenset", "getattr",
        "hasattr", "hash", "hex", "int", "isinstance", "issubclass", "iter",
        "len", "list", "map", "max", "min", "next", "oct", "ord", "pow",
        "print", "range", "repr", "reversed", "round", "set", "slice",
        "sorted", "str", "sum", "tuple", "TypeError", "type", "ValueError",
        "RuntimeError", "zip",
    }


    def _send(payload):
        HOST_STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
        HOST_STDOUT.flush()


    def _recv():
        line = sys.stdin.readline()
        if not line:
            raise EOFError("sandbox input closed")
        return json.loads(line)


    def _grid_ascii(grid):
        return "\n".join("".join(str(v) for v in row) for row in grid)


    class FrameView:
        def __init__(self, *, grid, step, level):
            self._grid = [list(row) for row in (grid or [])]
            self.step = int(step)
            self.level = int(level)
            self.shape = (len(self._grid), len(self._grid[0]) if self._grid else 0)
            self._segmentation = None
            self._ascii = None

        @property
        def grid(self):
            return self._grid

        @property
        def ascii(self):
            if self._ascii is None:
                self._ascii = _grid_ascii(self._grid)
            return self._ascii

        @property
        def segmentation(self):
            if self._segmentation is None:
                self._segmentation = segment_grid(self._grid)
            return self._segmentation

        def __str__(self):
            rows, cols = self.shape
            return "FrameView(level=%d, step=%d, shape=%dx%d)" % (
                self.level, self.step, rows, cols,
            )

        __repr__ = __str__


    class HistoryEntryView:
        def __init__(self, *, action, frame):
            self.action = action
            self.frame = frame

        def __str__(self):
            return "HistoryEntryView(action=%r, frame=%s)" % (self.action, self.frame)

        __repr__ = __str__


    class TransitionView:
        def __init__(self, *, action, before_frame, after_frame, result):
            self.action = action
            self.before_frame = before_frame
            self.after_frame = after_frame
            self.frame = after_frame
            self.result = dict(result) if isinstance(result, dict) else {}

        def __str__(self):
            return "TransitionView(action=%r, before=%s, after=%s)" % (
                self.action, self.before_frame, self.after_frame,
            )

        __repr__ = __str__


    def _frame_from_payload(payload):
        if not isinstance(payload, dict):
            return None
        return FrameView(
            grid=payload.get("grid", []),
            step=payload.get("step", 0),
            level=payload.get("level", 0),
        )


    def _history_from_payload(payload):
        items = []
        for entry in payload or []:
            if not isinstance(entry, dict):
                continue
            items.append(
                HistoryEntryView(
                    action=str(entry.get("action", "")),
                    frame=_frame_from_payload(entry.get("frame")),
                )
            )
        return items


    def _transitions_from_history(history, last_action_result):
        transitions = []
        for index, entry in enumerate(history):
            action = str(getattr(entry, "action", "") or "").strip()
            if not action:
                continue
            before_frame = history[index - 1].frame if index > 0 else None
            transitions.append(
                TransitionView(
                    action=action,
                    before_frame=before_frame,
                    after_frame=entry.frame,
                    result={},
                )
            )
        if transitions and isinstance(last_action_result, dict):
            transitions[-1].result = dict(last_action_result)
        return transitions


    def _json_safe(value):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            return {str(k): _json_safe(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_json_safe(v) for v in value]
        return str(value)


    def _sanitize_exception(exc):
        extracted = traceback.extract_tb(exc.__traceback__)
        user_frames = [f for f in extracted if f.filename == "<repl_snippet>"]
        lines = ["Traceback (most recent call last):"]
        for f in user_frames or extracted[-1:]:
            lines.append('  File "<repl_snippet>", line %d, in %s' % (f.lineno, f.name))
        lines.append("%s: %s" % (exc.__class__.__name__, exc))
        return "\n".join(lines)


    def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = str(name or "").split(".", 1)[0]
        if root not in SAFE_MODULES:
            raise ImportError("Module %r is not allowed in the sandbox." % (name,))
        return builtins.__import__(name, globals, locals, fromlist, level)


    def _normalize_actions(actions):
        if isinstance(actions, (str, dict)):
            items = [actions]
        elif isinstance(actions, (list, tuple)):
            items = list(actions)
        else:
            raise TypeError(
                "action(actions) expects a string, an action dict, or a list of them."
            )
        if not items:
            raise ValueError("action(actions) requires at least one action.")
        normalized = []
        for index, item in enumerate(items, start=1):
            if isinstance(item, str):
                name = item.strip()
                if not name:
                    raise ValueError("Action %d is empty." % index)
                normalized.append({"action": name})
            elif isinstance(item, dict):
                name = str(item.get("action", "")).strip()
                if not name:
                    raise ValueError("Action %d is missing an `action` field." % index)
                entry = {"action": name}
                if "row" in item:
                    entry["row"] = item.get("row")
                if "col" in item:
                    entry["col"] = item.get("col")
                normalized.append(entry)
            else:
                raise TypeError("Action %d must be a string or a dict." % index)
        return normalized


    def _normalize_expect(expect, count):
        # ``expect`` is an optional per-action list of predicted next grids or grid
        # hashes. Normalize to a list aligned with the action batch (or None).
        if expect is None:
            return None
        if not isinstance(expect, (list, tuple)):
            raise TypeError("expect must be a list aligned with the action batch.")
        items = list(expect)
        out = []
        for item in items:
            if item is None or isinstance(item, str):
                out.append(item)
            elif isinstance(item, (list, tuple)):
                out.append(_json_safe(item))
            else:
                raise TypeError("Each expect entry must be a grid, a hash string, or None.")
        return out


    def main():
        initial = _recv()

        runtime = {
            "__builtins__": {n: getattr(builtins, n) for n in SAFE_BUILTINS},
            "result": None,
        }
        runtime["__builtins__"]["__import__"] = _safe_import
        action_results = []

        def _refresh_state(state):
            current = _frame_from_payload(state.get("current_frame"))
            history = _history_from_payload(state.get("history"))
            last_result = state.get("last_action_result")
            last_result = dict(last_result) if isinstance(last_result, dict) else {}
            transitions = _transitions_from_history(history, last_result)
            last_transition = transitions[-1] if transitions else None
            runtime["current_frame"] = current
            runtime["previous_frame"] = (
                last_transition.before_frame if last_transition is not None else None
            )
            runtime["history"] = history
            runtime["transitions"] = transitions
            runtime["last_transition"] = last_transition
            runtime["valid_actions"] = [str(a) for a in state.get("valid_actions", [])]
            runtime["last_action_result"] = last_result
            runtime["remaining_actions"] = int(state.get("remaining_actions", 0))
            runtime["remaining_seconds"] = float(state.get("remaining_seconds", 0.0))

        def action(actions, expect=None):
            normalized = _normalize_actions(actions)
            normalized_expect = _normalize_expect(expect, len(normalized))
            _send({
                "type": "action",
                "actions": normalized,
                "expect": normalized_expect,
            })
            reply = _recv()
            if reply.get("type") == "action_error":
                raise RuntimeError(str(reply.get("error", "action failed")))
            if reply.get("type") != "action_result":
                raise RuntimeError("Invalid action response from sandbox host.")
            outcome = reply.get("action_result") or {}
            action_results.append(outcome)
            _refresh_state(reply.get("state") or {})
            return outcome

        runtime["action"] = action
        _refresh_state(initial.get("state") or {})

        stdout = io.StringIO()
        try:
            compiled = compile(str(initial.get("code", "")), "<repl_snippet>", "exec")
            with contextlib.redirect_stdout(stdout):
                exec(compiled, runtime, runtime)
            _send({
                "type": "final",
                "stdout": stdout.getvalue(),
                "result": _json_safe(runtime.get("result")),
                "action_results": _json_safe(action_results),
            })
        except Exception as exc:  # noqa: BLE001
            _send({
                "type": "error",
                "error": _sanitize_exception(exc),
                "stdout": stdout.getvalue(),
                "action_results": _json_safe(action_results),
            })


    if __name__ == "__main__":
        main()
    '''
).replace(
    # Inline the segmentation source, stripping its ``from __future__`` import: a
    # future import is only legal at the top of a module, and this source is spliced
    # into the middle of the bootstrap.
    "__SEGMENTATION_SOURCE__\n",
    "\n".join(
        line
        for line in inspect.getsource(_segmentation).splitlines()
        if not line.startswith("from __future__ import")
    ),
).replace(
    "__SAFE_MODULES__", repr(set(SAFE_MODULES))
)


# --------------------------------------------------------------------------- #
# Parent side: budget guards + subprocess IPC.
# --------------------------------------------------------------------------- #

# Consecutive no-change actions that trigger a mid-batch abort.
NO_CHANGE_ABORT_THRESHOLD = 3


def _grid_hash(grid: Any) -> str:
    """Deterministic hash of a whole grid, so ``expect`` may be a predicted grid's
    hash rather than the grid itself. Hashes the raw rows, so a prediction reduces to
    plain cell-value equality."""
    import hashlib

    payload = repr([list(row) for row in (grid or [])]).encode()
    return hashlib.sha1(payload).hexdigest()[:16]


def _expect_matches(predicted: Any, actual_grid: Any) -> bool:
    """A prediction matches if it equals the actual grid, or its hash does."""
    if predicted is None:
        return True
    if isinstance(predicted, str):
        return _grid_hash(actual_grid) == predicted
    if isinstance(predicted, (list, tuple)):
        return [list(r) for r in predicted] == [list(r) for r in (actual_grid or [])]
    return False


class _BudgetGuard:
    """Parent-side action handler enforcing budget and mid-batch abort guards.

    Holds the mutable game state between action batches and drives the caller's
    ``step_env_callback`` one action at a time so it can stop the batch as soon as a
    guard trips. Once a terminal result is produced, later batches short-circuit and
    return the cached terminal result without stepping the environment.
    """

    def __init__(self, state: dict[str, Any], step_env_callback: Callable[[dict[str, Any]], dict[str, Any]]):
        self._state = dict(state)
        self._step = step_env_callback
        self._remaining = int(self._state.get("remaining_actions", 0))
        self._history = list(self._state.get("history") or [])
        self._level = int(self._get_frame(self._state.get("current_frame")).get("level", 0))
        self._score = self._score_of(self._state)
        self._terminal_result: dict[str, Any] | None = None

    @staticmethod
    def _get_frame(frame: Any) -> dict[str, Any]:
        return frame if isinstance(frame, dict) else {}

    @staticmethod
    def _score_of(state: dict[str, Any]) -> float:
        result = state.get("last_action_result")
        if isinstance(result, dict) and "score" in result:
            try:
                return float(result["score"])
            except (TypeError, ValueError):
                return 0.0
        return 0.0

    def _current_grid(self) -> Any:
        return self._get_frame(self._state.get("current_frame")).get("grid", [])

    def _state_snapshot(self) -> dict[str, Any]:
        return {
            "current_frame": self._state.get("current_frame"),
            "history": self._history,
            "last_action_result": self._state.get("last_action_result"),
            "valid_actions": self._state.get("valid_actions", []),
            "remaining_actions": self._remaining,
            "remaining_seconds": self._state.get("remaining_seconds", 0.0),
        }

    def handle(self, actions: list[dict[str, Any]], expect: Any) -> dict[str, Any]:
        # If a terminal result was already produced, do not step again.
        if self._terminal_result is not None:
            outcome = dict(self._terminal_result)
            outcome.update({
                "executed": [],
                "executed_count": 0,
                "stop_reason": "terminal",
            })
            return {"action_result": outcome, "state": self._state_snapshot()}

        requested = len(actions)
        stop_reason: str | None = None

        # Budget guard: truncate any batch that exceeds the remaining action budget.
        if requested > self._remaining:
            actions = actions[: self._remaining]
            stop_reason = "budget_exhausted"

        executed: list[dict[str, Any]] = []
        no_change_streak = 0
        done = False
        board_changed = False

        for index, single in enumerate(actions):
            before_grid = self._current_grid()
            step_out = self._step(single) or {}
            after_frame = self._get_frame(step_out.get("current_frame"))
            after_grid = after_frame.get("grid", before_grid)
            after_level = int(after_frame.get("level", self._level))
            result = step_out.get("action_result")
            result = dict(result) if isinstance(result, dict) else {}

            # Commit the step into our tracked state.
            self._state["current_frame"] = step_out.get("current_frame", self._state.get("current_frame"))
            self._state["last_action_result"] = result
            if "valid_actions" in step_out:
                self._state["valid_actions"] = step_out.get("valid_actions", [])
            if "remaining_seconds" in step_out:
                self._state["remaining_seconds"] = step_out.get("remaining_seconds")
            self._history.append({"action": single.get("action"), "frame": step_out.get("current_frame")})
            self._remaining = max(0, self._remaining - 1)
            executed.append(single)

            this_changed = [list(r) for r in after_grid] != [list(r) for r in before_grid]
            board_changed = board_changed or this_changed

            new_score = self._score_of({"last_action_result": result})

            # Terminal / done from the environment.
            if bool(result.get("done")) or bool(step_out.get("done")):
                done = True
                stop_reason = "done"
                break

            # Level transition.
            if after_level != self._level:
                self._level = after_level
                stop_reason = "level_transition"
                break

            # Score regression.
            if new_score < self._score:
                self._score = new_score
                stop_reason = "score_regression"
                break
            self._score = new_score

            # Expect-mismatch: caller predicted this action's next grid and was wrong.
            if expect is not None and index < len(expect):
                if not _expect_matches(expect[index], after_grid):
                    stop_reason = "expect_mismatch"
                    break

            # Consecutive no-change abort.
            if this_changed:
                no_change_streak = 0
            else:
                no_change_streak += 1
                if no_change_streak >= NO_CHANGE_ABORT_THRESHOLD:
                    stop_reason = "no_change"
                    break

        if stop_reason is None:
            stop_reason = "completed"

        outcome = {
            "executed": executed,
            "executed_count": len(executed),
            "stop_reason": stop_reason,
            "level": self._level,
            "board_changed": board_changed,
            "done": done,
            "remaining_actions": self._remaining,
            "last_action_result": self._state.get("last_action_result"),
        }
        if done:
            self._terminal_result = dict(outcome)
        return {"action_result": outcome, "state": self._state_snapshot()}


def _sandbox_env() -> dict[str, str]:
    return {
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PATH": os.environ.get("PATH", ""),
    }


def _send_json_line(handle: Any, payload: dict[str, Any]) -> None:
    handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    handle.flush()


def _kill_process_group(process: "subprocess.Popen[str]") -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        try:
            process.kill()
        except OSError:
            pass


def _close_pipes(process: "subprocess.Popen[str]") -> None:
    for handle in (process.stdin, process.stdout, process.stderr):
        try:
            if handle is not None:
                handle.close()
        except OSError:
            pass


def _wait_for_exit(process: "subprocess.Popen[str]", *, timeout: float = 1.0) -> None:
    try:
        process.wait(timeout=timeout)
        _close_pipes(process)
        return
    except subprocess.TimeoutExpired:
        _kill_process_group(process)
    except OSError:
        _close_pipes(process)
        return
    try:
        process.wait(timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        pass
    _close_pipes(process)


def run_snippet(
    code: str,
    state: dict[str, Any],
    budget: int,
    step_env_callback: Callable[[dict[str, Any]], dict[str, Any]],
    timeout_s: int = 30,
) -> dict[str, Any]:
    """Run LLM-written ``code`` in an isolated subprocess REPL.

    Parameters:
      - ``code``: the snippet source.
      - ``state``: initial game-state snapshot. Expected keys: ``current_frame``
        (a dict with ``grid``/``step``/``level``), ``history`` (list of
        ``{action, frame}``), ``last_action_result`` (dict), ``valid_actions``
        (list), ``remaining_seconds`` (number). ``remaining_actions`` is overridden
        by ``budget``.
      - ``budget``: remaining action budget; the guard truncates batches beyond it.
      - ``step_env_callback``: called with one normalized action dict per step,
        returns ``{current_frame, action_result, valid_actions?, remaining_seconds?,
        done?}``.
      - ``timeout_s``: wall-clock cap on the whole snippet run.

    Returns a dict: ``stdout`` (capped), ``result`` (snippet's ``result`` value),
    ``error`` (empty on success), ``action_results`` (list of per-batch outcomes).
    """
    init_state = dict(state)
    init_state["remaining_actions"] = int(budget)
    guard = _BudgetGuard(init_state, step_env_callback)
    host_action_results: list[dict[str, Any]] = []

    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "-S", "-c", _SANDBOX_BOOTSTRAP],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=_sandbox_env(),
            start_new_session=True,
        )
    except OSError:
        return {"error": "Sandbox process could not start.", "stdout": "", "result": None, "action_results": []}

    assert process.stdin is not None and process.stdout is not None and process.stderr is not None

    stdout_queue: "queue.Queue[str | None]" = queue.Queue()

    def _reader() -> None:
        for raw in process.stdout:  # type: ignore[union-attr]
            stdout_queue.put(raw)
        stdout_queue.put(None)

    threading.Thread(target=_reader, daemon=True).start()

    _send_json_line(process.stdin, {"code": code, "state": guard._state_snapshot()})

    deadline = time.monotonic() + max(1, int(timeout_s))
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _kill_process_group(process)
            _wait_for_exit(process)
            return {
                "error": "Snippet timed out after %ss" % timeout_s,
                "stdout": "",
                "result": None,
                "action_results": list(host_action_results),
            }

        try:
            line = stdout_queue.get(timeout=remaining)
        except queue.Empty:
            continue
        if line is None:
            stderr = process.stderr.read()
            _wait_for_exit(process)
            return {
                "error": (stderr.strip() or "Sandbox process exited unexpectedly."),
                "stdout": "",
                "result": None,
                "action_results": list(host_action_results),
            }

        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            _kill_process_group(process)
            _wait_for_exit(process)
            return {
                "error": "Sandbox process returned an invalid response.",
                "stdout": "",
                "result": None,
                "action_results": list(host_action_results),
            }

        msg_type = str(message.get("type", "")).strip()
        if msg_type == "action":
            try:
                payload = guard.handle(list(message.get("actions") or []), message.get("expect"))
            except Exception:  # noqa: BLE001
                _send_json_line(process.stdin, {"type": "action_error", "error": "action failed in host."})
                continue
            outcome = payload.get("action_result") or {}
            if isinstance(outcome, dict):
                host_action_results.append(dict(outcome))
            _send_json_line(process.stdin, {
                "type": "action_result",
                "action_result": outcome,
                "state": payload.get("state") or {},
            })
            continue

        if msg_type in {"final", "error"}:
            _wait_for_exit(process)
            return {
                "stdout": _cap_output(str(message.get("stdout", "") or "")),
                "result": message.get("result"),
                "error": str(message.get("error", "") or ""),
                "action_results": list(host_action_results),
            }

        _wait_for_exit(process)
        return {
            "error": "Sandbox process returned an unknown message type.",
            "stdout": "",
            "result": None,
            "action_results": list(host_action_results),
        }
