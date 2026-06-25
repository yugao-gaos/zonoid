#!/usr/bin/env python3
"""Focused regressions for bench/zonoid_bench/arms.py."""

from __future__ import annotations

import unittest

from bench.zonoid_bench import arms


class FakeClient:
    def __init__(self) -> None:
        self.search_called = False
        self.search_context_calls: list[dict[str, object]] = []

    def search(self, *args, **kwargs):  # noqa: ANN002, ANN003
        self.search_called = True
        raise AssertionError("read_task_search_context must not call legacy /search")

    def search_context(self, query, **kwargs):  # noqa: ANN001
        self.search_context_calls.append({"query": query, **kwargs})
        return {
            "subconscious_context": {
                "kind": "subconscious_agentic_search_context",
                "context": [
                    {
                        "key": "note:prod",
                        "summary": "production-selected context",
                        "tier": "dag",
                    }
                ],
                "context_deps": [
                    {
                        "key": "note:dep",
                        "summary": "dependency fallback",
                        "tier": "dag",
                    }
                ],
            }
        }


class ArmsTests(unittest.TestCase):
    def test_read_task_search_context_uses_production_subconscious_context(self) -> None:
        client = FakeClient()

        hits = arms.read_task_search_context(client, "bench/probe", "what matters?", k=7)

        self.assertFalse(client.search_called)
        self.assertEqual(
            client.search_context_calls,
            [
                {
                    "query": "what matters?",
                    "agent_id": "zonoid-bench-agent-memory",
                    "task_key": "bench/probe",
                    "intent": "Answer benchmark probe using retrieved memory: what matters?",
                    "situation": "what matters?",
                    "k": 7,
                    "max_rounds": 3,
                    "use_grader": True,
                }
            ],
        )
        self.assertEqual([hit["key"] for hit in hits], ["note:prod"])


if __name__ == "__main__":
    unittest.main()
