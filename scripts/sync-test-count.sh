#!/usr/bin/env bash
# sync-test-count.sh — Extract test count from vitest and update wrangler.toml
#
# Usage: npm run test:sync-count
#   or:  bash scripts/sync-test-count.sh
#
# Runs vitest, extracts the "N passed" count, and patches wrangler.toml [vars]
# TEST_COUNT so the next deploy picks it up automatically.

set -euo pipefail

echo "Running tests..."
# Run vitest and capture output (allow it to succeed or fail)
TEST_OUTPUT=$(npx vitest run 2>&1) || true

# Extract "N passed" from vitest output (e.g. "691 passed")
COUNT=$(echo "$TEST_OUTPUT" | grep -oP '\d+(?= passed)' | head -1)

if [ -z "$COUNT" ]; then
  echo "ERROR: Could not extract test count from vitest output"
  echo "Last 10 lines of output:"
  echo "$TEST_OUTPUT" | tail -10
  exit 1
fi

# Check for failures
if echo "$TEST_OUTPUT" | grep -q "failed"; then
  echo "ERROR: Tests have failures — not updating count"
  echo "$TEST_OUTPUT" | grep -E "failed|passed"
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
