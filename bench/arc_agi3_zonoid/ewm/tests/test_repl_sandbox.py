"""REPL sandbox tests: snippet exec, output cap, import blocking, and every budget guard."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from arc_agi3_zonoid.ewm.repl_sandbox import OUTPUT_CAP, run_snippet  # noqa: E402


def _frame(grid, step=0, level=0):
    return {"grid": [list(r) for r in grid], "step": step, "level": level}


def _base_state(grid):
    return {
        "current_frame": _frame(grid),
        "history": [],
        "last_action_result": {"score": 0},
        "valid_actions": ["A", "B"],
        "remaining_seconds": 30.0,
    }


class ScriptedEnv:
    """A fake step_env_callback: replays a list of scripted step outcomes in order.

    Each scripted entry is a dict returned as-is (with ``current_frame`` filled from
    the ``grid``/``level``/``score``/``done`` shorthands). Once the script is
    exhausted, the last grid is repeated unchanged with score held.
    """

    def __init__(self, script, start_grid):
        self._script = list(script)
        self._i = 0
        self._last_grid = [list(r) for r in start_grid]
        self._last_level = 0
        self._last_score = 0
        self.calls = 0

    def __call__(self, action):
        self.calls += 1
        if self._i < len(self._script):
            entry = self._script[self._i]
            self._i += 1
            grid = entry.get("grid", self._last_grid)
            level = entry.get("level", self._last_level)
            score = entry.get("score", self._last_score)
            done = bool(entry.get("done", False))
        else:
            grid, level, score, done = self._last_grid, self._last_level, self._last_score, False
        self._last_grid = [list(r) for r in grid]
        self._last_level = level
        self._last_score = score
        return {
            "current_frame": _frame(grid, level=level),
            "action_result": {"score": score, "done": done},
            "done": done,
        }


class SnippetExecTest(unittest.TestCase):
    def test_result_and_stdout(self):
        env = ScriptedEnv([], [[0]])
        out = run_snippet(
            "print('hello')\nresult = current_frame.shape",
            _base_state([[0, 1], [2, 3]]),
            budget=5,
            step_env_callback=env,
        )
        self.assertEqual(out["error"], "")
        self.assertIn("hello", out["stdout"])
        self.assertEqual(out["result"], [2, 2])

    def test_segmentation_available_in_snippet(self):
        env = ScriptedEnv([], [[0]])
        out = run_snippet(
            "result = len(current_frame.segmentation['nodes'])",
            _base_state([[1, 2], [1, 2]]),
            budget=5,
            step_env_callback=env,
        )
        self.assertEqual(out["error"], "")
        self.assertEqual(out["result"], 2)

    def test_preloaded_state_names(self):
        env = ScriptedEnv([], [[0]])
        out = run_snippet(
            "result = [remaining_actions, len(valid_actions), remaining_seconds]",
            _base_state([[0]]),
            budget=7,
            step_env_callback=env,
        )
        self.assertEqual(out["error"], "")
        self.assertEqual(out["result"], [7, 2, 30.0])


class OutputCapTest(unittest.TestCase):
    def test_stdout_is_capped(self):
        env = ScriptedEnv([], [[0]])
        out = run_snippet(
            "print('x' * 20000)",
            _base_state([[0]]),
            budget=1,
            step_env_callback=env,
        )
        self.assertEqual(out["error"], "")
        self.assertLessEqual(len(out["stdout"]), OUTPUT_CAP)
        self.assertIn("truncated", out["stdout"])


class ImportBlockingTest(unittest.TestCase):
    def test_blocked_import_raises(self):
        env = ScriptedEnv([], [[0]])
        out = run_snippet(
            "import os\nresult = 1",
            _base_state([[0]]),
            budget=1,
            step_env_callback=env,
        )
        self.assertIn("not allowed", out["error"])

    def test_whitelisted_import_ok(self):
        env = ScriptedEnv([], [[0]])
        out = run_snippet(
            "import itertools\nresult = len(list(itertools.repeat(1, 3)))",
            _base_state([[0]]),
            budget=1,
            step_env_callback=env,
        )
        self.assertEqual(out["error"], "")
        self.assertEqual(out["result"], 3)


class BudgetGuardTest(unittest.TestCase):
    def _run_action(self, snippet, state, budget, script, start_grid):
        env = ScriptedEnv(script, start_grid)
        out = run_snippet(snippet, state, budget=budget, step_env_callback=env, timeout_s=30)
        self.assertEqual(out["error"], "", msg=out.get("error"))
        return out, env

    def test_budget_truncation(self):
        # Ask for 5 actions with a budget of 2; only 2 execute (each changes board).
        script = [{"grid": [[1]]}, {"grid": [[2]]}, {"grid": [[3]]}]
        snippet = "result = action(['A', 'A', 'A', 'A', 'A'])"
        out, env = self._run_action(snippet, _base_state([[0]]), 2, script, [[0]])
        r = out["result"]
        self.assertEqual(r["executed_count"], 2)
        self.assertEqual(r["stop_reason"], "budget_exhausted")
        self.assertEqual(env.calls, 2)

    def test_no_change_abort(self):
        # Every step returns the same grid => 3 consecutive no-change actions abort.
        script = [{"grid": [[0]]}] * 6
        snippet = "result = action(['A', 'A', 'A', 'A', 'A'])"
        out, _ = self._run_action(snippet, _base_state([[0]]), 10, script, [[0]])
        r = out["result"]
        self.assertEqual(r["stop_reason"], "no_change")
        self.assertEqual(r["executed_count"], 3)

    def test_level_transition_abort(self):
        # First action changes board and bumps level => abort after that action.
        script = [{"grid": [[1]], "level": 1}, {"grid": [[2]], "level": 1}]
        snippet = "result = action(['A', 'A', 'A'])"
        out, _ = self._run_action(snippet, _base_state([[0]]), 10, script, [[0]])
        r = out["result"]
        self.assertEqual(r["stop_reason"], "level_transition")
        self.assertEqual(r["executed_count"], 1)
        self.assertEqual(r["level"], 1)

    def test_score_regression_abort(self):
        script = [{"grid": [[1]], "score": 5}, {"grid": [[2]], "score": 2}]
        snippet = "result = action(['A', 'A', 'A'])"
        out, _ = self._run_action(snippet, _base_state([[0]]), 10, script, [[0]])
        r = out["result"]
        self.assertEqual(r["stop_reason"], "score_regression")
        self.assertEqual(r["executed_count"], 2)

    def test_expect_mismatch_grid(self):
        # Predict grid [[9]] but env returns [[1]] on the first action => abort.
        script = [{"grid": [[1]]}, {"grid": [[2]]}]
        snippet = "result = action(['A', 'A'], expect=[[[9]], [[9]]])"
        out, _ = self._run_action(snippet, _base_state([[0]]), 10, script, [[0]])
        r = out["result"]
        self.assertEqual(r["stop_reason"], "expect_mismatch")
        self.assertEqual(r["executed_count"], 1)

    def test_expect_match_grid_continues(self):
        # Correct predictions let the whole batch run.
        script = [{"grid": [[1]]}, {"grid": [[2]]}]
        snippet = "result = action(['A', 'A'], expect=[[[1]], [[2]]])"
        out, _ = self._run_action(snippet, _base_state([[0]]), 10, script, [[0]])
        r = out["result"]
        self.assertEqual(r["stop_reason"], "completed")
        self.assertEqual(r["executed_count"], 2)

    def test_expect_mismatch_by_hash(self):
        # Predict via a wrong hash string => abort on first action.
        script = [{"grid": [[1]]}]
        snippet = "result = action(['A'], expect=['deadbeefdeadbeef'])"
        out, _ = self._run_action(snippet, _base_state([[0]]), 10, script, [[0]])
        self.assertEqual(out["result"]["stop_reason"], "expect_mismatch")

    def test_done_and_terminal_caching(self):
        # First batch ends on done; a second action() returns the cached terminal
        # result without stepping the env again.
        script = [{"grid": [[1]], "done": True}]
        snippet = (
            "first = action(['A', 'A'])\n"
            "second = action(['A'])\n"
            "result = [first['stop_reason'], first['executed_count'], "
            "second['stop_reason'], second['executed_count']]"
        )
        env = ScriptedEnv(script, [[0]])
        out = run_snippet(snippet, _base_state([[0]]), budget=10, step_env_callback=env, timeout_s=30)
        self.assertEqual(out["error"], "", msg=out.get("error"))
        self.assertEqual(out["result"], ["done", 1, "terminal", 0])
        # Only one real env step happened despite two action() calls.
        self.assertEqual(env.calls, 1)

    def test_completed_reports_board_changed(self):
        script = [{"grid": [[1]]}, {"grid": [[2]]}]
        snippet = "result = action(['A', 'A'])"
        out, _ = self._run_action(snippet, _base_state([[0]]), 10, script, [[0]])
        r = out["result"]
        self.assertEqual(r["stop_reason"], "completed")
        self.assertTrue(r["board_changed"])
        self.assertEqual(r["remaining_actions"], 8)


if __name__ == "__main__":
    unittest.main()
