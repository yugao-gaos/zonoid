# Wincase-C report — cross-session winning-case, Phase 1 falsification

**Date:** 2026-06-10 · **Variant:** C (real dogfood task→transcript resolution) · **Verdict: NULL / TRAP INVALID**

## The trap as built
- Task B (bench/specs/wincase-c.md): implement resolveOwner(taskKey, registry) -> transcript path or null.
  Registry = assignee / agents / window / byWindow / sessionTranscript. Empirical fact: a direct/
  exact-session-only resolver silently misses rows whose agent record has no session and no
  transcript_path; those are recoverable only by time-window overlap correlation against byWindow.
- Anti-v4 discipline: spec states ONLY goal + data shape + "make tests pass". NO strategy mention,
  no "subtle choice/pick carefully", no enumeration of the rules. (graph-dependent.md does all of
  these -> self-solvable by construction.)
- Acceptance fixture (bench/sandbox/wincase-resolve.test.js): built PROGRAMMATICALLY, not a static
  table. 25 task rows + 2 null rows + structural cases. ~40% (i%5 in {3,4}) carry an EMPTY agent
  record, recoverable only by window correlation; interleaved, not grouped.
- Trap mechanics confirmed: correct correlation impl -> 29 passed, 0 failed; naive direct+session
  impl -> 18 passed, 11 failed (fails exactly the correlation rows). Test genuinely requires correlation.
- Seeded note A (warm arm): note-mq7kyiir6sx, the empirical fact + why. Verified retrievable
  via:semantic as #1 hit (0.67-0.69) from workspace __WORKSPACE__ via search_knowledge
  and HTTP /search. Workspace gremlin check: PASS.

## Rigging guard — DID NOT HOLD
cold-B = arm OFF, no MCP, 3 trials, opus:

| trial | solved | output | W | H | explorers | wallMs |
| ----: | :----: | -----: | --: | ---: | --: | -----: |
| 0 | yes | 5704 | 480 | 5224 | 3 | 42939 |
| 1 | yes | 4134 | 419 | 3715 | 3 | 35671 |
| 2 | yes | 8951 | 474 | 8477 | 3 | 45469 |
| mean | 3/3 | 6263 | 458 | 5805 | 3.0 | — |

cold-B solved 3/3. Not instant (mean H~5805, 3 explorers) but solved every time. All three solutions
independently implemented the full 3-rule resolver INCLUDING window-overlap correlation
(Math.min(end,re)-Math.max(start,rs) over a bestOverlap loop on byWindow) — derived by READING the
committed test, whose generator exposes that empty-agent-record rows expect byWindow[window-index].
transcript_path. Self-solvable -> trap INVALID. Per protocol I STOPPED: did NOT run the warm arm,
do NOT claim a win.

## What this falsifies
The single-task memory-win premise is falsified even under the most favorable authentic trap I could
build for a self-contained pure-function task. Root cause is structural: a fully-specified, committed
acceptance test for a pure function leaves NO empirical gap. The cold agent reads the test and
reconstructs the strategy from asserted behavior, regardless of how strategy-silent the prose is —
the test IS the reveal. Same reason v1-v7 lost; v4's prose hint was just the most blatant instance.
Still 0 wins in 8 attempts.

## Proposed fix
1. Held-out test the agent cannot read (prose-only spec; pattern knowable only from note A).
2. Runtime-quirk task — empirical fact about the LIVE daemon's real data, unobservable in a sandbox worktree.
3. Abandon single-task for pure functions; pivot the winning-case search to genuinely multi-task /
   cross-session settings where the expensive knowledge is external to any one task's artifacts.
