#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const script = String.raw`
import os
import sys

repo = sys.argv[1]
sys.path.insert(0, os.path.join(repo, "bench"))

from zonoid_bench import arms

captured = {}

class Client:
    def __init__(self):
        self.context_reads = 0
        self.search_calls = []

    def get_task_context(self, node_key):
        self.context_reads += 1
        return {
            "dependencySummaries": [
                {"key": "note:legacy", "summary": "This must not be read directly.", "via": "context", "weight": 1},
            ],
        }

    def search(self, query, k=10, gated=False, task_key=None):
        self.search_calls.append((query, k, gated, task_key))
        return [
            {"key": "note:system", "summary": "Always preserve this system constraint.", "tier": "system", "kind": "note"},
            {"key": "note:dag", "summary": "This is frozen judged task context.", "tier": "dag", "kind": "note"},
        ]

def fake_wiring(*_args, **_kwargs):
    return arms.WiringResult(task_key="bench/settled", node_kind="task")

def fake_answer(_question, blocks, _model):
    captured["blocks"] = list(blocks)
    return "grounded answer", {"input_tokens": 3, "output_tokens": 2}

arms.run_canonical_wiring = fake_wiring
arms._answer_from_context = fake_answer

client = Client()
result = arms.run_retrieve_and_answer(
    client,
    unit_id="featurebench-unit",
    question="What does the task require?",
    data_dir="/unused",
    context_k=2,
)

assert client.context_reads == 0, "ON arm must use the production task-search response, not /task/context"
assert client.search_calls == [("What does the task require?", 2, False, "bench/settled")]
assert captured["blocks"] == [
    "[SYSTEM] Always preserve this system constraint.",
    "[DAG] This is frozen judged task context.",
]
assert result.context_keys == ["note:system", "note:dag"]
assert result.predicted == "grounded answer"
print("PASS featurebench settled task production context")
`;

let result = spawnSync(process.env.PYTHON || 'python3', ['-c', script, repo], {
  cwd: repo,
  encoding: 'utf8',
});
if (result.error && result.error.code === 'ENOENT' && !process.env.PYTHON) {
  result = spawnSync('python', ['-c', script, repo], { cwd: repo, encoding: 'utf8' });
}

assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /PASS featurebench settled task production context/);
console.log(result.stdout.trim());
