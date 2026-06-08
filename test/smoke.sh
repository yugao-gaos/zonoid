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

# loop + persistence across a PID restart
jpost loop/start '{"maxIterations":50}' >/dev/null
chk "next-action spawns"        "$(g next-action | jq -r .action)"               "spawn"
ITER=$(g loop/status | jq -r .iterations)
stop; boot
jpost workspace "$(b_ws)" >/dev/null
chk "loop persisted on restart" "$(g loop/status | jq -r .active)"               "true"
chk "iterations preserved"      "$(g loop/status | jq -r ".iterations>=$ITER")"  "true"

# format-drift detection
echo 'NOT JSON' > "$T/3.json"; sleep 1.7
chk "drift -> health unhealthy" "$(g health | jq -r .native_format.healthy)"     "false"

stop
rm -rf "$PROJ" "$T" "$CLAUDE_PLUGIN_DATA"
echo "-----"; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
