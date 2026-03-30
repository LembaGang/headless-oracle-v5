"""Tests for oracle market-state tools."""

from unittest.mock import MagicMock, patch
from datetime import datetime, timezone, timedelta

import pytest

from agent.tools.oracle_tools import check_market_status, build_payment_attestation


VALID_SIGNATURE = "a" * 128
TX_ID = "tx-x402-test-123"

# A valid receipt that expires 60s from a past time (far future for test stability)
FUTURE_RECEIPT = {
    "receipt_id": "6b4a2c8f-1234-5678-9abc-def012345678",
    "issued_at": "2026-03-28T14:30:00.000Z",
    "expires_at": "2099-12-31T23:59:59.000Z",  # far future — never expires in tests
    "mic": "XNYS",
    "status": "OPEN",
    "source": "SCHEDULE",
    "signature": VALID_SIGNATURE,
    "public_key_id": "key_2026_v1",
    "issuer": "headlessoracle.com",
}

CLOSED_RECEIPT = {**FUTURE_RECEIPT, "status": "CLOSED"}
HALTED_RECEIPT = {**FUTURE_RECEIPT, "status": "HALTED"}
UNKNOWN_RECEIPT = {**FUTURE_RECEIPT, "status": "UNKNOWN"}

EXPIRED_RECEIPT = {
    **FUTURE_RECEIPT,
    "expires_at": "2020-01-01T00:01:00.000Z",  # expired long ago
}

# Oracle wraps receipts in discovery_url envelope
def wrapped(receipt: dict) -> dict:
    return {"receipt": receipt, "discovery_url": "https://headlessoracle.com/.well-known/mcp/server-card.json"}


