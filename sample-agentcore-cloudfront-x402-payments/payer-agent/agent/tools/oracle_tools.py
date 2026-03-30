"""
Oracle market-state tools for pre-payment verification.

Wraps Headless Oracle (headlessoracle.com) as Strands @tool functions so the
agent can verify market state before executing x402 payments.

These tools implement the fail-closed pattern: if the oracle cannot be reached
or returns UNKNOWN/HALTED, the agent must NOT proceed with the payment.
"""

import time
from typing import Any

import httpx
from strands import tool

from ..config import config
from headless_oracle_strands.attestation import (
    attestation_ref_from_receipt,
    is_market_open,
    validate_ttl,
    should_refetch,
)


def _extract_receipt(response_json: dict) -> dict:
    """
    Extract the inner receipt from a discovery_url-wrapped response.

    Headless Oracle wraps receipts: { receipt: {...}, discovery_url: "..." }
    Fall back to treating the whole response as a receipt if no wrapper.
    """
    if "receipt" in response_json and "discovery_url" in response_json:
        return response_json["receipt"]
    return response_json


@tool
def check_market_status(mic: str = "") -> dict[str, Any]:
    """
    Verify market state using Headless Oracle before executing financial transactions.

    MUST be called before purchasing any market-related content or making
    financial decisions. Returns a cryptographically signed attestation.

    Fail-closed: if the oracle is unreachable or returns UNKNOWN/HALTED,
    treat the market as CLOSED and do NOT proceed.

    Args:
        mic: ISO 10383 Market Identifier Code (e.g., XNYS, XNAS, XLON).
             Defaults to configured ORACLE_MIC (typically XNYS).

    Returns:
        {
          "is_open": bool,       # False for CLOSED, HALTED, UNKNOWN, or error
          "status": str,         # OPEN | CLOSED | HALTED | UNKNOWN | ERROR
          "mic": str,
          "expires_at": str,     # ISO8601 — check this before acting
          "ttl_valid": bool,     # False if receipt has expired
          "should_refetch": bool,# True if within 5s of expiry — re-fetch before paying
          "receipt": dict,       # Full signed receipt for audit trail
          "error": str | None,   # Set if oracle call failed
        }
    """
    effective_mic = mic if mic else config.oracle_mic

    # Use /v5/status (live, receipt_mode=live) when an API key is configured;
    # fall back to /v5/demo (public, receipt_mode=demo) otherwise.
    if config.oracle_api_key:
        oracle_url = f"{config.oracle_api_url}/v5/status?mic={effective_mic}"
        headers = {"X-Oracle-Key": config.oracle_api_key}
    else:
        oracle_url = f"{config.oracle_api_url}/v5/demo?mic={effective_mic}"
        headers = {}

    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(oracle_url, headers=headers)

        if response.status_code != 200:
            return {
                "is_open": False,
                "status": "ERROR",
                "mic": effective_mic,
                "expires_at": None,
                "ttl_valid": False,
                "should_refetch": False,
                "receipt": None,
                "error": f"Oracle returned HTTP {response.status_code}. Fail-closed: treating as CLOSED.",
            }

        response_json = response.json()
        receipt = _extract_receipt(response_json)

        # Build attestation_ref to validate structure
        # Use a placeholder tx_id since this is a pre-check, not a payment event
        tx_id = f"pre-check-{effective_mic}-{int(time.time())}"
        ref = attestation_ref_from_receipt(receipt, tx_id)

        ttl_valid = validate_ttl(ref)
        needs_refetch = should_refetch(ref)
        market_open = is_market_open(ref) and ttl_valid

        return {
            "is_open": market_open,
            "status": receipt.get("status", "UNKNOWN"),
            "mic": effective_mic,
            "expires_at": receipt.get("expires_at"),
            "ttl_valid": ttl_valid,
            "should_refetch": needs_refetch,
            "receipt": receipt,
            "error": None,
        }

    except httpx.TimeoutException:
        return {
            "is_open": False,
            "status": "ERROR",
            "mic": effective_mic,
            "expires_at": None,
            "ttl_valid": False,
            "should_refetch": False,
            "receipt": None,
            "error": "Oracle request timed out (10s). Fail-closed: treating as CLOSED.",
        }
    except Exception as e:
        return {
            "is_open": False,
            "status": "ERROR",
            "mic": effective_mic,
            "expires_at": None,
            "ttl_valid": False,
            "should_refetch": False,
            "receipt": None,
            "error": f"Oracle check failed: {str(e)}. Fail-closed: treating as CLOSED.",
        }


@tool
def build_payment_attestation(mic: str, x402_transaction_id: str, receipt: dict) -> dict[str, Any]:
    """
    Build an attestation_ref for embedding in a payment_receipt event.

    Call this AFTER check_market_status confirms is_open=True and BEFORE
    signing the payment. Binds the oracle receipt to this specific transaction
    via a composite hash (sha256(signature + transaction_id)).

    Args:
        mic: The exchange MIC that was checked (e.g., XNYS).
        x402_transaction_id: The x402 transaction ID. Used as correlation ID
            to bind the oracle receipt to this specific payment flow.
        receipt: The full signed receipt dict from check_market_status.

    Returns:
        {
          "attestation_ref": dict,   # Embed this in payment_receipt
          "valid": bool,             # False if receipt expired or invalid
          "error": str | None,
        }
    """
    if not receipt:
        return {
            "attestation_ref": None,
            "valid": False,
            "error": "No receipt provided. Call check_market_status first.",
        }

    try:
        ref = attestation_ref_from_receipt(receipt, x402_transaction_id)

        # Final TTL check — the market window may have shifted since check_market_status
        if not validate_ttl(ref):
            return {
                "attestation_ref": None,
                "valid": False,
                "error": "Oracle receipt expired before payment could be signed. Re-check market status.",
            }

        return {
            "attestation_ref": ref.to_dict(),
            "valid": True,
            "error": None,
        }

    except Exception as e:
        return {
            "attestation_ref": None,
            "valid": False,
            "error": f"Failed to build attestation: {str(e)}",
        }
