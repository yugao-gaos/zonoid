# Zonoid KB Injection — Eval Runbook

## Experiment design

**Core principle:** agent never sees the test suite during solving. Tests run post-hoc against the submitted patch. This eliminates the TDD confound where tests act as a precise spec.

```
Agent input:   repo code + issue/spec description (NO tests)
Agent solves:  generates a patch
Evaluation:    hidden test suite runs against patch → pass/fail score
```

Two conditions run on identical task sets:
- **OFF (baseline):** vanilla agent, no KB injection
- **ON (treatment):** same agent + Zonoid KB block injected into system prompt before first turn

## Benchmarks

### Primary 1: SWE-Bench-CL
- **Paper:** arXiv 2507.00014
- **What it is:** SWE-bench Verified reorganized into chronologically ordered sequences per repo. Agents accumulate memory across a sequence of related issues in the same codebase.
- **Why it fits:** Directly measures forward transfer — does KB from session N help session N+1 on the same repo? This is exactly Zonoid's core claim.
- **Metrics:** Resolved rate per session, Composite Continual Learning Score (CCLS), forward transfer, backward transfer
- **Zonoid advantage:** Replace the FAISS-backed memory module with Zonoid KB. KB compounds across the sequence — patterns mined from early issues help later ones.
- **Agent sees tests?** No — inherits SWE-bench standard: tests withheld during solving, run post-hoc.

### Primary 2: FeatureBench (ICLR 2026)
- **Paper:** arXiv 2602.10975 | GitHub: LiberCoders/FeatureBench
- **What it is:** Feature addition tasks on real repos. Agent receives NL description + function signature + call path annotations. No tests. 200 tasks, 24 repos.
- **Why it fits:** No oracle. Agent must navigate architecture without hints. Ablation in paper: withholding tests drops performance 60%→10%, proving tests are the dominant SWE-bench signal.
- **Metrics:** Resolved rate (pass@1), L1 (incremental) vs L2 (from-scratch) breakdown
- **Zonoid advantage:** KB gives agent architectural context (module boundaries, conventions, gotchas) that substitutes for the oracle signal removed by withholding tests.
- **Agent sees tests?** No — this is the benchmark's explicit design.

### Control: SWE-bench Verified
- Standard benchmark. Tests withheld from agent. Expected low KB delta (tasks are mostly small bug fixes where architecture matters less).
- Included to show the contrast: "KB helps when architectural navigation is the bottleneck (SWE-Bench-CL, FeatureBench); marginal gains when patch is small and localized (SWE-bench Verified)."

## Narrative claim
> "SWE-bench's test-oracle explains ~50pp of agent performance (FeatureBench ablation). On benchmarks designed for architectural navigation and cross-task learning — where no oracle exists — Zonoid KB injection closes a meaningful fraction of the remaining gap."

## Environment setup
- Python 3.10+, Docker, Node.js 18+
- `pip install swe-bench datasets scipy numpy pandas`
- Zonoid daemon: `node daemon.js`
- SWE-Bench-CL: clone from arXiv 2507.00014 GitHub
- FeatureBench: `git clone https://github.com/LiberCoders/FeatureBench`

## Step 1: Warm up embeddings
`node scripts/warmup-embeddings.js`

## Step 2: Onboard repos (treatment only)
For each unique repo in the task sample, at the pinned commit:
```bash
node scripts/onboard-loop.js --repo /path/to/repo --workspace /path/to/repo --max-rounds 2
```
See docs/onboard-workspace.md for Docker/pinned-commit instructions.

## Step 3: Export KB per repo
```bash
node scripts/export-kb.js --repo /path/to/repo --k 30 --min-score 0.1 > kb-blocks/repo-name.md
```

## Step 4: Inject KB into agent (treatment runs)
Write KB block to AGENTS.md in the container's /repo before agent starts. OpenHands loads it automatically. For SWE-agent, pass via instance template variable.

```python
def inject_kb(container_id, kb_block):
    pathlib.Path('/tmp/AGENTS.md').write_text(kb_block)
    subprocess.run(['docker', 'cp', '/tmp/AGENTS.md', f'{container_id}:/repo/AGENTS.md'])
```

## Step 5: Run baseline (OFF) and treatment (ON)
Same agent config, same tasks, same model. Only difference: presence/absence of KB block in system prompt.

Collect patches → evaluate via benchmark harness (Docker + test suite) → record resolved (0/1) per task.

## Step 6: SWE-Bench-CL specific — sequential task ordering
Tasks must be run in chronological order per repo. After each task completes (ON condition), update the KB:
```bash
# After task N completes, drain new patterns before task N+1
node scripts/onboard-loop.js --repo /path/to/repo --workspace /path/to/repo --max-rounds 1
node scripts/export-kb.js --repo /path/to/repo > kb-blocks/repo-name.md
```
This simulates genuine compounding: KB grows with each resolved issue.

## Step 7: Metrics collection
Per task: resolved (0/1), input_tokens, output_tokens, tool_calls, session_index (for CL sequences).

SWE-Bench-CL: also compute CCLS and forward transfer coefficient.
FeatureBench: report L1 vs L2 breakdown separately.

## Step 8: Statistical analysis
- Two-proportion z-test on resolved rate (ON vs OFF), per benchmark
- n=200 for FeatureBench (all tasks), n=~500 for SWE-Bench-CL sequences
- Mann-Whitney U on token counts
- For CL: linear regression of (session_index → resolved_rate_delta) to show KB compounds over time

## Estimated cost
~$150–200 total across all three benchmarks (ON + OFF runs, Claude Sonnet 4.5).

## Blockers checklist
- [ ] SWE-Bench-CL harness availability (check arXiv 2507.00014 GitHub for eval code)
- [ ] FeatureBench harness: clone LiberCoders/FeatureBench, verify eval pipeline
- [ ] Warmup MiniLM before eval loop (warmup-embeddings.js)
- [ ] Onboard at pinned commit (see onboard-workspace.md)
- [ ] Sequential KB update between CL tasks (step 6)
