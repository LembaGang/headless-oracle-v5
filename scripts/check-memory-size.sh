#!/usr/bin/env bash
# Size gate for the memory files Claude Code loads into EVERY session in this repo:
# CLAUDE.md, .claude/CLAUDE.md, and every .claude/rules/*.md without `paths:`
# frontmatter (a paths-scoped rule loads only for matching files, so it is skipped).
#
# Why: these files are read at the start of every session, so each character is
# paid for every time. .claude/rules/90_active_priorities.md grew to 162k chars
# (~40k tokens) as an append-only log and nothing noticed until a /doctor run on
# 2026-10-02 moved its history to docs/history/. This gate makes that growth fail
# a commit instead of silently taxing every session.
#
# Limits (characters; tokens are roughly chars / 4):
#   MEMORY_FILE_MAX   per file, default 60000. CLAUDE.md is ~53k today.
#   MEMORY_TOTAL_MAX  all always-loaded files together, default 150000 (~140k today).
#   MEMORY_FILE_WARN  per-file warning, default 40000: the floor at which Claude Code
#                     itself warns that a memory file is large. A warning, not a failure.
# When the gate fails, move history out (docs/history/ is not auto-loaded) rather
# than raising the limit; raising it is a deliberate edit to this file.
#
# Usage: bash scripts/check-memory-size.sh   (exit 0 pass, 1 fail)

set -euo pipefail

FILE_MAX="${MEMORY_FILE_MAX:-60000}"
TOTAL_MAX="${MEMORY_TOTAL_MAX:-150000}"
FILE_WARN="${MEMORY_FILE_WARN:-40000}"

files=()
for f in CLAUDE.md .claude/CLAUDE.md .claude/rules/*.md; do
	[ -f "$f" ] || continue
	# Skip rules scoped with `paths:` frontmatter: they are not always loaded.
	if [ "$(head -n 1 "$f" | tr -d '\r')" = "---" ] && sed -n '2,/^---/p' "$f" | grep -q '^paths:'; then
		continue
	fi
	files+=("$f")
done

total=0
status=0
for f in "${files[@]}"; do
	n=$(wc -m < "$f" | tr -d ' ')
	total=$((total + n))
	if [ "$n" -gt "$FILE_MAX" ]; then
		echo "[memory-size] FAIL $f is $n chars (limit $FILE_MAX). Move history to docs/history/." >&2
		status=1
	elif [ "$n" -gt "$FILE_WARN" ]; then
		echo "[memory-size] warn $f is $n chars (Claude Code warns above ~$FILE_WARN)."
	fi
done

if [ "$total" -gt "$TOTAL_MAX" ]; then
	echo "[memory-size] FAIL always-loaded memory totals $total chars across ${#files[@]} files (limit $TOTAL_MAX, ~$((total / 4)) est. tokens per session)." >&2
	status=1
else
	echo "[memory-size] $total chars across ${#files[@]} always-loaded files (limit $TOTAL_MAX, ~$((total / 4)) est. tokens per session)."
fi
exit "$status"
