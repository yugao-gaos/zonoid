# Zonoid Bench SDK — Design

## 1. Motivation
Three benches drive Zonoid as a memory backend with duplicated, divergent machinery: two HTTP clients (`bench/swe-bench-cl/zonoid_memory.py` uses `requests`; `bench/agent-memory/zonoid_lifecycle.py` uses `urllib`), the 6 load-bearing daemon findings copy-pasted into both, three workspace-slug functions, two near-identical `claude -p` JSON-judge parsers. `zonoid_memory.py` won't run on this Windows/embeddable box. Worse: NO canonical "Zonoid ON arm" — SWE-Bench-CL judges the autowire candidate set + reads tiered `/search`; agent-memory judges ALL sessions + reads `/task/context`; FeatureBench uses `suggest_links` + a real agent. Goal: one SDK = one source of truth.

## 2. Scope
IN: HTTP client · `claude -p` judge · workspace/isolation · embedded-daemon lifecycle · pre-learnt KB snapshot load/produce · arms (ON / OFF-cold / RAG-control) · results/report scaffold.
OUT: dataset loaders · benchmark task defs · the daemon source · FeatureBench's Node onboarding (`onboard-learn.js` stays).

## 3. Runtime
Python, stdlib-only (urllib/json/subprocess) → runs on embeddable Python (`C:\Users\Imyu\AppData\Local\py312embed\python.exe`) + Mac/Linux. Node required to spawn the daemon. Windows-safe `claude -p` (stdin, `shutil.which`, utf-8, `mcp-off.json`) baked in.

## 4. Module surface (`bench/zonoid_bench/`)
- `client.py` — post_note · search(tiered,gated) · post_verdict(wrapped) · get_task_context · post_status · task_suggest (GET /task/suggest → suggest_links, ceScore) · overlay_edge (POST /overlay/edge) · warm_up. 6 daemon findings as code.
- `judge.py` — claude_p() (Windows-safe) · parse_strict_json() · EdgeJudge (keep/prune + distinct/consolidate).
- `workspace.py` — workspace_key() (lockstep w/ lib/filedrop-tasks.js) · isolated_ws() · drop_task_stub().
- `daemon.py` — start(daemon_js, port, data_dir) → poll /health(phase:ready) → client; stop(). (§6)
- `warm.py` — load_snapshot() · produce_snapshot(). (§7)
- `arms.py` — canonical ON-arm + pluggable executor + OFF-cold + RAG-control. (§5)
- `report.py` — write_results · score hooks · render_report · scorecard_section.

## 5. Canonical ON arm (REUSE FeatureBench ClaudeCodeAgent)
Port `.venv-fb/Lib/site-packages/featurebench/infer/agents/claude_code.py` (`_setup_zonoid_context` + `_build_agents_md`): (1) register unit as note/task (POST /overlay/note); (2) GET /search?q= for relevant notes; (3) GET /task/suggest?key= (suggest_links → ceScore cross-encoder) → POST /overlay/edge to WIRE the verified DAG (ceScore>0.2, non-dup); (4) read = AGENTS.md preload of verified context + live GET /search?q=&task_key= during the session. Supersedes agent-memory's judge-all-sessions divergence (omitted suggest_links, inflated by judging the full session set). Pluggable executor: (a) agent_in_container — real Claude Code + AGENTS.md preload + live search, graded by the bench's tests; (b) retrieve_and_answer — read the wired DAG + answer via claude -p, scored vs gold (QA, can't spawn an agent per 500 probes). Contrast arms: OFF-cold (rigging guard), RAG-control (/search, no task_key).

## 6. Embedded bench daemon
SDK spawns its OWN daemon so benches stop sharing the dev :8787 (the cause of mid-run 503s + contamination). Two env vars isolate it: ORCH_PORT=<port> (daemon.js:39) + CLAUDE_PLUGIN_DATA=<bench data dir> (daemon.js:42 — relocates overlay/sessions/file-drop/journals/embed+rerank cache). daemon.py: pick free port → subprocess Popen `node <daemon_js>` → poll GET /health until phase:ready (whitelisted through the 503 boot gate, daemon.js:332) → bound client → stop() terminates. Read <ws>/.graph/daemon.port for discovery. daemon_js = repo-root daemon.js (or installed @zonoid/cli). Share the embed/rerank MODEL files (symlink), isolate graph/overlay data.

## 7. Pre-learnt KB snapshot (don't relearn each run)
Expensive step = MINE+DRAIN (agentic LLM learner); INJECT is cheap. produce_snapshot(repo, base_commit, out) wraps bench/swe-bench-cl/warm_start.js (mine→enqueue→drain) ONCE, keyed by (repo, base_commit) per bench/featurebench-kb/pilot-manifest.json. load_snapshot(snapshot, workspace): Level A (default) re-inject drained batches via scripts/onboard-learn.js --inject --confirm --workspace <abs> (ORCH_GATE_OFF=1, --model sonnet) — skips MINE+DRAIN; Level B (cache) copy a materialized .graph tarball in; also static AGENTS.md (FeatureBench FB_KB_PATH) passthrough. Snapshot artifacts already exist under bench/onboard/<repo>/.

## 8. Migration plan
agent-memory: zonoid_lifecycle.py→client; probe_runner our-way→arms canonical ON-arm (FIDELITY FIX — adds suggest_links, stops judging-all-sessions, removes inflation); use daemon.py + warm.py + report.py; keep datasets.py. swe-bench-cl: HTTP+judge→client+judge (gains Windows); ON arm→arms; keep FAISS-seam shim. FeatureBench: onboarding stays onboard-learn.js; eval ON arm = arms agent_in_container (claude_code.py is the reference).

## 9. Decisions
RESOLVED: MCP/live-agent mode already exists (FeatureBench) — reuse · suggest_links + ceScore IN · read = preload + live /search?task_key= · snapshot Level A default + B cache · keyed by (repo, base_commit) · share embed model cache, isolate data · default one daemon serving N isolated workspaces.
OPEN: reconcile with the in-flight `orch/feature/pluggable-backend` branch if it overlaps the backend/arms seam (check before finalizing arms.py).

## 10. Known daemon gap (encoded, not fixed)
structBoost/keepEdge: note↔note kept edges don't boost retrieval over the isolated-workspace HTTP surface; createEdge is needed for task→note context (upserts a judged edge vs keepEdge which only promotes a pre-existing ≥0.55 autowire candidate). SDK encodes the createEdge workaround + documents the gap. Clean daemon fix is gated (note-mqfm5mvl8zw), OUT of SDK scope.
