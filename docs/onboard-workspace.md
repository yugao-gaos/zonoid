# Onboarding a Non-Default Workspace

By default `onboard-loop.js` targets the daemon's configured workspace. When you want to onboard a repo that lives elsewhere — such as a checked-out SWE-bench target — pass `--workspace` explicitly.

## Basic usage

```bash
node scripts/onboard-loop.js \
  --repo /path/to/repo \
  --workspace /path/to/repo \
  --max-rounds 2
```

`--repo` is the filesystem path the script reads. `--workspace` is the key the daemon uses to scope KB entries. They should point to the same directory for foreign repos so KB entries don't collide with your main workspace.

## Running inside a SWE-bench Docker container

The SWE-bench harness mounts the repo at `/repo` inside the container. To onboard at the exact commit the harness will use:

```bash
# 1. On the host: check out the pinned SHA before the container starts
cd /path/to/repo
git checkout <instance_base_sha>

# 2. Start the harness container with the repo mounted
docker run -v /path/to/repo:/repo <harness-image> bash

# 3. Inside the container (or from the host with docker exec):
node /path/to/zonoid/scripts/onboard-loop.js \
  --repo /repo \
  --workspace /repo \
  --max-rounds 2
```

The daemon must be reachable from inside the container. Either run it on the host and expose port 8787, or set `DAEMON_URL` to the host's address:

```bash
DAEMON_URL=http://host.docker.internal:8787 \
  node /path/to/zonoid/scripts/onboard-loop.js \
  --repo /repo \
  --workspace /repo \
  --max-rounds 2
```

## Export after onboarding

```bash
node scripts/export-kb.js \
  --repo /path/to/repo \
  --k 30 \
  --min-score 0.1 \
  > kb-blocks/repo-name.md
```

Pass the same `--repo` path used during onboarding so the export queries the correct workspace scope.
