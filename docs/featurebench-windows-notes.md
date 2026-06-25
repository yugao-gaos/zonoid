# FeatureBench on Windows (native x86) — bringup + fixes

Running the FeatureBench `fb` harness on a native-x86 Windows host (Docker Desktop / WSL2 backend).
Complements `docs/featurebench-bringup-notes.md` (which was macOS/arm64). The pilot KB blocks live in
`bench/featurebench-kb/`. Verified: **gold smoke test resolves 1/1 at 100%** on
`pandas-dev__pandas.82fa2715.test_all_methods.c74b49a1.lv1`.

## Install (Windows)

```powershell
winget install --id astral-sh.uv -e
uv venv --python 3.12 D:\zonoid\.venv-fb          # uv may warn "Missing minor version link" — non-fatal
uv pip install --python D:\zonoid\.venv-fb\Scripts\python.exe featurebench   # -> featurebench 0.2.1
```

Run everything with these env vars set (see fixes #1 and #2):
```powershell
$env:PYTHONPATH = "D:\zonoid\.venv-fb\_winshim"   # fcntl shim dir (fix #1)
$env:PYTHONUTF8 = "1"                              # fix #2
```

## Three Windows-specific fixes (REQUIRED — the harness assumes Linux/macOS)

These are applied to the **installed package inside `.venv-fb`**, so they must be re-applied after any
`uv pip install`/reinstall of featurebench. (TODO: wrap in a post-install patch script.)

1. **`fcntl` shim** — `featurebench/infer/output.py` imports `fcntl` (Unix-only) at module load, so
   even `fb eval` crashes on import. Shim it: create `D:\zonoid\.venv-fb\_winshim\fcntl.py` with no-op
   `flock`/`lockf`/`fcntl`/`ioctl` + `LOCK_*` constants, and add that dir to `PYTHONPATH`. Safe for
   single-worker runs (`--n-concurrent 1`); the shim no-ops advisory file locking.

2. **`PYTHONUTF8=1`** — the `rich` progress display writes a `✓` (U+2713); the default Windows console
   codec is cp1252 and raises `UnicodeEncodeError`, crashing the run *after* the eval completes (and
   skipping the top-level `report.json`). UTF-8 mode avoids the legacy-windows cp1252 path.

3. **CRLF in patch files** — `featurebench/harness/runtime.py` writes mask/test/solution patches with
   `tempfile.NamedTemporaryFile(mode='w', ...)`, which on Windows translates `\n`→`\r\n`. The CRLF
   patch is tarred into the Linux container and `git apply` rejects it ("patch does not apply" across
   many files). **Fix:** add `newline=''` to all 5 patch-writing `NamedTemporaryFile(mode='w', ...)`
   calls (suffix `.patch` ×3 and `.diff` ×2) so `\n` stays `\n`.

## Docker Desktop gotcha (engine wedged)

A crashed/killed Docker Desktop can orphan its Windows AF_UNIX sockets (`...\Docker\run\dockerInference`,
`...\docker-secrets-engine\engine.sock`) into a reparse state that **cannot be deleted from userspace**
("The file cannot be accessed by the system / syntax is incorrect"). Each Docker service then fails on
startup trying to `remove` its stale socket, so the engine stays "starting" + returns HTTP 500. A reboot
does NOT clear them. **Fix that worked: Docker Desktop → "Reset to factory defaults"** (rebuilds the
WSL2 backend distro). Confirm health with `docker ps` returning instantly. Native x86 runs the amd64
images with no emulation (`docker info` → `arch=x86_64`).
