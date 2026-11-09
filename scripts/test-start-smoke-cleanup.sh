#!/usr/bin/env bash
# test-start-smoke-cleanup.sh: the boot check must stop everything it starts.
#
# Why: on Windows, scripts/start-smoke.sh left `wrangler dev --local` process
# trees (node + workerd) running after the pre-commit hook finished, three
# times in two days; the pile-up caused the 0xC0000142 process-start failures
# of 2026-11-09. Killing the bash child does not reach the native node.exe and
# workerd.exe under it.
#
# What this asserts, after two full boot checks and one interrupted (Ctrl-C)
# boot check:
#   1. no process is listening on 8850-8879 (the boot check's ports) or on
#      8950-8979 (their inspector ports);
#   2. no workerd.exe process exists that did not exist before the test
#      (control: the count taken before the first run, not zero, so a dev
#      server the user has open elsewhere does not make this fail).
#
# Windows only: on other platforms the kill path is plain POSIX and this test
# reports SKIP. Run it from Git for Windows' bash:
#   bash scripts/test-start-smoke-cleanup.sh

set -uo pipefail

if ! command -v powershell.exe >/dev/null 2>&1; then
	echo "[test-start-smoke-cleanup] SKIP: not Windows (no powershell.exe)"
	exit 0
fi

ps_listeners() {
	powershell.exe -NoProfile -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { (\$_.LocalPort -ge 8850 -and \$_.LocalPort -le 8879) -or (\$_.LocalPort -ge 8950 -and \$_.LocalPort -le 8979) } | ForEach-Object { '{0} pid={1}' -f \$_.LocalPort, \$_.OwningProcess }" 2>/dev/null | tr -d '\r'
}
ps_workerd_count() {
	powershell.exe -NoProfile -Command "@(Get-Process -Name workerd -ErrorAction SilentlyContinue).Count" 2>/dev/null | tr -d '\r\n '
}

# tasklist answers in ~0.1s; PowerShell's start-up (~1s) is too slow to catch
# the window between workerd starting and the check finishing.
fast_workerd_count() {
	tasklist.exe //FI "IMAGENAME eq workerd.exe" //NH 2>/dev/null | grep -ci '^workerd.exe' || true
}

BEFORE_LISTEN=$(ps_listeners)
if [ -n "$BEFORE_LISTEN" ]; then
	echo "[test-start-smoke-cleanup] FAIL (precondition): ports already in use before the test:" >&2
	echo "$BEFORE_LISTEN" >&2
	exit 1
fi
BEFORE_WORKERD=$(ps_workerd_count)
echo "[test-start-smoke-cleanup] before: 0 listeners on 8850-8879/8950-8979, ${BEFORE_WORKERD} workerd.exe"

for i in 1 2; do
	echo "[test-start-smoke-cleanup] boot check run $i..."
	if ! bash scripts/start-smoke.sh; then
		echo "[test-start-smoke-cleanup] FAIL: boot check run $i did not pass" >&2
		exit 1
	fi
done

# The Ctrl-C path: start a boot check, wait until its workerd exists (the
# worker is up or coming up, the check has not finished), then interrupt the
# script the way a terminal would. Waiting for a listening port instead was
# too slow: the check passed before the interrupt landed (first RED run).
echo "[test-start-smoke-cleanup] boot check run 3, interrupted once its workerd starts..."
RUN3_BASE=$(fast_workerd_count)
# Job control on: without it bash starts a background job with SIGINT
# ignored, and a signal ignored on entry cannot be trapped, so the INT below
# would be a no-op rather than a Ctrl-C.
set -m
bash scripts/start-smoke.sh &
SMOKE_PID=$!
set +m
STARTED=""
for _ in $(seq 1 600); do
	if [ "$(fast_workerd_count)" -gt "$RUN3_BASE" ]; then STARTED=1; break; fi
	kill -0 "$SMOKE_PID" 2>/dev/null || break
	sleep 0.1
done
if [ -z "$STARTED" ]; then
	echo "[test-start-smoke-cleanup] FAIL: run 3 never started a workerd to interrupt" >&2
	exit 1
fi
# To the process group, as a terminal's Ctrl-C does: a bash that alone gets
# INT while waiting on a child carries on unless the child died of INT too.
kill -INT -- -"$SMOKE_PID" 2>/dev/null || kill -INT "$SMOKE_PID" 2>/dev/null || true
RUN3_RC=0; wait "$SMOKE_PID" 2>/dev/null || RUN3_RC=$?
# 130 = our INT trap ran. 0 would mean the check finished first and the
# Ctrl-C path was never exercised, so this test would prove nothing about it.
if [ "$RUN3_RC" -ne 130 ]; then
	echo "[test-start-smoke-cleanup] FAIL: run 3 exited ${RUN3_RC}, expected 130 (interrupted)" >&2
	exit 1
fi

# Process exit is asynchronous on Windows; give the OS a bounded moment.
AFTER_LISTEN=""
AFTER_WORKERD=""
for _ in $(seq 1 10); do
	AFTER_LISTEN=$(ps_listeners)
	AFTER_WORKERD=$(ps_workerd_count)
	if [ -z "$AFTER_LISTEN" ] && [ "$AFTER_WORKERD" -le "$BEFORE_WORKERD" ]; then break; fi
	sleep 1
done

FAILED=0
if [ -n "$AFTER_LISTEN" ]; then
	echo "[test-start-smoke-cleanup] FAIL: still listening after the boot checks:" >&2
	echo "$AFTER_LISTEN" >&2
	FAILED=1
fi
if [ "$AFTER_WORKERD" -gt "$BEFORE_WORKERD" ]; then
	echo "[test-start-smoke-cleanup] FAIL: workerd.exe count ${BEFORE_WORKERD} before, ${AFTER_WORKERD} after" >&2
	FAILED=1
fi
[ "$FAILED" -eq 0 ] || exit 1
echo "[test-start-smoke-cleanup] PASS: 0 listeners on 8850-8879/8950-8979, workerd.exe ${BEFORE_WORKERD} before and ${AFTER_WORKERD} after"
