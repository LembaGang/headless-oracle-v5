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
#
# RULING 3A (B-484, ruled 2026-11-15), and the AUTHORITY FLOOR. From a named
# commit onward, main is protected on GitHub (pull request, code-owner review by
# the founder) and the reviewed pull request is the authority for what lands.
# GitHub's own merge and squash commits are PGP-signed with GitHub's web-flow
# key, and Claude Code's machine account signs with its own SSH key, so for a
# commit that strictly descends from AUTHORITY_FLOOR this script accepts, and
# accepts only:
#
#   * an SSH signature that verifies against SIGNING_KEYS or SIGNING_KEYS_REVIEWED
#     (the second file lists keys valid only after the authority floor; each of
#     its lines must be exactly "<one email address> <key type> <key>", with no
#     wildcard, no list, no options and no address that SIGNING_KEYS already
#     lists, or the script refuses to run); or
#   * a PGP signature, on a commit whose committer email is noreply@github.com,
#     that gpg verifies against tools/github-web-flow.asc AND whose signing key
#     fingerprint is WEBFLOW_FPR below.
#
# Before it judges any commit with the rule on, the script proves that its PGP
# verifier works on this machine: the keyring built from tools/github-web-flow.asc
# holds exactly the two expected keys (fingerprints compared in full); the
# fixture tools/github-web-flow-fixture.commit hashes to GitHub's own commit
# 82cec16 and its signature verifies; and a tampered copy of the same data is
# refused as a bad signature. If any of that fails it prints "VERIFIER NOT
# WORKING on this machine", judges nothing and exits 3, so "could not check" is
# never reported as "refused". `--check-verifier` runs only this self-check.
# Its temporary files live under $TMPDIR (mktemp -d), so a caller can keep them
# in its own scratch folder by setting TMPDIR.
#
# Every other commit, and every commit at or before AUTHORITY_FLOOR (or not
# descended from it), is checked exactly as before: SSH, SIGNING_KEYS only. An
# unsigned commit fails on both sides of the floor; so does a bad signature.
#
# AUTHORITY_FLOOR is EMPTY until main is protected. While it is empty the rule
# is off and this script behaves, byte for byte in its output, as it did before
# ruling 3A. Setting it is a reviewed change made after protection is on,
# because GitHub also signs commits that a GitHub App creates through the API,
# and those are not reviewed merges.

set -eu

cd "$(dirname "$0")/.."

KEYS="SIGNING_KEYS"

# The last commit this mechanism cannot check -- the newest GitHub web-flow PGP
# merge commit. The default range is exclusive of it, so it starts at the first
# commit (6faeefc, 2026-06-24) from which every commit is SSH-signed by a key in
# SIGNING_KEYS. Moving this backwards is only correct if the commits it newly
# covers actually verify -- run the script to find out, do not assume.
FLOOR="82cec16"

# Ruling 3A. Empty means the rule is off (see the header). When set, it is a
# full 40-hex commit on main that descends from FLOOR.
AUTHORITY_FLOOR=""
REVIEWED_KEYS="SIGNING_KEYS_REVIEWED"
WEBFLOW_KEYS="tools/github-web-flow.asc"
# GitHub <noreply@github.com>, key id B5690EEEBB952194, created 2024-01-16, the
# key that signed every web-flow commit in this history. The older key in the
# same file, 4AEE18F83AFDEB23, expired on 2024-01-16 and is not accepted.
WEBFLOW_FPR="968479A1AFF927E37D1A566BB5690EEEBB952194"
# The keyring must hold exactly these primary keys: the two in GitHub's file.
WEBFLOW_FPRS_EXPECTED="5DE3E0509C47EA3CF04A42D34AEE18F83AFDEB23 968479A1AFF927E37D1A566BB5690EEEBB952194"
# GitHub's web-flow merge of pull request 31, verbatim as `git cat-file commit`
# prints it; signed by WEBFLOW_FPR. The self-check needs no repository history.
FIXTURE="tools/github-web-flow-fixture.commit"
FIXTURE_ID="82cec1685d0540a63bb28579bf25ca255d0b836f"

