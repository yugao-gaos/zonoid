# Fresh Memory-Bench Scorecard - 2026-06-24

## Scope

Task requested a fresh LoCoMo + LongMemEval-Oracle memory-bench run on current
retrieval/enrichment behavior and default grader settings.

Full benchmark data was not available in this checkout. A filesystem search found
only the committed synthetic fixtures:

- `bench/agent-memory/fixtures/locomo10.json`
- `bench/agent-memory/fixtures/longmemeval_oracle.json`

Those fixtures were run as the best verified dry-run/setup check. Treat the
numbers below as pipeline evidence, not full benchmark truth.

## Commands

The exact command lines are recorded in `command-lines.txt`. Both runs used:

- `bench/agent-memory/run.py`
- arms: `our-way,search,cold`
- model: `sonnet`
- scoring: default LLM judge enabled
- data dir: `bench/agent-memory/fixtures`
- isolated daemon runtime data: `/private/tmp/zmb-fresh-memory-20260624`

An initial attempt to place daemon data under this report directory failed before
records were produced because `embed.sock` exceeded the macOS Unix-domain socket
path limit. The rerun used the short `/tmp` daemon path and completed.

## Results

| Dataset | Records | our-way accuracy | search accuracy | cold accuracy | our-way F1 | search F1 | cold F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LoCoMo fixture | 6 | 0.0% | 100.0% | 0.0% | 0.0% | 100.0% | 0.0% |
| LongMemEval-Oracle fixture | 6 | 0.0% | 100.0% | 0.0% | 0.0% | 83.3% | 0.0% |

## Observations

- `search` retrieved the fixture evidence and answered all four probes correctly
  by LLM-judge accuracy.
- `cold` returned "I don't know" on all fixture probes, so the rigging guard held.
- `our-way` returned "I don't know" on all fixture probes because the run recorded
  no kept session ids and no task context keys for that arm.
- The result is a setup/regression signal for the current DAG-read path on these
  fixtures; it is not a full LoCoMo or LongMemEval-Oracle score.

## Artifacts

- `outputs/locomo-fixture/results.jsonl`
- `outputs/locomo-fixture/report.json`
- `outputs/locomo-fixture/report.md`
- `outputs/longmemeval-oracle-fixture/results.jsonl`
- `outputs/longmemeval-oracle-fixture/report.json`
- `outputs/longmemeval-oracle-fixture/report.md`
- `logs/locomo-fixture.log`
- `logs/longmemeval-oracle-fixture.log`
- `logs/daemon-embed-server.log`

## Blockers for Full Run

1. Real `locomo10.json` and `longmemeval_oracle.json` dataset files were not found
   outside committed fixtures in the searched workspace/home paths.
2. The production daemon at `http://localhost:8787` was too slow for reliable
   bench driving during setup (`/health` timed out), so the verified dry-run used
   an isolated daemon.
3. Daemon runtime data must use a short path on macOS; placing it under the deep
   worktree report path makes `embed.sock` fail with `listen EINVAL`.
