# FeatureBench bringup notes (Apple Silicon / arm64)

Bringup of [LiberCoders/FeatureBench](https://github.com/LiberCoders/FeatureBench)
(paper arXiv 2602.10975) on an Apple Silicon Mac, for the Zonoid KB-injection eval
(see `docs/swe-bench-eval.md`). Scope: install + Docker gold-patch eval smoke test only.
No inference / no API-billed agent rollouts were run.

## Machine

- arch: **arm64** (Apple Silicon), 16 cores, 48 GB RAM, ~2.2 TB free
- macOS 15.4
- Docker **29.1.5**, engine reports `aarch64 / linux`
- qemu/binfmt amd64 emulation is configured (`docker run --platform linux/amd64 alpine uname -m` -> `x86_64`)

## Install

`pip install featurebench` (PyPI) ships the `fb` CLI. Key gotcha:

- **featurebench requires Python >= 3.12** (the task brief guessed 3.10/3.11 — that
  fails resolution: `featurebench depend on Python>=3.12`). Use 3.12.
- System Python here was 3.13.9 (no 3.10/3.11/3.12 installed). Used `uv` to fetch a
  pinned interpreter and build the venv.

Exact commands that worked (run from the worktree root):

```bash
uv venv --python 3.12 .venv-fb
VIRTUAL_ENV="$PWD/.venv-fb" uv pip install featurebench   # -> featurebench 0.2.1
.venv-fb/bin/fb --help
```

- **Installed version: featurebench 0.2.1** (Python 3.12.12 via uv).
- A uv venv has no `pip`; use `uv pip install` (with `VIRTUAL_ENV` set) or
  `python -m pip`. Plain `pip` / `source activate && pip` is not available.

## config.toml

No `config_example.toml` ships in the 0.2.1 wheel (the brief assumed one). The eval
harness (`fb eval`) only reads `[env] HF_TOKEN` / `HF_ENDPOINT`, and only to load the
`LiberCoders/FeatureBench` dataset from HuggingFace. **That dataset is public** — it
loads with `token=None` (just a rate-limit warning). A missing config.toml is handled
gracefully ("using defaults"). A minimal `config.toml` with an empty `[env] HF_TOKEN`
is committed alongside these notes. (Inference, `fb infer`, would additionally need an
`[llm]` block with an API key — out of scope here.)

## The arm64 verdict — KEY QUESTION

**FeatureBench Docker images are amd64-only. No native arm64 manifests exist.**

- `fb pull` (`featurebench/scripts/pull_images.py`) runs a plain `docker pull <image>`
  with **no `--platform` flag**. Image refs in
  `featurebench/resources/constants/fast_images.txt` are bare `libercoders/featurebench-specs_<repo>-instance_<hash>`
  (tag resolves to `:latest`).
- Queried Docker Hub for **all 18 fast-split repo images** — every one publishes a
  single `latest` tag with a single architecture: **`linux/amd64`**. Zero arm64
  variants. (Confirmed via `hub.docker.com/v2/repositories/<repo>/tags`.)

So on Apple Silicon:
- **Native arm64: NOT possible** — the images don't exist for arm64.
- **amd64 emulation: works.** Docker Desktop's qemu auto-emulates amd64 images on this
  host (verified with alpine, and end-to-end with a FeatureBench gold eval below).
  Because `fb pull`/`fb eval` issue no `--platform`, and the manifest is amd64-only,
  Docker transparently pulls + runs the amd64 image under emulation — no flag needed.
- **Cloud x86: optional, for speed.** Emulation works locally but is slow (see timing).
  For the full 100-instance fast split or 200-instance full split, a cheap native x86
  box would cut wall-clock substantially.

## Gold-patch eval smoke test

Command:

```bash
.venv-fb/bin/fb eval -p gold --split fast --config-path ./config.toml \
  --task-id fastapi__fastapi.02e108d1.test_compat.71e8518f.lv1 --n-concurrent 1
```

(`-p gold` evaluates the dataset's gold patch directly — no inference. A green result
proves the Docker build + test-eval pipeline scores a known-good patch on this host.)

- Result: **GREEN — resolved 1/1 (resolved_rate 1.0, pass_rate 1.0).** The gold patch
  applied cleanly (`patch_successfully_applied: true`) and every test passed: all 10
  `FAIL_TO_PASS` tests in `tests/test_compat.py` flipped to passing, and all 47
  `PASS_TO_PASS` regression tests stayed green. Full report at `runs/gold/report.json`
  and `runs/gold/eval_outputs/<task-id>/attempt-1/report.json`. This proves the Docker
  build + amd64-under-qemu test-eval pipeline scores a known-good patch correctly on
  this arm64 host.
- Per-instance gold-patch eval time (under amd64 emulation): **~13m 42s wall-clock**
  for the single fastapi instance (cold image build + amd64 test run under qemu, 1
  worker). Emulation is the dominant cost — a native x86 box would be substantially
  faster for the full 100-instance fast split.

## Gotchas summary

1. Python >= 3.12 required (not 3.10/3.11 as the brief guessed).
2. uv venv has no `pip`; use `uv pip install` / `python -m pip`.
3. No `config_example.toml` ships; dataset is public so an empty config works for eval.
4. Images are amd64-only → arm64 runs only under qemu emulation (slow but functional).
5. `fb pull` issues no `--platform`; relies on Docker host auto-emulation. Fine on
   Docker Desktop with binfmt configured; on a bare arm64 Linux box you'd need
   `docker run --platform linux/amd64` + qemu-user-static registered.
