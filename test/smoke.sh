#!/bin/bash
# Smoke test: exercises the daemon end to end against an isolated fixture. Safe to run while the
# live :8787 daemon is up — it uses its own port (8799), its own state dir (CLAUDE_PLUGIN_DATA),
# and controls its daemon by PID (never pkills/port-kills anything else).
# Run: bash test/smoke.sh
set -u
cd "$(dirname "$0")/.." || exit 1
PORT=8799; pass=0; fail=0; DPID=""
export CLAUDE_PLUGIN_DATA="/tmp/orch-smoke-data"      # isolate overlay/loop/workspace from production
chk(){ if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (got '$2' want '$3')"; fail=$((fail+1)); fi; }
boot(){ ORCH_PORT=$PORT node "$PWD/daemon.js" >>/tmp/orch-smoke.log 2>&1 & DPID=$!; for i in $(seq 1 40); do curl -s --max-time 0.3 localhost:$PORT/ping >/dev/null 2>&1 && break; sleep 0.1; done; }
stop(){ [ -n "$DPID" ] && kill -9 "$DPID" 2>/dev/null; sleep 0.3; }
g(){ curl -s "localhost:$PORT/$1"; }
jpost(){ local path="$1"; shift; curl -s -H 'content-type: application/json' -XPOST "localhost:$PORT/$path" -d "$1"; }

# clean isolated state + free our port (port-specific; does not touch :8787)
rm -rf "$CLAUDE_PLUGIN_DATA"; lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3
WS=/tmp/orch-smoke; S=99999999-0000-0000-0000-000000000001
PROJ="$HOME/.claude/projects/-tmp-orch-smoke"; T="$HOME/.claude/tasks/$S"
mkdir -p "$PROJ" "$T"; : > "$PROJ/$S.jsonl"
echo '{"id":"1","subject":"a","status":"pending","blockedBy":[]}'    > "$T/1.json"
echo '{"id":"2","subject":"b","status":"pending","blockedBy":["1"]}' > "$T/2.json"
: > /tmp/orch-smoke.log
b_ws(){ printf '{"path":"%s"}' "$WS"; }
b_status(){ printf '{"key":"%s","status":"%s"}' "$1" "$2"; }

boot
jpost workspace "$(b_ws)" >/dev/null
chk "ping"                      "$(g ping | jq -r .ok)"                          "true"
chk "format health healthy"     "$(g health | jq -r .native_format.healthy)"     "true"
chk "state has 2 tasks"         "$(g state | jq '.tasks|length')"                "2"
chk "ready = a"                 "$(g ready | jq -r '.ready[0].label')"           "a"
chk "multi-ws read (?workspace)" "$(g 'state?workspace=/tmp/orch-smoke' | jq -r .workspace)" "/tmp/orch-smoke"

# review gate
jpost config '{"require_review":true}' >/dev/null
chk "done blocked w/o tested"   "$(jpost overlay/status "$(b_status "$S/1" done)" | jq -r '.error!=null')" "true"
jpost overlay/status "$(b_status "$S/1" tested)" >/dev/null
chk "done allowed after tested" "$(jpost overlay/status "$(b_status "$S/1" done)" | jq -r .ok)" "true"
chk "b ready after a done"      "$(g ready | jq -r '.ready[0].label')"           "b"

# SSE emits on a mutation
( curl -sN --max-time 2 localhost:$PORT/events > /tmp/orch-sse.out 2>&1 ) & sleep 0.4
jpost overlay/status "$(b_status "$S/2" ready)" >/dev/null; sleep 0.5   # mutation triggers SSE; leaves b ready
chk "SSE pushed on change"      "$([ "$(grep -c 'data: changed' /tmp/orch-sse.out)" -ge 2 ] && echo yes || echo no)" "yes"

# edge add then remove (re-parallelize): add a context edge, then remove it
jpost overlay/edge "$(printf '{"from":"%s","to":"%s","kind":"context"}' "$S/1" "$S/2")" >/dev/null
chk "edge added"                "$(g state | jq '.edges|length')"               "1"
chk "edge removed"              "$(jpost overlay/edge/remove "$(printf '{"from":"%s","to":"%s"}' "$S/1" "$S/2")" | jq -r .removed)" "1"
chk "edges empty after remove"  "$(g state | jq '.edges|length')"               "0"

# concurrency: cancel-wins-over-heartbeat + optimistic compare-and-set (409 on stale)
jpost overlay/status "$(b_status "$S/2" canceled)" >/dev/null
chk "cancel sets flag"          "$(g 'task/detail?key='"$S"'/2' | jq -r '.cancel_requested!=null')" "true"
chk "heartbeat blocked by cancel" "$(jpost overlay/status "$(b_status "$S/2" in_progress)" | jq -r '.error!=null')" "true"
chk "still canceled"            "$(g 'task/detail?key='"$S"'/2' | jq -r '.task.status')" "canceled"
chk "force reopens cancel"      "$(jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","force":true}' "$S/2")" | jq -r .ok)" "true"
chk "cancel flag cleared"       "$(g 'task/detail?key='"$S"'/2' | jq -r '.cancel_requested==null')" "true"
chk "CAS stale -> 409"          "$(jpost overlay/status "$(printf '{"key":"%s","status":"failed","expected_status":"canceled"}' "$S/2")" | jq -r '.error!=null')" "true"
chk "CAS match -> ok"           "$(jpost overlay/status "$(printf '{"key":"%s","status":"failed","expected_status":"in_progress"}' "$S/2")" | jq -r .ok)" "true"
# restore $S/2 to ready so the loop/spawn section below still sees a spawnable task
jpost overlay/status "$(b_status "$S/2" ready)" >/dev/null

