#!/usr/bin/env bash
# sync-test-count.sh — Extract test count from vitest and update wrangler.toml
#
# Usage: npm run test:sync-count
#   or:  bash scripts/sync-test-count.sh
#
# Runs vitest, reads the total, and patches wrangler.toml [vars] TEST_COUNT so
# the next deploy picks it up. TEST_COUNT is served at /v5/metrics/public, so a
# stale value is a number we publish and cannot support.
#
# The extraction itself lives in scripts/vitest-count.sh — one place, shared
# with the CI verify step, because this file and that step had the same
# one-liner and the same bug in both.

set -euo pipefail

echo "Running tests..."
# Allow a red run to reach the extractor, which refuses to report a count for
# one. Swallowing the exit code here and checking the summary below keeps the
# failure message useful.
TEST_OUTPUT=$(npx vitest run 2>&1) || true

if ! COUNT=$(printf '%s\n' "$TEST_OUTPUT" | bash "$(dirname "$0")/vitest-count.sh" -); then
	echo "ERROR: no all-passing test total in the vitest output — not updating count."
	echo "Last 20 lines:"
	printf '%s\n' "$TEST_OUTPUT" | tail -20
	exit 1
fi

echo "Tests passing: $COUNT"

# Update wrangler.toml
if grep -q '^TEST_COUNT' wrangler.toml; then
	sed -i "s/^TEST_COUNT = \"[0-9]*\"/TEST_COUNT = \"$COUNT\"/" wrangler.toml
	echo "Updated wrangler.toml: TEST_COUNT = \"$COUNT\""
else
	echo "WARNING: TEST_COUNT not found in wrangler.toml — add it under [vars]"
	exit 1
fi

echo "Done. Run 'npm run deploy' to push the updated count to production."