RANGE=""
FULL=0
CHECK_ONLY=0

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
    --check-verifier)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      sed -n '2,79p' "$0" | sed 's/^# \{0,1\}//'
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

# The PGP verifier (ruling 3A). Everything it writes is under $TMP/gnupg and
# $TMP; it never uses ~/.gnupg, never imports into a keybox and never needs
# gpg-agent: the key file is dearmored into a plain keyring that gpg reads
# with --no-default-keyring --keyring.
GH="$TMP/gnupg"
gpg_base() {
  gpg --batch --no-tty --homedir "$GH" --no-permission-warning --no-autostart "$@" < /dev/null
}
gpg_verify() { # gpg_verify <sig> <payload> <status file>
  gpg_base --no-default-keyring --keyring "$GH/webflow.gpg" --trust-model always \
    --status-fd 1 --verify "$1" "$2" > "$3" 2>&1
}
# Byte-exact split of a PGP-signed commit object: the payload is the object
# with the gpgsig header removed (inside the header only, up to the first
# empty line; GNU sed keeps a missing final newline missing).
pgp_split() { # pgp_split <object file> <payload out> <signature out>
  sed '1,/^$/{/^gpgsig /,/^[^ ]/{/^gpgsig /d;/^ /d}}' "$1" > "$2"
  sed -n '1,/^$/{/^gpgsig /,/^[^ ]/{s/^gpgsig //p;s/^ //p}}' "$1" > "$3"
}
verifier_fail() {
  echo "verify-history: VERIFIER NOT WORKING on this machine: $1. No commit was judged." >&2
  exit 3
}
verifier_ready() {
  command -v gpg > /dev/null 2>&1 || verifier_fail "gpg is not on PATH"
  [ -f "$WEBFLOW_KEYS" ] || verifier_fail "$WEBFLOW_KEYS not found"
  [ -f "$FIXTURE" ] || verifier_fail "$FIXTURE not found"
  mkdir "$GH" 2> "$TMP/mkdir.err" || verifier_fail "cannot create $GH: $(cat "$TMP/mkdir.err")"
  if ! chmod 700 "$GH" 2> "$TMP/chmod.err"; then
    echo "verify-history: note: chmod 700 on $GH failed ($(cat "$TMP/chmod.err")); gpg runs with --no-permission-warning and the self-check below decides" >&2
  fi
  gpg_base --dearmor --output "$GH/webflow.gpg" "$WEBFLOW_KEYS" > "$TMP/dearmor.log" 2>&1 ||
    verifier_fail "gpg --dearmor of $WEBFLOW_KEYS failed: $(tr '\n' ' ' < "$TMP/dearmor.log")"
  [ -s "$GH/webflow.gpg" ] || verifier_fail "gpg --dearmor wrote an empty keyring"
  gpg_base --no-default-keyring --keyring "$GH/webflow.gpg" --with-colons --list-keys > "$TMP/keys.txt" 2> "$TMP/keys.err" ||
    verifier_fail "gpg cannot list the keyring: $(cat "$TMP/keys.err" "$TMP/keys.txt" | tr '\n' ' ')"
  got=$(awk -F: '/^pub:/ { p = 1; next } p && /^fpr:/ { print $10; p = 0 }' "$TMP/keys.txt" | sort | tr '\n' ' ')
  want=$(printf '%s\n' $WEBFLOW_FPRS_EXPECTED | sort | tr '\n' ' ')
  [ "$got" = "$want" ] || verifier_fail "the keyring holds [$got], expected exactly [$want]"
  fid=$(git hash-object -t commit --stdin < "$FIXTURE")
  [ "$fid" = "$FIXTURE_ID" ] || verifier_fail "$FIXTURE is not GitHub's commit $FIXTURE_ID (it hashes to $fid)"
  pgp_split "$FIXTURE" "$TMP/fx.payload" "$TMP/fx.sig"
  if gpg_verify "$TMP/fx.sig" "$TMP/fx.payload" "$TMP/fx.status"; then rc=0; else rc=$?; fi
  if [ "$rc" != 0 ] || ! grep -q '^\[GNUPG:\] GOODSIG B5690EEEBB952194 ' "$TMP/fx.status" ||
     ! grep -q "^\[GNUPG:\] VALIDSIG $WEBFLOW_FPR " "$TMP/fx.status"; then
    verifier_fail "GitHub's own signature on the fixture $FIXTURE_ID does not verify here (gpg exit $rc: $(grep '^\[GNUPG:\]' "$TMP/fx.status" | tr '\n' ' '))"
  fi
  sed 's/^Merge pull request #31 /Merge pull request #32 /' "$TMP/fx.payload" > "$TMP/fx.tampered"
  if cmp -s "$TMP/fx.payload" "$TMP/fx.tampered"; then verifier_fail "the tampered copy of the fixture could not be made"; fi
  if gpg_verify "$TMP/fx.sig" "$TMP/fx.tampered" "$TMP/fx.tstatus"; then
    verifier_fail "a tampered copy of the fixture verified"
  fi
  grep -q '^\[GNUPG:\] BADSIG B5690EEEBB952194 ' "$TMP/fx.tstatus" ||
    verifier_fail "the tampered copy was refused, but not as a bad signature ($(grep '^\[GNUPG:\]' "$TMP/fx.tstatus" | tr '\n' ' '))"
}

