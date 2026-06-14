// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
//  HaltGuard — reference receipt-or-revert gate for Headless Oracle market state
// =============================================================================
//
//  THIS IS REFERENCE CODE, NOT AUDITED PRODUCTION.
//  Read the trust-model section below before integrating.
//
//  Purpose. Demonstrate the canonical "receipt-or-revert" pattern for on-chain
//  consumers of Headless Oracle's signed market-state attestations. A caller
//  whose action is conditional on a venue being OPEN passes the most recent
//  signed receipt through `checkSafe()`; the function reverts unless every
//  policy check clears.
//
//  Gate checks, in order:
//    1. Ed25519 signature over the canonical receipt bytes against the HO
//       public key configured at deploy time. Mismatch → InvalidSignature.
//    2. The signed bytes literally contain the caller-supplied `issuedAtIso`,
//       binding the freshness claim to the signed artifact (so the caller can
//       not lie about issued_at to bypass step 3).
//    3. block.timestamp - parseIso(issuedAtIso) <= maxAttestationAge.
//       Older receipts → ReceiptStale.
//    4. The signed bytes literally contain `"mic":"<expectedMic>"`. Other MIC
//       → WrongMic.
//    5. The signed bytes literally contain `"status":"OPEN"`. Other status
//       → NotOpen. CLOSED, HALTED, and UNKNOWN all fail-closed; agents must
//       treat UNKNOWN as a do-not-trade signal (the HO public contract).
//
// -----------------------------------------------------------------------------
//  Trust model — read this before integrating.
// -----------------------------------------------------------------------------
//
//  *  Claim ceiling. Headless Oracle attests the venue's SESSION-STATE as
//     OBSERVED by HO at signed-time T. The receipt is not ground truth and
//     does not encode liveness beyond T. A receipt with status OPEN at
//     issued_at = T does not promise the market is open at action-time T+Δ.
//     Freshness is enforced by THIS contract via `maxAttestationAge`, not by
//     HO. The receipt's own `expires_at` (60s TTL) is HO's stated upper bound;
//     this contract should be configured with a tighter `maxAttestationAge`.
//
//  *  Single trust root. The trust assumption is exactly one thing: that
//     the holder of the secret key matching `haltOraclePublicKey` is HO and
//     only HO. No part of the receipt body is trusted beyond that signature.
//     A response claiming a different public_key_id MUST be rejected upstream
//     (the SDK does this; agents that hand-roll verification must do the same).
//
//  *  No replay protection in this contract. A relying caller can replay a
//     receipt within the `maxAttestationAge` window. If your business logic
//     requires single-use receipts (per-order, per-decision), track receipt
//     IDs in your caller and require an unseen `receipt_id` before invoking
//     `checkSafe()`. The signed bytes contain `"receipt_id":"<uuid>"`; extract
//     it via the same substring pattern this contract uses, or via the
//     `extractField()` helper.
//
//  *  Ed25519 on EVM is non-trivial. This contract abstracts the verifier
//     via `IEd25519Verifier`. Plug in:
//      - a chain-native precompile (Solana, Aptos, Sui, some rollups)
//      - a Solidity library where no precompile exists (e.g. chronicle's
//        `Ed25519` library, or @noble-curves Solidity ports)
//      - a sequencer-attested off-chain verifier for the gas-conscious
//     No verifier is bundled here on purpose — the choice is chain-dependent.
//
//  *  ISO 8601 parsing is brittle. `_parseIsoToUnix()` assumes HO emits the
//     format `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC, millisecond precision). If HO
//     ever changes the format (microseconds, no millisecond fraction, an
//     offset suffix), this parser will silently misread or revert. A
//     production deployment should EITHER pin the HO server version that
//     guarantees this format, OR petition HO to publish a signed
//     `issued_at_unix` field in the canonical payload and switch to it.
//
//  *  Phase-C compatibility. A future top-level `archive_anchor` field on the
//     HO receipt (binding each live receipt to a daily merkle root) will be a
//     non-breaking addition — the signed canonical sort just absorbs the new
//     field alphabetically. This contract will need no changes to keep
//     verifying; consumers wanting to bind on-chain to a particular archive
//     epoch can add a substring check for `archive_anchor` analogous to the
//     MIC check below.
//
// =============================================================================

interface IEd25519Verifier {
    /// @notice Verify that `signature` is a valid Ed25519 signature over
    ///         `message` produced by the secret key matching `publicKey`.
    /// @return ok True iff the signature is valid.
    function verify(
        bytes calldata message,
        bytes calldata signature,
        bytes32 publicKey
    ) external view returns (bool ok);
}

