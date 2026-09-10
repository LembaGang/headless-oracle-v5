#!/bin/sh
# Verify that every commit in a range carries a good SSH signature from a key in
# SIGNING_KEYS.
#
# Why this exists: this repository holds the billing path -- what the worker
# charges, which Paddle price id it charges it against, and which webhook
# provisions what. A reviewer must be able to establish that the commits which
# built that path are the founder's, from the repository alone.
#
# It calls `ssh-keygen -Y verify` directly rather than `git verify-commit`, so it
# does not depend on the checker having `gpg.ssh.allowedSignersFile` configured
# -- a fresh clone and a CI runner have not.
#
# THE FLOOR, and why there is one. This repository's history is not uniformly
# signed and this script does not pretend otherwise:
#
#   * 188 commits before 2026-04-02 carry no signature at all. Commit signing
#     was turned on partway through the project's life.
#   * 13 commits between 2026-04-17 and 2026-06-17 are GitHub web-UI merge
#     commits, PGP-signed by GitHub's own web-flow key (committer
#     `GitHub <noreply@github.com>`). They are signatures, but not SSH ones and
#     not the founder's, so `ssh-keygen -Y verify` cannot check them.
#   * Every commit from 6faeefc (2026-06-24) onward -- the first commit after
#     the last of those merges -- is SSH-signed by the single key in
#     SIGNING_KEYS.
#
# So the default range starts at that floor, where "every commit verifies" is a
# claim the bytes actually support. Everything before it is out of scope and is
# reported as such with its count -- never silently dropped. `--full` walks the
# entire history, prints the census, and exits non-zero, so the true state of
# the whole branch is one command away and cannot be mistaken for green.
#
# Usage:
#   sh tools/verify-history.sh                 # the floor to HEAD (the default)
#   sh tools/verify-history.sh --range A..B    # a range, as git rev-list takes it
#   sh tools/verify-history.sh --full          # the whole history; census, exits 1
#
# Exit 0 when every commit in the range verifies. Exit 1 on the first commit that
# does not, including any commit carrying no SSH signature at all: an unsigned
# commit is a failure, never a skip.

set -eu

cd "$(dirname "$0")/.."

KEYS="SIGNING_KEYS"

# The last commit this mechanism cannot check -- the newest GitHub web-flow PGP
# merge commit. The default range is exclusive of it, so it starts at the first
# commit (6faeefc, 2026-06-24) from which every commit is SSH-signed by a key in
# SIGNING_KEYS. Moving this backwards is only correct if the commits it newly
# covers actually verify -- run the script to find out, do not assume.
FLOOR="82cec16"

RANGE=""
FULL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --range)
      if [ $# -lt 2 ]; then
        echo "verify-history: --range needs an argument" >&2
        exit 2
      fi
      RANGE="$2"
      shift 2
      ;;
    --full)
      FULL=1
      shift
      ;;
    -h|--help)
      sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "verify-history: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$KEYS" ]; then
  echo "verify-history: $KEYS not found; cannot verify anything" >&2
  exit 2
fi

if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "verify-history: ssh-keygen not on PATH" >&2
  exit 2
fi

TMP=$(mktemp -d)
# Clean up the signature and payload files whatever happens: they are extracts of
# commit objects, but there is no reason to leave them lying in the temp dir.
trap 'rm -rf "$TMP"' EXIT INT TERM

# Split a commit object into the signed payload and the signature block. The
# signature sits in a `gpgsig` header whose continuation lines are indented by
# one space; the payload is the object with that header removed entirely. This
# is the same for an SSHSIG and a PGP signature -- what differs is the armour,
# which is why the caller checks it.
split_commit() {
  git cat-file commit "$1" | awk -v sig="$TMP/sig" '
    /^gpgsig / { insig = 1; sub(/^gpgsig /, ""); print > sig; next }
    insig && /^ /  { sub(/^ /, ""); print >> sig; next }
    { insig = 0; print }
  ' > "$TMP/payload"
}

if [ "$FULL" = "1" ]; then
  # The census. Deliberately exits 1: the whole branch does not verify, and a
  # command that reported that as success would be worse than no command.
  echo "verify-history: FULL CENSUS of the whole history, against $KEYS"
  GOOD=0; BADC=0; UNSIGNED=0; NONSSH=0; TOTAL=0
  for SHA in $(git rev-list --reverse HEAD); do
    TOTAL=$((TOTAL + 1))
    SIGNER=$(git show -s --format='%ce' "$SHA")
    rm -f "$TMP/sig" "$TMP/payload"
    split_commit "$SHA"
    if [ ! -s "$TMP/sig" ]; then
      UNSIGNED=$((UNSIGNED + 1))
      continue
    fi
    if ! head -n 1 "$TMP/sig" | grep -q 'BEGIN SSH SIGNATURE'; then
      NONSSH=$((NONSSH + 1))
      continue
    fi
    if ssh-keygen -Y verify -f "$KEYS" -I "$SIGNER" -n git -s "$TMP/sig" < "$TMP/payload" >/dev/null 2>&1; then
      GOOD=$((GOOD + 1))
    else
      BADC=$((BADC + 1))
    fi
  done
  echo "  total commits          $TOTAL"
  echo "  SSH-signed, verified   $GOOD"
  echo "  SSH-signed, BAD        $BADC"
  echo "  signed, not SSH        $NONSSH   (GitHub web-flow PGP merge commits)"
  echo "  no signature at all    $UNSIGNED"
  echo "verify-history: the full history does NOT verify against $KEYS; the verifiable range starts after $FLOOR. Exiting 1 on purpose."
  exit 1
fi

if [ -z "$RANGE" ]; then
  RANGE="$FLOOR..HEAD"
  PRECEDING=$(git rev-list --count "$FLOOR")
  echo "verify-history: default range is the signed floor, $RANGE"
  echo "verify-history: $PRECEDING commits up to and including $FLOOR are OUT OF SCOPE -- see the header of this script for why. Run --full for the census."
fi

COMMITS=$(git rev-list --reverse "$RANGE")

if [ -z "$COMMITS" ]; then
  echo "verify-history: no commits in $RANGE"
  exit 0
fi

TOTAL=0
echo "verify-history: $RANGE, against $KEYS"

for SHA in $COMMITS; do
  TOTAL=$((TOTAL + 1))
  SUBJECT=$(git show -s --format='%s' "$SHA")
  SIGNER=$(git show -s --format='%ce' "$SHA")

  rm -f "$TMP/sig" "$TMP/payload"
  split_commit "$SHA"

  if [ ! -s "$TMP/sig" ]; then
    echo "UNSIGNED  $SHA  $SUBJECT"
    echo "verify-history: FAILED -- $SHA carries no signature" >&2
    exit 1
  fi

  if ! head -n 1 "$TMP/sig" | grep -q 'BEGIN SSH SIGNATURE'; then
    echo "NOT-SSH   $SHA  $SIGNER  $SUBJECT"
    echo "verify-history: FAILED -- $SHA is signed, but not with SSH; $KEYS cannot check it" >&2
    exit 1
  fi

  if OUT=$(ssh-keygen -Y verify -f "$KEYS" -I "$SIGNER" -n git -s "$TMP/sig" < "$TMP/payload" 2>&1); then
    echo "Good      $SHA  $SIGNER  $SUBJECT"
  else
    echo "BAD       $SHA  $SIGNER  $SUBJECT"
    echo "$OUT" >&2
    echo "verify-history: FAILED -- $SHA did not verify against $KEYS" >&2
    exit 1
  fi
done

echo "verify-history: $TOTAL/$TOTAL commits verified against $KEYS"
exit 0