class TestCheckMarketStatus:
    """Tests for check_market_status oracle tool."""

    def test_open_market_returns_is_open_true(self):
        """Happy path: OPEN status returns is_open=True."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(FUTURE_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response
            result = check_market_status(mic="XNYS")

        assert result["is_open"] is True
        assert result["status"] == "OPEN"
        assert result["mic"] == "XNYS"
        assert result["error"] is None
        assert result["ttl_valid"] is True

    def test_closed_market_returns_is_open_false(self):
        """CLOSED status returns is_open=False (fail-closed)."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(CLOSED_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response
            result = check_market_status(mic="XNYS")

        assert result["is_open"] is False
        assert result["status"] == "CLOSED"
        assert result["error"] is None

    def test_halted_market_returns_is_open_false(self):
        """HALTED returns is_open=False (fail-closed)."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(HALTED_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response
            result = check_market_status(mic="XNYS")

        assert result["is_open"] is False
        assert result["status"] == "HALTED"

    def test_unknown_status_treated_as_closed(self):
        """UNKNOWN is fail-closed — is_open=False."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(UNKNOWN_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response
            result = check_market_status(mic="XNYS")

        assert result["is_open"] is False
        assert result["status"] == "UNKNOWN"

    def test_oracle_http_error_returns_is_open_false(self):
        """Non-200 HTTP response returns is_open=False with error message."""
        mock_response = MagicMock()
        mock_response.status_code = 503

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response
            result = check_market_status(mic="XNYS")

        assert result["is_open"] is False
        assert result["status"] == "ERROR"
        assert "503" in result["error"]

    def test_oracle_timeout_returns_is_open_false(self):
        """Network timeout returns is_open=False (fail-closed)."""
        import httpx

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.side_effect = (
                httpx.TimeoutException("timeout")
            )
            result = check_market_status(mic="XNYS")

        assert result["is_open"] is False
        assert result["status"] == "ERROR"
        assert "timed out" in result["error"].lower()

    def test_unwrapped_receipt_also_works(self):
        """Direct receipt (no discovery_url wrapper) is handled correctly."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = FUTURE_RECEIPT  # no wrapper

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response
            result = check_market_status(mic="XNYS")

        assert result["is_open"] is True
        assert result["status"] == "OPEN"

    def test_default_mic_uses_config(self):
        """Empty mic defaults to config.oracle_mic."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(FUTURE_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client = mock_client_class.return_value.__enter__.return_value
            mock_client.get.return_value = mock_response
            result = check_market_status(mic="")

        # Should have called the oracle with the default MIC (XNYS from config)
        call_args = mock_client.get.call_args[0][0]
        assert "mic=" in call_args
        assert result["is_open"] is True

    def test_api_key_uses_status_endpoint_with_header(self):
        """When ORACLE_API_KEY is set, calls /v5/status with X-Oracle-Key header."""
        import agent.tools.oracle_tools as oracle_module
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(FUTURE_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client = mock_client_class.return_value.__enter__.return_value
            mock_client.get.return_value = mock_response
            # Temporarily set an API key in config
            original_key = oracle_module.config.oracle_api_key
            oracle_module.config.oracle_api_key = "test_key_abc123"
            try:
                result = check_market_status(mic="XNYS")
            finally:
                oracle_module.config.oracle_api_key = original_key

        call_args, call_kwargs = mock_client.get.call_args
        assert "/v5/status" in call_args[0]
        assert call_kwargs.get("headers", {}).get("X-Oracle-Key") == "test_key_abc123"
        assert result["is_open"] is True

    def test_no_api_key_uses_demo_endpoint(self):
        """Without ORACLE_API_KEY, calls /v5/demo (no auth header)."""
        import agent.tools.oracle_tools as oracle_module
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(FUTURE_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client = mock_client_class.return_value.__enter__.return_value
            mock_client.get.return_value = mock_response
            original_key = oracle_module.config.oracle_api_key
            oracle_module.config.oracle_api_key = ""
            try:
                result = check_market_status(mic="XNYS")
            finally:
                oracle_module.config.oracle_api_key = original_key

        call_args, call_kwargs = mock_client.get.call_args
        assert "/v5/demo" in call_args[0]
        assert not call_kwargs.get("headers", {}).get("X-Oracle-Key")

    def test_expired_receipt_ttl_invalid(self):
        """Expired receipt returns ttl_valid=False and is_open=False."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = wrapped(EXPIRED_RECEIPT)

        with patch("agent.tools.oracle_tools.httpx.Client") as mock_client_class:
            mock_client_class.return_value.__enter__.return_value.get.return_value = mock_response
            result = check_market_status(mic="XNYS")

        assert result["ttl_valid"] is False
        assert result["is_open"] is False


class TestBuildPaymentAttestation:
    """Tests for build_payment_attestation tool."""

    def test_valid_receipt_builds_attestation(self):
        """Happy path: valid receipt and tx_id produces attestation_ref."""
        result = build_payment_attestation(
            mic="XNYS",
            x402_transaction_id=TX_ID,
            receipt=FUTURE_RECEIPT,
        )

        assert result["valid"] is True
        assert result["error"] is None
        assert result["attestation_ref"] is not None
        assert result["attestation_ref"]["mic"] == "XNYS"
        assert result["attestation_ref"]["status"] == "OPEN"
        assert result["attestation_ref"]["replay_protection"]["correlation_id"] == TX_ID

    def test_no_receipt_returns_invalid(self):
        """Missing receipt returns valid=False with error."""
        result = build_payment_attestation(
            mic="XNYS",
            x402_transaction_id=TX_ID,
            receipt=None,
        )
        assert result["valid"] is False
        assert result["error"] is not None

    def test_expired_receipt_returns_invalid(self):
        """Expired receipt returns valid=False — cannot be used for payment."""
        result = build_payment_attestation(
            mic="XNYS",
            x402_transaction_id=TX_ID,
            receipt=EXPIRED_RECEIPT,
        )
        assert result["valid"] is False
        assert "expired" in result["error"].lower()

    def test_attestation_ref_has_composite_hash(self):
        """attestation_ref includes replay_protection with composite_hash."""
        result = build_payment_attestation(
            mic="XNYS",
            x402_transaction_id=TX_ID,
            receipt=FUTURE_RECEIPT,
        )
        rp = result["attestation_ref"]["replay_protection"]
        assert "composite_hash" in rp
        assert len(rp["composite_hash"]) == 64  # sha256 hex = 64 chars

    def test_different_tx_ids_produce_different_attestations(self):
        """Each transaction gets a unique composite hash."""
        r1 = build_payment_attestation("XNYS", "tx-1", FUTURE_RECEIPT)
        r2 = build_payment_attestation("XNYS", "tx-2", FUTURE_RECEIPT)
        assert r1["attestation_ref"]["replay_protection"]["composite_hash"] != \
               r2["attestation_ref"]["replay_protection"]["composite_hash"]
