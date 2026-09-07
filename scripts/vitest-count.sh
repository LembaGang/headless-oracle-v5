#!/usr/bin/env bash
# vitest-count.sh — the one place that knows how to read a test total out of
# vitest output. Reads a file (or stdin), prints the number, exits non-zero if
# it cannot find one.
#
# It exists because the same one-liner was inlined in two places and was wrong
# in both. `grep -oP '\d+(?= passed)' | head -1` takes the FIRST "N passed" in
# the output, and vitest prints the file summary first:
#
#     Test Files  2 passed (2)          <- head -1 stopped here
#          Tests  1288 passed (1288)    <- the number anyone actually wanted
#
# So CI annotated "actual test count (2)" against a TEST_COUNT of 1288 for as
# long as the check has existed.
#
# Three fixes, all needed:
#   1. anchor on the `Tests` summary line, not the first "N passed" anywhere;
#   2. strip ANSI colour codes first — vitest emits them between "Tests" and
#      the digits, which defeats a naive anchored pattern;
#   3. use sed, not `grep -P`. On the Git Bash that runs the local pre-commit
#      hook, `grep -P` refuses outright ("supports only unibyte and UTF-8
#      locales"), so the old detector did not merely mis-count locally — it
#      produced nothing at all, and `npm run test:sync-count` could never have
#      worked on this machine.
#
# Emits nothing and fails when the run had failures: the summary then reads
# "Tests  1 failed | 1287 passed", the anchored pattern does not apply, and a
# caller must never be handed a count from a red run.

set -euo pipefail

SRC="${1:--}"
if [ "$SRC" = "-" ]; then
	INPUT=$(cat)
else
	INPUT=$(cat "$SRC")
fi

STRIPPED=$(printf '%s\n' "$INPUT" | sed -E "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g")
COUNT=$(printf '%s\n' "$STRIPPED" \
	| sed -nE 's/^[[:space:]]*Tests[[:space:]]+([0-9]+)[[:space:]]+passed.*/\1/p' \
	| tail -1)

if [ -z "${COUNT:-}" ]; then
	echo "vitest-count: could not read an all-passing 'Tests N passed' summary" >&2
	printf '%s\n' "$STRIPPED" | sed -nE '/^[[:space:]]*(Tests|Test Files)/p' >&2 || true
	exit 1
fi

printf '%s\n' "$COUNT"