# cross-session agent visibility + cooperative stop
jpost agent/start "$(printf '{"agent_id":"w1","task":"%s","session":"%s"}' "$S/2" "$S")" >/dev/null
chk "agent listed"              "$(g agents | jq -r '.agents[]|select(.agent_id=="w1")|.task')" "$S/2"
chk "no stop flag yet"          "$(g agents | jq -r '.agents[]|select(.agent_id=="w1")|.stop_requested')" "null"
chk "stop by task_key resolves" "$(jpost agent/stop "$(printf '{"task_key":"%s"}' "$S/2")" | jq -r '.agent_id')" "w1"
chk "stop flag set"             "$(g 'agent/stop-requested?agent_id=w1' | jq -r '.stop_requested!=null')" "true"
chk "stop unknown task -> 404"  "$(jpost agent/stop '{"task_key":"no/such"}' | jq -r '.error!=null')" "true"

# safe claim (CAS on ownership): canceled refused, double-claim refused, force takes over
CK="$S/cas"
jpost overlay/status "$(b_status "$CK" canceled)" >/dev/null
chk "claim canceled refused"    "$(jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","agent_id":"ax"}' "$CK")" | jq -r '.error!=null')" "true"
CK2="$S/cas2"
chk "fresh claim ok"            "$(jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","agent_id":"ax"}' "$CK2")" | jq -r .ok)" "true"
chk "double-claim refused"      "$(jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","agent_id":"ay"}' "$CK2")" | jq -r '.error!=null')" "true"
chk "re-claim same agent ok"    "$(jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","agent_id":"ax"}' "$CK2")" | jq -r .ok)" "true"
chk "force takeover ok"         "$(jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","agent_id":"ay","force":true}' "$CK2")" | jq -r .ok)" "true"

# enforced cooperative-stop: /should-stop maps session->task->agent; PreToolUse hook denies (exit 2).
# An agent-targeted stop must halt ONLY the targeted worker (the hook forwards its agent_id as `agent`),
# NOT the orchestrating driver that requested the stop and shares the same session_id with no agent_id.
HK="$PWD/hooks/orch-stop.sh"; HS=$S/hook; HA=hookw
jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","agent_id":"%s"}' "$HS" "$HA")" >/dev/null
# associate the claim with our smoke session by writing it onto a native task in session $S
echo '{"id":"hook","subject":"h","status":"in_progress","blockedBy":[]}' > "$T/hook.json"; sleep 1.2
chk "should-stop false (clean)"   "$(g "should-stop?session=$S" | jq -r .stop)"          "false"
chk "hook exit0 normal session"   "$(printf '{"session_id":"%s","tool_name":"Bash"}' "$S" | ORCH_PORT=$PORT bash "$HK" >/dev/null 2>&1; echo $?)" "0"
jpost agent/stop "$(printf '{"agent_id":"%s"}' "$HA")" >/dev/null
# the targeted worker (its own agent_id) IS halted
chk "should-stop true (worker)"   "$(g "should-stop?session=$S&agent=$HA" | jq -r .stop)" "true"
HKOUT=$(printf '{"session_id":"%s","agent_id":"%s","tool_name":"Bash"}' "$S" "$HA" | ORCH_PORT=$PORT bash "$HK" 2>&1 1>/dev/null); HKRC=$?
chk "hook exit2 for worker"       "$HKRC"                                                 "2"
chk "hook STOP message"           "$(printf '%s' "$HKOUT" | grep -c 'STOP:')"            "1"
# the SAME-SESSION driver that requested the stop is NOT self-blocked (no agent_id on its calls)
chk "should-stop false (driver)"  "$(g "should-stop?session=$S" | jq -r .stop)"          "false"
chk "hook exit0 for driver"       "$(printf '{"session_id":"%s","tool_name":"Bash"}' "$S" | ORCH_PORT=$PORT bash "$HK" >/dev/null 2>&1; echo $?)" "0"
rm -f "$T/hook.json"

