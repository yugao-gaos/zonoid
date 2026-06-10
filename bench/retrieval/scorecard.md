# Retrieval-quality scorecard — search_knowledge

Generated: 2026-06-10T01:20:21.378Z  
Daemon: `http://localhost:8787`  
Eval set: `bench/retrieval/eval-set.json` (v1, 28 queries)  
Status: **PASS**

## Aggregate (mean over queries)

| k | recall@k | precision@k | MRR@k |
|---|----------|-------------|-------|
| 1 | 0.75 | 0.75 | 0.75 |
| 3 | 0.875 | 0.2976 | 0.8095 |
| 5 | 0.9107 | 0.1857 | 0.8185 |
| 10 | 0.9464 | 0.0964 | 0.8229 |

Primary cutoff **k=5**; regression thresholds: recall@5 ≥ 0.85, MRR@5 ≥ 0.8.

## Per-query (at primary k)

| query | relevant | recall | MRR | first hit rank |
|-------|----------|--------|-----|----------------|
| how do I reference a task from another session | 1 | 1 | 1 | 1 |
| is it safe to write the native task json file directly | 1 | 1 | 1 | 1 |
| the native task file format keeps changing across versions, how is that handled | 1 | 1 | 1 | 1 |
| should the orchestrator reimplement its own task scheduler | 1 | 1 | 0.25 | 4 |
| what happens when a winner merge hits a git conflict | 1 | 1 | 1 | 1 |
| which git repo do branch and merge operations run against | 1 | 1 | 1 | 1 |
| code changes are built in isolation and not merged automatically | 2 | 0.5 | 0.5 | 2 |
| local https certificate fails to be trusted by the browser | 1 | 1 | 0.3333 | 3 |
| why does the desktop app not run my settings.json hooks | 1 | 1 | 1 | 1 |
| the PreToolUse gate blocks my edit even though the task status is wrong | 1 | 1 | 1 | 1 |
| how should I authenticate requests to the daemon | 1 | 0 | 0 | 8 |
| the benchmark shows 65% less work which seems wrong, how to measure tokens | 1 | 1 | 1 | 1 |
| why is the ON vs OFF context cost difference just cache reads | 1 | 1 | 1 | 1 |
| do not work inline, route multi-step work through the orchestrator | 1 | 1 | 1 | 1 |
| a new task ended up as a disconnected orphan root node | 1 | 1 | 1 | 1 |
| when should I record a decision as a note node | 1 | 1 | 1 | 1 |
| how do dependent tasks pass context cheaply without re-reading everything | 1 | 1 | 0.5 | 2 |
| two tasks write the same file, can I run them in parallel | 1 | 1 | 1 | 1 |
| what decides whether the optimization loop iterates again or stops | 1 | 0 | 0 | — |
| the loop produced no usable winner for several rounds, what then | 1 | 1 | 1 | 1 |
| the planner cancelled a running task and caused a runaway | 1 | 1 | 1 | 1 |
| check whether an approach was already tried and rejected before proposing it | 1 | 1 | 1 | 1 |
| the judge should never write or edit the candidate attempts | 1 | 1 | 1 | 1 |
| how does the judge decide when there is a metric spec versus only rationale | 1 | 1 | 1 | 1 |
| never make up a benchmark number for the judge | 1 | 1 | 0.3333 | 3 |
| cross workspace dependency where the provider lives in another workspace | 1 | 1 | 1 | 1 |
| the setup wizard must not run password steps silently | 1 | 1 | 1 | 1 |
| how does the agent know to spawn idle stop or plan each tick | 1 | 1 | 1 | 1 |

