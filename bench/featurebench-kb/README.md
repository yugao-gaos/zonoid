# FeatureBench pilot — ON-arm KB blocks

Pre-generated Zonoid KB artifacts for the FeatureBench pilot. The eval itself runs on a
native-x86 Windows/WSL2 host (FeatureBench Docker images are amd64-only — see
`docs/featurebench-bringup-notes.md`); this directory is the shared contract that side consumes.

## `pilot-manifest.json` — the shared instance contract

A **deterministic** ~15-instance subset of the FeatureBench `fast` split
(`LiberCoders/FeatureBench`, public HF dataset, loads with `token=None`):

- **5 repos × 3 instances = 15 instances.** Each repo contributes >1 instance, so a
  per-repo KB block is exercised by more than one task.
- Selection rule (fully spelled out in the manifest's `selection_rule` field): top-5 repos
  by fast-split instance count that share a single `base_commit` and clone cleanly from
  canonical GitHub (mirror-only repos such as the `bgithub.xyz`-sourced mlflow are excluded),
  3 lowest instance_ids each.
- The Windows side runs **exactly** these `instance_ids`; the manifest records each repo's
  `base_commit` and `github_url` so the same pinned checkout is used on both sides.

Repos: `pandas-dev/pandas`, `astropy/astropy`, `sphinx-doc/sphinx`, `mwaskom/seaborn`,
`sympy/sympy`.

## Settled task context

The active SDK ON arm uses the production task-scoped search response after eager judgment. A
settled probe receives system context plus its frozen DAG context; it does not receive an added
semantic RAG fill. The plain-search RAG control remains a separate arm with no `task_key`.

## KB blocks — two variants per repo (NOT YET GENERATED — see Blocker)

The pilot needs two ON arms per repo, each a markdown KB block injected as `AGENTS.md`:

- `<repo>.plain.AGENTS.md` — cold-start KB (no judge).
- `<repo>.selflearn.AGENTS.md` — self-learning KB (judge-filtered).

**Windows-side usage (once the blocks exist):** for the repo a given arm is running, drop
`<repo>.<variant>.AGENTS.md` into the repo checkout as `AGENTS.md` (root of `/repo`) before
running that repo's instances for that arm. OpenHands loads `AGENTS.md` automatically; for
SWE-agent pass it via the instance template (see `docs/swe-bench-eval.md` step 4). Run the
`plain` arm with the `.plain.` block, the `selflearn` arm with the `.selflearn.` block.

## Blocker — KB blocks could not be generated on this Mac (FB-3)

The two KB variants were **not** produced. Three independent gaps in the documented pipeline
block it; generating anyway would have burned API budget for empty or identical output:

1. **No `--judge` mechanism.** `docs/swe-bench-eval.md` (step 5) and the FB-3 handoff say the
   self-learning variant is `onboard-loop.js` "with `--judge` enabled". That flag exists
   nowhere in the codebase (`onboard-loop.js`, `onboard-learn.js`, `onboard-harness.js`).
   There is one onboarding pipeline (mine → agentic learn/keep → export); the only "judge" is
   the harness's applied-correctness *grader* used to steer where the loop deepens — it does
   not toggle a second KB variant. So `plain` vs `selflearn` has no implemented way to differ.
2. **No authored probes.** `onboard-loop.js` hard-exits if `probes.json` is missing for the
   repo, and `onboard-probes.js` is only a schema *validator*, not a generator. None of the 5
   pilot repos have probes, and the handoff never specified authoring them.
3. **Foreign-workspace injection is policy-denied.** A prior end-to-end verification on a
   non-daemon-workspace repo recorded that daemon KB injection on a foreign workspace was
   policy-denied (graph task `c0bd3682-…/13`). `export-kb.js` reads notes back via
   `GET /search?workspace=<repo>`; if injection to the foreign workspace is denied, the export
   returns empty — so even a manual mine→learn→export on these repos would yield empty blocks.

Resolving any of these is a design decision for the eval owner (define the real two-variant
mechanism, decide how probes are produced for foreign repos, and lift/relax the
foreign-workspace injection policy). Tracked for FB-4.