if [ "$CHECK_ONLY" = "1" ]; then
  verifier_ready
  echo "verify-history: web-flow verifier self-check passed (fixture $FIXTURE_ID, key $WEBFLOW_FPR)"
  exit 0
fi

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

AUTH_FULL=""
if [ -n "$AUTHORITY_FLOOR" ]; then
  if ! AUTH_FULL=$(git rev-parse --verify -q "$AUTHORITY_FLOOR^{commit}"); then
    echo "verify-history: AUTHORITY_FLOOR $AUTHORITY_FLOOR is not a commit in this clone" >&2
    exit 2
  fi
  if ! git merge-base --is-ancestor "$FLOOR" "$AUTH_FULL"; then
    echo "verify-history: AUTHORITY_FLOOR $AUTH_FULL does not descend from $FLOOR" >&2
    exit 2
  fi
  # The keys accepted after the authority floor: SIGNING_KEYS plus the reviewed
  # file. A reviewed line must name one exact address: ssh-keygen treats the
  # principal field as a comma-separated list of patterns, so "*" or "a,b"
  # would let a reviewed key sign under the founder's address.
  cat "$KEYS" > "$TMP/keys_3a"
  if [ -f "$REVIEWED_KEYS" ]; then
    if ! awk -v keys="$KEYS" '
      BEGIN {
        while ((getline l < keys) > 0) {
          if (l ~ /^[ \t]*(#|$)/) continue
          split(l, f, /[ \t]+/); founder[f[1]] = 1
        }
      }
      /^[ \t]*(#|$)/ { next }
      {
        bad = ""
        if (NF != 3) bad = "must be exactly: <email> <key type> <key>"
        else if ($1 !~ /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/) bad = "the principal must be one exact email address (no * ? ! or comma)"
        else if ($1 in founder) bad = "the principal is already in SIGNING_KEYS"
        else if ($2 !~ /^(ssh-|ecdsa-|sk-)/) bad = "the second field must be a key type"
        if (bad != "") { printf "verify-history: SIGNING_KEYS_REVIEWED line %d refused: %s\n", NR, bad > "/dev/stderr"; err = 1 }
      }
      END { exit err }
    ' "$REVIEWED_KEYS"; then
      exit 2
    fi
    cat "$REVIEWED_KEYS" >> "$TMP/keys_3a"
  fi
  verifier_ready
  echo "verify-history: web-flow verifier self-check passed (fixture $FIXTURE_ID, key $WEBFLOW_FPR)"
  echo "verify-history: ruling 3A is ON: commits after $AUTH_FULL may also be signed by a key in $REVIEWED_KEYS or by GitHub's web-flow key $WEBFLOW_FPR"
fi

# True when $1 strictly descends from the authority floor (the rule is on).
after_authority_floor() {
  [ -n "$AUTH_FULL" ] || return 1
  [ "$1" != "$AUTH_FULL" ] || return 1
  git merge-base --is-ancestor "$AUTH_FULL" "$1"
}

# Verify a GitHub web-flow PGP signature on commit $1 with the keyring the
# self-check built. Succeeds only on gpg exit 0, GOODSIG, and VALIDSIG naming
# WEBFLOW_FPR; gpg's status lines are kept in $TMP/gpgstatus for the report.
verify_webflow() {
  git cat-file commit "$1" > "$TMP/wf.obj"
  pgp_split "$TMP/wf.obj" "$TMP/wf.payload" "$TMP/wf.sig"
  gpg_verify "$TMP/wf.sig" "$TMP/wf.payload" "$TMP/gpgstatus" || return 1
  grep -q '^\[GNUPG:\] GOODSIG ' "$TMP/gpgstatus" || return 1
  grep -q "^\[GNUPG:\] VALIDSIG $WEBFLOW_FPR " "$TMP/gpgstatus" || return 1
  return 0
}

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

  CHECK_KEYS="$KEYS"
  CHECK_LABEL="$KEYS"
  if after_authority_floor "$SHA"; then
    CHECK_KEYS="$TMP/keys_3a"
    CHECK_LABEL="$KEYS + $REVIEWED_KEYS"
    if [ -s "$TMP/sig" ] && head -n 1 "$TMP/sig" | grep -q 'BEGIN PGP SIGNATURE'; then
      if [ "$SIGNER" != "noreply@github.com" ]; then
        echo "NOT-WEBFLOW $SHA  $SIGNER  $SUBJECT"
        echo "verify-history: FAILED -- $SHA is PGP-signed but its committer is not noreply@github.com" >&2
        exit 1
      fi
      if verify_webflow "$SHA"; then
        echo "Good-WF   $SHA  $SIGNER  $SUBJECT"
        continue
      fi
      echo "BAD-WF    $SHA  $SIGNER  $SUBJECT"
      cat "$TMP/gpgstatus" >&2
      echo "verify-history: FAILED -- $SHA did not verify against GitHub's web-flow key $WEBFLOW_FPR" >&2
      exit 1
    fi
  fi

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

  if OUT=$(ssh-keygen -Y verify -f "$CHECK_KEYS" -I "$SIGNER" -n git -s "$TMP/sig" < "$TMP/payload" 2>&1); then
    echo "Good      $SHA  $SIGNER  $SUBJECT"
  else
    echo "BAD       $SHA  $SIGNER  $SUBJECT"
    echo "$OUT" >&2
    if [ "$CHECK_KEYS" != "$KEYS" ]; then
      # Judged under ruling 3A: say why, so a refusal is never ambiguous.
      if P=$(ssh-keygen -Y find-principals -s "$TMP/sig" -f "$CHECK_KEYS" 2> "$TMP/fp.err"); then
        case " $(echo $P) " in
          *" $SIGNER "*) echo "verify-history: REASON bad-signature: the key is listed for $SIGNER but the signature does not verify" >&2 ;;
          *) echo "verify-history: REASON principal-mismatch: the key is listed for $(echo $P), the committer is $SIGNER" >&2 ;;
        esac
      elif grep -q 'key has expired' "$TMP/fp.err"; then
        echo "verify-history: REASON key-expired: the signing key is listed but past its valid-before date ($(cat "$TMP/fp.err"))" >&2
      else
        echo "verify-history: REASON key-not-listed: the signing key is in neither $KEYS nor $REVIEWED_KEYS ($P $(cat "$TMP/fp.err"))" >&2
      fi
    fi
    echo "verify-history: FAILED -- $SHA did not verify against $CHECK_LABEL" >&2
    exit 1
  fi
done

if [ -n "$AUTH_FULL" ]; then
  echo "verify-history: $TOTAL/$TOTAL commits verified against $KEYS, and after $AUTH_FULL also $REVIEWED_KEYS and $WEBFLOW_KEYS"
else
  echo "verify-history: $TOTAL/$TOTAL commits verified against $KEYS"
fi
exit 0