# loop + persistence across a PID restart
jpost loop/start '{"maxIterations":50}' >/dev/null
chk "next-action spawns"        "$(g next-action | jq -r .action)"               "spawn"
ITER=$(g loop/status | jq -r .iterations)
stop; boot
jpost workspace "$(b_ws)" >/dev/null
chk "loop persisted on restart" "$(g loop/status | jq -r .active)"               "true"
chk "iterations preserved"      "$(g loop/status | jq -r ".iterations>=$ITER")"  "true"

# self-learning 'plan' tick: drain the DAG with self_plan on -> heartbeat hands out a plan action
jpost config '{"self_plan":true}' >/dev/null
jpost overlay/status "$(b_status "$S/1" done)"   >/dev/null   # already tested above; allowed
jpost overlay/status "$(b_status "$S/2" tested)" >/dev/null; jpost overlay/status "$(b_status "$S/2" done)" >/dev/null
chk "drained+self_plan -> plan"  "$(g next-action | jq -r .action)"              "plan"
jpost config '{"self_plan":false}' >/dev/null
chk "drained, no self_plan -> stop" "$(g next-action | jq -r .action)"           "stop"

# optimize-loop control (⑥): a DONE problem carrying a metric spec + a judge verdict, DAG drained.
# With no target met and budget remaining the heartbeat returns an 'optimize' action (iterate on the
# SAME problem, prior verdict fed forward). A converge-on-target verdict instead falls through to stop.
jpost loop/start '{"maxIterations":50,"tokenBudget":500000}' >/dev/null   # re-arm (prior section may have stopped it)
chk "optimize knobs stored"     "$(jpost config '{"optimize":{"epsilon":1,"diminishing_rounds":3}}' | jq -r '.config.optimize.diminishing_rounds')" "3"
OPSPEC='{"metric":"p95_latency_ms","direction":"min","measure_command":"echo 150","parse":"last_number","target":120}'
jpost task/metric "$(printf '{"key":"%s","spec":%s}' "$S/1" "$OPSPEC")" >/dev/null
# a winning verdict ABOVE target (150 > 120) -> not converged -> iterate
jpost overlay/knowledge "$(printf '{"key":"%s","item":{"type":"note","value":{"winner":"%s","metric_value":150,"guardrails_ok":true,"improvement":"-50ms"}}}' "$S/1" "$S/1")" >/dev/null
OPA=$(g next-action)
chk "drained+unmet metric -> optimize" "$(echo "$OPA" | jq -r .action)"          "optimize"
chk "optimize carries the problem"     "$(echo "$OPA" | jq -r .problem)"          "$S/1"
chk "optimize feeds prior verdict"     "$(echo "$OPA" | jq -r .prior_verdict.metric_value)" "150"
# same poll again WITHOUT a new verdict: no new round -> does NOT re-iterate (falls through to stop)
chk "no new verdict -> no re-iterate"  "$(g next-action | jq -r '.action!="optimize"')" "true"
# a NEW verdict AT target (118 <= 120) -> converged: marks closed, falls through to stop
jpost overlay/knowledge "$(printf '{"key":"%s","item":{"type":"note","value":{"winner":"%s","metric_value":118,"guardrails_ok":true}}}' "$S/1" "$S/1")" >/dev/null
chk "new verdict at target -> converged->stop" "$(g next-action | jq -r .action)"  "stop"
jpost task/metric "$(printf '{"key":"%s"}' "$S/1")" >/dev/null   # clear metric so later sections start clean
jpost loop/stop '{}' >/dev/null

