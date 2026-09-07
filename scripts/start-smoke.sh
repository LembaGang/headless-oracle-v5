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
	if [ -n "$DEV_PID" ]; then
		kill "$DEV_PID" 2>/dev/null || true
		wait "$DEV_PID" 2>/dev/null || true
	fi
	# wrangler spawns workerd as a child; on Windows the kill above may not
	# reach it, so close the port explicitly.
	if command -v powershell.exe >/dev/null 2>&1; then
		powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1 || true
	fi
	rm -f "$LOG"
}
trap cleanup EXIT

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
