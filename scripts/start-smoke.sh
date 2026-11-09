#!/usr/bin/env bash
# start-smoke.sh — start the worker for real, and ask it two questions.
#
# Why this exists, when tsc + the suite + `wrangler deploy --dry-run` already
# run: none of those three boots the worker. They have all passed on a bundle
# that workerd then refuses to start — the Workers runtime treats every named
# export of the entry module as a potential entrypoint and rejects anything
# that is not a function or an ExportedHandler, so a stray `export const X = 1`
# type-checks, tests, dry-runs, and takes production down on deploy.
#
# It also catches the other class the sprint has hit twice: a served template
# literal that never interpolated, so agents are handed the characters
# `${something}` where a price or a URL should be. A dry-run cannot see that
# either, because the bytes are only assembled when a route is served.
#
# Two questions, against a real running worker:
#   GET /v5/health    -> 200
#   GET /openapi.json -> 200, and contains no un-interpolated `${`
#
# Exits non-zero on any failure. Cleans up the server on every path out.

set -euo pipefail

fail() { echo "[start-smoke] FAIL: $*" >&2; exit 1; }

# The port probe below treats "curl failed" as "port free". Without a working
# curl every port looks free and every health probe fails, which reads as a
# worker that will not boot (2026-10-08, a WSL bash). Say what is wrong instead.
command -v curl >/dev/null 2>&1 || fail "curl not found in this shell (run the gate from Git for Windows' bash, or via git hook run pre-commit)"
rc=0; curl -s -o /dev/null -m 2 "http://127.0.0.1:1/" 2>/dev/null || rc=$?
[ "$rc" -eq 7 ] || [ "$rc" -eq 28 ] || fail "curl in this shell cannot make local connections (exit $rc on a closed port; expected 7)"

# Pick a port nothing is listening on, so a stray dev server from another
# window cannot make this pass (or fail) for the wrong reason.
PORT=""
for p in $(seq 8850 8879); do
	if ! curl -s -o /dev/null -m 1 "http://127.0.0.1:${p}/" 2>/dev/null; then
		PORT=$p
		break
	fi
done
[ -n "$PORT" ] || fail "no free port in 8850-8879"
INSPECTOR=$((PORT + 100))

LOG=$(mktemp -t start-smoke.XXXXXX.log)
DEV_PID=""

cleanup() {
	# Stop the whole tree on every way out: pass, fail, the 60s timeout, and
	# Ctrl-C (INT/TERM/HUP are routed through exit below, so EXIT runs this).
	#
	# On Windows the tree is: MSYS sh (the npx shim) -> node (npx) -> cmd.exe
	# -> node (wrangler) -> node (wrangler-dist) -> workerd.exe. `kill` on the
	# bash PID ends only the MSYS shim and leaves every native process running;
	# that leaked three workerd trees in two days and caused the 0xC0000142
	# process-start failures of 2026-11-09. taskkill /T walks Windows parent
	# links, so it must run while the root is still alive: before `kill`.
	if [ -n "$DEV_PID" ]; then
		if [ -r "/proc/$DEV_PID/winpid" ] && command -v taskkill.exe >/dev/null 2>&1; then
			WINPID=$(cat "/proc/$DEV_PID/winpid" 2>/dev/null || true)
			if [ -n "$WINPID" ]; then
				taskkill.exe //PID "$WINPID" //T //F >/dev/null 2>&1 || true
			fi
		fi
		kill "$DEV_PID" 2>/dev/null || true
		wait "$DEV_PID" 2>/dev/null || true
	fi
	# Second net: if the root died early, its children are orphaned and /T
	# cannot find them, so close whatever still holds our two ports.
	if [ -n "$PORT" ] && command -v powershell.exe >/dev/null 2>&1; then
		powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $PORT,$INSPECTOR -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1 || true
	fi
	rm -f "$LOG"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

START=$(date +%s)
echo "[start-smoke] starting worker on port ${PORT}..."
npx wrangler dev --port "$PORT" --local --inspector-port "$INSPECTOR" >"$LOG" 2>&1 &
DEV_PID=$!

# Bounded wait. A worker that cannot boot must fail this loop rather than hang
# a pre-commit hook forever.
READY=""
for _ in $(seq 1 60); do
	if ! kill -0 "$DEV_PID" 2>/dev/null; then
		echo "--- wrangler dev output ---" >&2
		tail -40 "$LOG" >&2
		fail "worker process exited before serving (see output above)"
	fi
	if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/v5/health" 2>/dev/null; then
		READY=1
		break
	fi
	sleep 1
done
if [ -z "$READY" ]; then
	echo "--- wrangler dev output ---" >&2
	tail -40 "$LOG" >&2
	fail "worker did not answer /v5/health within 60s"
fi

# 1. Liveness, and the signing path with it — /v5/health returns a signed
#    receipt, so a 200 here means the worker booted AND can sign.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:${PORT}/v5/health")
[ "$CODE" = "200" ] || fail "/v5/health returned ${CODE}, expected 200"
echo "[start-smoke] /v5/health 200"

# 2. The largest served-text surface, checked for placeholders that never
#    interpolated. `${` cannot legitimately appear in the spec we serve.
BODY=$(mktemp -t start-smoke-openapi.XXXXXX.json)
CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 10 "http://127.0.0.1:${PORT}/openapi.json")
if [ "$CODE" != "200" ]; then rm -f "$BODY"; fail "/openapi.json returned ${CODE}, expected 200"; fi
if grep -q '\${' "$BODY"; then
	echo "[start-smoke] un-interpolated placeholders in /openapi.json:" >&2
	grep -o '\${[^}]*}' "$BODY" | sort -u | head -20 >&2
	rm -f "$BODY"
	fail "/openapi.json contains un-interpolated \${...} placeholders"
fi
SIZE=$(wc -c <"$BODY")
rm -f "$BODY"
echo "[start-smoke] /openapi.json 200, ${SIZE} bytes, no un-interpolated placeholders"

ELAPSED=$(( $(date +%s) - START ))
echo "[start-smoke] PASS in ${ELAPSED}s"