contract HaltGuard {
    // ── Configuration (immutable after deploy) ───────────────────────────────

    /// Ed25519 public key of the trusted HO signer (32 bytes).
    bytes32 public immutable haltOraclePublicKey;

    /// Plugged-in Ed25519 verifier — chain-dependent (precompile or library).
    IEd25519Verifier public immutable verifier;

    /// Maximum permitted age (in seconds) of receipt.issued_at relative to
    /// block.timestamp. Matches the IETF environment.* family's
    /// `max_attestation_age` constraint. Tighter is safer; HO's own TTL is
    /// 60 seconds, so a sensible default for high-stakes actions is 10–30 s.
    uint256 public immutable maxAttestationAge;

    /// Expected MIC (ASCII bytes, e.g. "XNYS"). Configured per gate instance.
    /// Stored as bytes (not string) so we can use it in `keccak256` and
    /// substring matches without re-encoding on every call.
    bytes public expectedMic;

    // ── Reverts ──────────────────────────────────────────────────────────────

    error InvalidSignature();
    error ReceiptStale(uint256 issuedAtUnix, uint256 blockTime, uint256 maxAge);
    error WrongMic(bytes expected);
    error NotOpen();
    error MalformedReceipt(string reason);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(
        bytes32 haltOraclePublicKey_,
        IEd25519Verifier verifier_,
        uint256 maxAttestationAge_,
        bytes memory expectedMic_
    ) {
        if (haltOraclePublicKey_ == bytes32(0)) revert MalformedReceipt("publicKey=0");
        if (address(verifier_) == address(0))   revert MalformedReceipt("verifier=0");
        if (maxAttestationAge_ == 0)            revert MalformedReceipt("maxAge=0");
        if (expectedMic_.length == 0)           revert MalformedReceipt("mic=empty");

        haltOraclePublicKey = haltOraclePublicKey_;
        verifier            = verifier_;
        maxAttestationAge   = maxAttestationAge_;
        expectedMic         = expectedMic_;
    }

    // ── Public gate — call this before any state-changing action ─────────────

    /// @notice Receipt-or-revert gate. Returns silently iff the receipt clears
    ///         every policy check. Reverts with a typed error otherwise. The
    ///         caller's transaction proceeds on silent return; reverting here
    ///         reverts the whole call.
    ///
    /// @param canonicalReceiptBytes The exact byte sequence HO signed: the
    ///        alphabetical-sorted, no-whitespace JSON form of the canonical
    ///        receipt payload (omitting the signature itself). The caller
    ///        builds this off-chain. This contract verifies the signature
    ///        against these bytes — it does NOT trust the caller's parse.
    ///
    /// @param signature The 64-byte Ed25519 signature returned in the receipt
    ///        body (lowercase hex decoded to bytes).
    ///
    /// @param issuedAtIso receipt.issued_at as a string, e.g.
    ///        "2026-06-14T12:34:56.789Z". This contract checks the string is
    ///        present in canonicalReceiptBytes (binding the freshness claim
    ///        to the signed artifact), then parses it on-chain to enforce
    ///        the freshness window.
    function checkSafe(
        bytes calldata canonicalReceiptBytes,
        bytes calldata signature,
        string calldata issuedAtIso
    ) external view {
        // ── 1. Cryptographic signature check ─────────────────────────────────
        if (!verifier.verify(canonicalReceiptBytes, signature, haltOraclePublicKey)) {
            revert InvalidSignature();
        }

        // ── 2. Bind issuedAtIso to the signed bytes ──────────────────────────
        //     We require `"issued_at":"<iso>"` to appear literally in the
        //     signed canonical form. Without this binding the caller could
        //     supply an arbitrary `issuedAtIso` and bypass the freshness gate.
        bytes memory issuedAtNeedle = abi.encodePacked('"issued_at":"', bytes(issuedAtIso), '"');
        if (!_contains(canonicalReceiptBytes, issuedAtNeedle)) {
            revert MalformedReceipt("issued_at not in signed bytes");
        }

        // ── 3. Freshness — parse the ISO and compare to block.timestamp ──────
        uint256 issuedAtUnix = _parseIsoToUnix(issuedAtIso);
        if (block.timestamp > issuedAtUnix + maxAttestationAge) {
            revert ReceiptStale(issuedAtUnix, block.timestamp, maxAttestationAge);
        }

        // ── 4. MIC match — bound to the signed bytes ─────────────────────────
        bytes memory micNeedle = abi.encodePacked('"mic":"', expectedMic, '"');
        if (!_contains(canonicalReceiptBytes, micNeedle)) {
            revert WrongMic(expectedMic);
        }

        // ── 5. Status must be OPEN — bound to the signed bytes ──────────────
        //     CLOSED / HALTED / UNKNOWN all fail. UNKNOWN as CLOSED is the
        //     HO public contract; this gate enforces it.
        bytes memory openNeedle = bytes('"status":"OPEN"');
        if (!_contains(canonicalReceiptBytes, openNeedle)) {
            revert NotOpen();
        }
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// @notice Substring search. Returns true iff `needle` appears in `haystack`.
    ///         Naive O(n*m). Acceptable for receipt bytes (~300 bytes) and
    ///         needles (~25 bytes). A production gas-conscious deployment may
    ///         prefer keccak256-precommitted scanning or a verifier-side
    ///         attestation that returns parsed fields directly.
    function _contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        uint256 hl = haystack.length;
        uint256 nl = needle.length;
        if (nl == 0)      return true;
        if (hl < nl)      return false;
        unchecked {
            for (uint256 i = 0; i <= hl - nl; i++) {
                bool matched = true;
                for (uint256 j = 0; j < nl; j++) {
                    if (haystack[i + j] != needle[j]) { matched = false; break; }
                }
                if (matched) return true;
            }
        }
        return false;
    }

    /// @notice Parse the strict format `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC, ms
    ///         precision) into a UNIX timestamp (seconds since 1970-01-01).
    ///         Ignores the millisecond fraction (truncates to whole seconds).
    ///         Reverts MalformedReceipt on unexpected format.
    ///
    ///         This is the brittle bit. See "ISO 8601 parsing is brittle"
    ///         in the trust-model header. The format check is strict by
    ///         position — any deviation reverts rather than silently misreads.
    function _parseIsoToUnix(string calldata iso) internal pure returns (uint256) {
        bytes calldata b = bytes(iso);
        if (b.length < 20) revert MalformedReceipt("issued_at too short");
        // Expected: YYYY-MM-DDTHH:MM:SS[.sss]Z
        // Positions: 0123456789...
        //            0    5  8 10 13 16 19
        if (b[4] != '-' || b[7] != '-' || b[10] != 'T'
            || b[13] != ':' || b[16] != ':' || b[b.length - 1] != 'Z') {
            revert MalformedReceipt("issued_at format");
        }

        uint256 year   = _digits4(b, 0);
        uint256 month  = _digits2(b, 5);
        uint256 day    = _digits2(b, 8);
        uint256 hour   = _digits2(b, 11);
        uint256 minute = _digits2(b, 14);
        uint256 second = _digits2(b, 17);

        // Sanity-bound the fields. Reverts on garbage even if the digit
        // positions look right.
        if (month  < 1 || month  > 12) revert MalformedReceipt("month");
        if (day    < 1 || day    > 31) revert MalformedReceipt("day");
        if (hour          > 23) revert MalformedReceipt("hour");
        if (minute        > 59) revert MalformedReceipt("minute");
        if (second        > 60) revert MalformedReceipt("second"); // 60 for leap seconds
        if (year < 1970)        revert MalformedReceipt("year");

        return _ymdhmsToUnix(year, month, day, hour, minute, second);
    }

    function _digits4(bytes calldata b, uint256 offset) private pure returns (uint256) {
        return _digit(b, offset)     * 1000
             + _digit(b, offset + 1) * 100
             + _digit(b, offset + 2) * 10
             + _digit(b, offset + 3);
    }

    function _digits2(bytes calldata b, uint256 offset) private pure returns (uint256) {
        return _digit(b, offset) * 10 + _digit(b, offset + 1);
    }

    function _digit(bytes calldata b, uint256 offset) private pure returns (uint256) {
        uint8 c = uint8(b[offset]);
        if (c < 0x30 || c > 0x39) revert MalformedReceipt("non-digit in issued_at");
        return c - 0x30;
    }

    /// @notice Convert (Y,M,D,h,m,s) UTC to seconds since 1970-01-01T00:00:00Z.
    ///         Standard civil-from-days algorithm (Howard Hinnant).
    function _ymdhmsToUnix(
        uint256 year,
        uint256 month,
        uint256 day,
        uint256 hour,
        uint256 minute,
        uint256 second
    ) private pure returns (uint256) {
        // Howard Hinnant's "days_from_civil" — see
        // https://howardhinnant.github.io/date_algorithms.html#days_from_civil
        // Returns the count of days since 1970-01-01.
        uint256 y = year;
        if (month <= 2) y -= 1;
        uint256 era    = y / 400;
        uint256 yoe    = y - era * 400;
        uint256 m      = month;
        uint256 doy    = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + day - 1;
        uint256 doe    = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        // Days since 1970-01-01 (the Unix epoch — era anchor 0000-03-01 + 719468).
        // Using a uint256 subtraction guarded by the 1970 lower-bound check above.
        uint256 days_  = era * 146097 + doe - 719468;
        return days_ * 86400 + hour * 3600 + minute * 60 + second;
    }
}
