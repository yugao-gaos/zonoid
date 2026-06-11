# Zonoid KB Injection — SWE-bench Eval Runbook

## Overview

**Hypothesis:** Pre-task repo knowledge injection (via Zonoid KB) improves agent resolved rate and reduces token usage on software engineering benchmarks.

- **Primary benchmark:** SWE-bench Verified (500 validated tasks across 12 popular OSS repos)
- **Secondary benchmark:** SWE-EVO (continuous eval against recent commits)
- **Design:** A/B — baseline (vanilla Claude Code / OpenHands) vs treatment (Claude Code + Zonoid KB injected into system prompt / AGENTS.md)

The KB block surfaces non-obvious repo conventions, architecture decisions, and gotchas captured during onboarding. The hypothesis is that reducing exploration overhead (fewer read-only tool calls early in the trajectory) converts to both higher resolved rates and lower token cost.

---

## Prerequisites

**Runtime:**
- Python 3.10+
- Docker (for SWE-bench harness containers)
- Node.js 18+

**Python packages:**
```bash
pip install swe-bench datasets scipy numpy pandas
```

**Zonoid daemon running:**
```bash
node daemon.js
```

Verify health: `curl http://localhost:8787/health`

---

## Task selection (100 stratified tasks)

Sample 100 tasks proportionally by repo so the distribution mirrors SWE-bench Verified overall. Use seed=42 for reproducibility.

```python
import pandas as pd
from datasets import load_dataset

ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
df = pd.DataFrame(ds)

# Stratified sample: proportional by repo, seed=42
sample = (
    df.groupby("repo", group_keys=False)
    .apply(lambda g: g.sample(frac=100 / len(df), random_state=42))
    .head(100)
    .reset_index(drop=True)
)

sample.to_json("tasks_100.jsonl", orient="records", lines=True)
print(sample["repo"].value_counts())
```

Pin the exact instance IDs before starting any runs — do not resample mid-experiment.

---

## Step 1: Warm up embeddings

MiniLM must be loaded before the eval loop or the first onboard call will block on a cold model download.

```bash
node scripts/warmup-embeddings.js
```

Wait for `embeddings ready` in stdout before proceeding.

---

## Step 2: Onboard repos (treatment only)

For each unique repo in `tasks_100.jsonl`, check out the pinned commit SHA that the SWE-bench harness uses, then run onboarding against that state.

```bash
# Pin to the harness commit first
cd /path/to/repo
git checkout <instance_base_sha>

# Run onboarding (2 rounds is enough for most repos)
node scripts/onboard-loop.js \
  --repo /path/to/repo \
  --workspace /path/to/repo \
  --max-rounds 2
```

> **Important:** Always onboard against the same commit SHA the harness uses. Onboarding a different commit means the KB may reference code that doesn't exist in the container.

Repeat for each unique repo. Onboarding is idempotent — rerunning updates existing KB entries rather than duplicating them.

---

## Step 3: Export KB for each repo

After onboarding, export a Markdown KB block for each repo. This is what gets injected into the agent.

```bash
node scripts/export-kb.js \
  --repo /path/to/repo \
  --k 30 \
  --min-score 0.1 \
  > kb-blocks/repo-name.md
```

`--k 30` retrieves the top 30 most relevant KB entries. `--min-score 0.1` drops low-confidence entries that may add noise. Check file sizes — a typical repo block is 2–8 KB; anything over 20 KB may need `--k` reduced to stay within context budget.

---

## Step 4: Baseline runs

Run the standard OpenHands or SWE-agent config with no KB injection. Collect all patches to `baseline_patches/`.

Use the same model (Claude Sonnet) and temperature (0) for both arms. Record `input_tokens`, `output_tokens`, and `tool_calls` per trajectory from the agent logs.

---

## Step 5: Treatment runs (OpenHands)

Before each agent run, inject the repo's KB block as `AGENTS.md` inside the harness container. OpenHands loads `AGENTS.md` automatically as persistent memory visible to the agent throughout the trajectory.

```python
import subprocess
import pathlib

def inject_kb(container_id: str, kb_block: str) -> None:
    """Write kb_block into /repo/AGENTS.md inside the running container."""
    pathlib.Path('/tmp/AGENTS.md').write_text(kb_block)
    subprocess.run(
        ['docker', 'cp', '/tmp/AGENTS.md', f'{container_id}:/repo/AGENTS.md'],
        check=True,
    )
```

Call `inject_kb` after the container starts but before the agent trajectory begins. Collect patches to `treatment_patches/`.

---

## Step 6: Evaluate both runs

```bash
python -m swebench.harness.run_evaluation \
  --predictions_path baseline_patches/predictions.jsonl \
  --run_id baseline_001

python -m swebench.harness.run_evaluation \
  --predictions_path treatment_patches/predictions.jsonl \
  --run_id treatment_001
```

The harness writes per-instance results to `results/`. Parse `results/<run_id>.json` to extract `resolved` flags and token counts.

---

## Step 7: Metrics and analysis

Collect per task: `resolved` (0/1), `input_tokens`, `output_tokens`, `tool_calls`.

**Resolved rate — two-proportion z-test:**

```python
from scipy import stats
import numpy as np

baseline = results_df[results_df["arm"] == "baseline"]
treatment = results_df[results_df["arm"] == "treatment"]

n_b = len(baseline)
n_t = len(treatment)
p_b = baseline["resolved"].mean()
p_t = treatment["resolved"].mean()

# Pooled proportion
p_pool = (baseline["resolved"].sum() + treatment["resolved"].sum()) / (n_b + n_t)
se = np.sqrt(p_pool * (1 - p_pool) * (1/n_b + 1/n_t))
z = (p_t - p_b) / se
p_value = 2 * (1 - stats.norm.cdf(abs(z)))

print(f"Baseline resolved: {p_b:.1%}  Treatment resolved: {p_t:.1%}")
print(f"z={z:.3f}  p={p_value:.4f}")
```

**Token counts — Mann-Whitney U (non-parametric, tokens are skewed):**

```python
stat, p = stats.mannwhitneyu(
    treatment["input_tokens"],
    baseline["input_tokens"],
    alternative="less",  # H1: treatment uses fewer input tokens
)
print(f"Mann-Whitney U={stat:.0f}  p={p:.4f}")
```

Report effect size (Cohen's h for resolved rate, rank-biserial correlation for tokens) alongside p-values. 100 tasks gives ~80% power to detect a 10 pp improvement at α=0.05.

---

## Estimated cost

~$90–120 total for a 100-task A/B on Claude Sonnet 4.5 (both arms combined), assuming average trajectory length of ~30 tool calls and ~15k tokens per task. Onboarding adds ~$5–10 across all repos.

---

## Blockers checklist

- [ ] Onboard must run at pinned commit SHA (not HEAD) — see Step 2
- [ ] Warm MiniLM before eval loop — `warmup-embeddings.js` must complete first
- [ ] Pass `--workspace` flag to all daemon calls for foreign repos (see `onboard-workspace.md`)
- [ ] Verify daemon health at `http://localhost:8787/health` before starting
- [ ] Confirm Docker has enough disk space for all harness containers (~2 GB per repo)
- [ ] Export KB blocks before starting treatment runs (Step 3 must precede Step 5)