# cooperative self-stop: arm the loop to a session, flag a stop on its claimed task's agent,
# and confirm the in-process heartbeat self-exits WITHIN ONE iteration (loop.active -> false).
SS=88888888-0000-0000-0000-000000000002; SSP="$HOME/.claude/projects/-tmp-orch-smoke"; SST="$HOME/.claude/tasks/$SS"
mkdir -p "$SSP" "$SST"; : > "$SSP/$SS.jsonl"
echo '{"id":"1","subject":"loopwork","status":"pending","blockedBy":[]}' > "$SST/1.json"; sleep 1.2
jpost overlay/status "$(printf '{"key":"%s","status":"in_progress","agent_id":"loopw"}' "$SS/1")" >/dev/null
jpost loop/start "$(printf '{"maxIterations":50,"session":"%s"}' "$SS")" >/dev/null
chk "loop armed w/ session"     "$(g loop/status | jq -r .session)"              "$SS"
# work is in flight ($SS/1 claimed in_progress) -> heartbeat idles, not stops
chk "armed loop ticks normally" "$(g next-action | jq -r '.action!="stop"')"     "true"
jpost agent/stop '{"agent_id":"loopw"}' >/dev/null     # simulate cooperative stop
# hook path is actor-keyed: the worker's own agent_id sees the stop; a driver poll (no agent) does not
chk "should-stop sees flag"     "$(g "should-stop?session=$SS&agent=loopw" | jq -r .stop)" "true"
# the in-process heartbeat is session-scoped, so it still self-exits on its claimed agent's stop
chk "loop self-exits on stop"   "$(g next-action | jq -r .reason)"               "cooperative stop"
chk "loop.active cleared"       "$(g loop/status | jq -r .active)"               "false"
rm -rf "$SST" "$SSP/$SS.jsonl"

# target-repo decoupling: workspace (/tmp/orch-smoke) is NOT a git repo (the dogfood case), so a
# task carries a SEPARATE target repo path; /git/* resolve it (explicit > task field > workspace).
GREPO=$(mktemp -d /tmp/orch-smoke-repo.XXXXXX); GK="$S/1"   # a real native task, so /task/detail finds it
chk "git_status: workspace not a repo" "$(g 'git/status' | jq -r .isRepo)"        "false"
jpost git/repo "$(printf '{"key":"%s","repo_path":"%s"}' "$GK" "$GREPO")" >/dev/null
chk "task carries target repo"  "$(g 'task/detail?key='"$GK" | jq -r .repo)"      "$GREPO"
chk "node exposes repo field"   "$(g state | jq -r '.tasks[]|select(.id=="'"$GK"'")|.repo')" "$GREPO"
chk "git_init on target repo"   "$(jpost git/init "$(printf '{"key":"%s"}' "$GK")" | jq -r '.head!=null and .repo=="'"$GREPO"'"')" "true"
chk "git_status resolves task repo" "$(g 'git/status?key='"$GK" | jq -r '.isRepo and .repo=="'"$GREPO"'"')" "true"
chk "branch_task on target repo" "$(jpost git/worktree "$(printf '{"key":"%s"}' "$GK")" | jq -r '.branch=="orch/attempt/'"$(printf '%s' "$GK" | tr '/' '-')"'"')" "true"
chk "explicit repo_path overrides task field (status)" "$(g 'git/status?repo_path=/tmp/orch-smoke' | jq -r .isRepo)" "false"
chk "merge_attempt on target repo" "$(jpost git/merge "$(printf '{"key":"%s"}' "$GK")" | jq -r '.merged or (.conflict!=null) or (.reason!=null)')" "true"
chk "remove_worktree on target repo" "$(jpost git/worktree/remove "$(printf '{"key":"%s"}' "$GK")" | jq -r .ok)" "true"
rm -rf "$GREPO" "$CLAUDE_PLUGIN_DATA/worktrees"

# inline metric spec: a task carries a metric-driven objective; set/clear, validation, surfacing
MK="$S/1"
SPEC='{"metric":"p95_latency_ms","direction":"min","measure_command":"npm run bench","parse":"last_number","target":120}'
chk "set_task_metric ok"        "$(jpost task/metric "$(printf '{"key":"%s","spec":%s}' "$MK" "$SPEC")" | jq -r .ok)" "true"
chk "task carries metric spec"  "$(g 'task/detail?key='"$MK" | jq -r .metric.metric)" "p95_latency_ms"
chk "node exposes metric field" "$(g state | jq -r '.tasks[]|select(.id=="'"$MK"'")|.metric.direction')" "min"
chk "reject: missing direction" "$(jpost task/metric "$(printf '{"key":"%s","spec":{"metric":"x","measure_command":"c"}}' "$MK")" | jq -r '.error!=null')" "true"
chk "reject: bad direction"     "$(jpost task/metric "$(printf '{"key":"%s","spec":{"metric":"x","direction":"lower","measure_command":"c"}}' "$MK")" | jq -r '.error!=null')" "true"
chk "reject: missing measure"   "$(jpost task/metric "$(printf '{"key":"%s","spec":{"metric":"x","direction":"min"}}' "$MK")" | jq -r '.error!=null')" "true"
chk "metric still set after rejects" "$(g 'task/detail?key='"$MK" | jq -r .metric.metric)" "p95_latency_ms"
chk "clear metric (empty spec)" "$(jpost task/metric "$(printf '{"key":"%s"}' "$MK")" | jq -r '.ok and (.metric==null)')" "true"
chk "metric cleared on node"    "$(g 'task/detail?key='"$MK" | jq -r '.metric==null')" "true"

# measure node: run the spec's measure_command in the attempt worktree, parse + store the value(s)
MREPO=$(mktemp -d /tmp/orch-smoke-measure.XXXXXX); MMK="$S/1"
jpost git/repo "$(printf '{"key":"%s","repo_path":"%s"}' "$MMK" "$MREPO")" >/dev/null
jpost git/init "$(printf '{"key":"%s"}' "$MMK")" >/dev/null
# fake measure commands: attempt emits 42, guardrail emits 1 (echo, no real bench needed)
MSPEC='{"metric":"score","direction":"max","measure_command":"echo 42","parse":"last_number","guardrails":[{"metric":"test_pass","direction":"max","measure_command":"echo 1","parse":"last_number"}]}'
jpost task/metric "$(printf '{"key":"%s","spec":%s}' "$MMK" "$MSPEC")" >/dev/null
chk "measure_task parses value"  "$(jpost task/measure "$(printf '{"key":"%s"}' "$MMK")" | jq -r '.measurement.value')" "42"
chk "measure_task runs guardrail" "$(g 'task/detail?key='"$MMK" | jq -r '.measurement.guardrails.test_pass')" "1"
chk "measure baseline stored"    "$(jpost task/measure "$(printf '{"key":"%s","baseline":true}' "$MMK")" | jq -r '.measurement.baseline.value')" "42"
chk "node exposes measurement"   "$(g state | jq -r '.tasks[]|select(.id=="'"$MMK"'")|.measurement.value')" "42"
chk "measure: no spec rejected"  "$(jpost task/measure "$(printf '{"key":"%s"}' "$S/2")" | jq -r '.error!=null')" "true"
rm -rf "$MREPO" "$CLAUDE_PLUGIN_DATA/worktrees"

# researched benchmark: a task carries a competitor/industry-average reference; set/clear, validation, surfacing
BK="$S/1"
BENCH='{"metric":"p95_latency_ms","value":95,"unit":"ms","source":"https://example.com/report","confidence":"med"}'
chk "set_task_benchmark ok"      "$(jpost task/benchmark "$(printf '{"key":"%s","benchmark":%s}' "$BK" "$BENCH")" | jq -r .ok)" "true"
chk "task carries benchmark"     "$(g 'task/detail?key='"$BK" | jq -r .benchmark.metric)" "p95_latency_ms"
chk "node exposes benchmark"     "$(g state | jq -r '.tasks[]|select(.id=="'"$BK"'")|.benchmark.value')" "95"
chk "reject: missing value"      "$(jpost task/benchmark "$(printf '{"key":"%s","benchmark":{"metric":"x","source":"s"}}' "$BK")" | jq -r '.error!=null')" "true"
chk "reject: missing source"     "$(jpost task/benchmark "$(printf '{"key":"%s","benchmark":{"metric":"x","value":1}}' "$BK")" | jq -r '.error!=null')" "true"
chk "reject: bad confidence"     "$(jpost task/benchmark "$(printf '{"key":"%s","benchmark":{"metric":"x","value":1,"source":"s","confidence":"vlow"}}' "$BK")" | jq -r '.error!=null')" "true"
chk "benchmark still set after rejects" "$(g 'task/detail?key='"$BK" | jq -r .benchmark.metric)" "p95_latency_ms"
chk "clear benchmark (empty)"    "$(jpost task/benchmark "$(printf '{"key":"%s"}' "$BK")" | jq -r '.ok and (.benchmark==null)')" "true"
chk "benchmark cleared on node"  "$(g 'task/detail?key='"$BK" | jq -r '.benchmark==null')" "true"

# format-drift detection
echo 'NOT JSON' > "$T/3.json"; sleep 1.7
chk "drift -> health unhealthy" "$(g health | jq -r .native_format.healthy)"     "false"

stop
rm -rf "$PROJ" "$T" "$CLAUDE_PLUGIN_DATA"
echo "-----"; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
