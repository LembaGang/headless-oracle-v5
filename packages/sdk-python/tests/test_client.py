"""Tests for the Headless Oracle Python SDK."""

import json

import httpx
import pytest
import respx

from headless_oracle import HeadlessOracle, OracleError
from headless_oracle.models import MarketStatus


BASE = "https://headlessoracle.com"


MOCK_RECEIPT = {
    "receipt_id": "test-uuid",
    "issued_at": "2026-04-09T12:00:00Z",
    "expires_at": "2026-04-09T12:01:00Z",
    "issuer": "headlessoracle.com",
    "mic": "XNYS",
    "status": "OPEN",
    "source": "SCHEDULE",
    "halt_detection": "active",
    "receipt_mode": "demo",
    "schema_version": "v5.0",
    "public_key_id": "key_2026_v1",
    "signature": "abcd1234" * 16,
    "discovery_url": "https://headlessoracle.com/.well-known/mcp/server-card.json",
    "receipt": {},
}


@respx.mock
def test_get_status_returns_signed_receipt():
    respx.get(f"{BASE}/v5/demo").mock(
        return_value=httpx.Response(200, json=MOCK_RECEIPT)
    )
    oracle = HeadlessOracle()
    receipt = oracle.get_status("XNYS")
    assert receipt.status == MarketStatus.OPEN
    assert receipt.mic == "XNYS"
    assert receipt.issuer == "headlessoracle.com"


@respx.mock
def test_get_status_authenticated():
    respx.get(f"{BASE}/v5/status").mock(
        return_value=httpx.Response(200, json=MOCK_RECEIPT)
    )
    oracle = HeadlessOracle(api_key="ho_free_test")
    receipt = oracle.get_status("XNYS")
    assert receipt.status == MarketStatus.OPEN


@respx.mock
def test_batch_returns_summary():
    batch_data = {
        "batch_id": "batch-uuid",
        "correlation_id": "corr-uuid",
        "queried_at": "2026-04-09T12:00:00Z",
        "receipts": [MOCK_RECEIPT],
        "exchanges": {},
        "summary": {
            "total": 1,
            "open": 1,
            "closed": 0,
            "halted": 0,
            "unknown": 0,
            "all_open": True,
            "any_halted": False,
            "safe_to_execute": True,
            "reason": "All exchanges OPEN",
        },
        "batch_signature": "sig",
    }
    respx.get(f"{BASE}/v5/batch").mock(
        return_value=httpx.Response(200, json=batch_data)
    )
    oracle = HeadlessOracle(api_key="ho_free_test")
    batch = oracle.batch(["XNYS"])
    assert batch.summary.all_open is True
    assert batch.summary.total == 1


@respx.mock
def test_historical_returns_reconstruction():
    hist_data = {
        "mic": "XNYS",
        "queried_at": "2026-03-09T14:30:00Z",
        "computed_status": "OPEN",
        "source": "SCHEDULE_RECONSTRUCTION",
        "reasoning": {},
        "dst_note": None,
        "disclaimer": "Historical reconstruction.",
        "schema_version": "v5.0",
    }
    respx.get(f"{BASE}/v5/historical").mock(
        return_value=httpx.Response(200, json=hist_data)
    )
    oracle = HeadlessOracle()
    result = oracle.historical("XNYS", "2026-03-09T14:30:00Z")
    assert result.computed_status == MarketStatus.OPEN


@respx.mock
def test_list_exchanges():
    respx.get(f"{BASE}/v5/exchanges").mock(
        return_value=httpx.Response(200, json={
            "exchanges": [
                {"mic": "XNYS", "name": "NYSE", "timezone": "America/New_York", "mic_type": "iso"},
            ]
        })
    )
    oracle = HeadlessOracle()
    exchanges = oracle.list_exchanges()
    assert len(exchanges) == 1
    assert exchanges[0].mic == "XNYS"


@respx.mock
def test_verify_server_side():
    verify_data = {
        "valid": True,
        "expired": False,
        "reason": "SIGNATURE_VALID",
        "mic": "XNYS",
        "status": "OPEN",
        "expires_at": "2026-04-09T12:01:00Z",
    }
    respx.post(f"{BASE}/v5/verify").mock(
        return_value=httpx.Response(200, json=verify_data)
    )
    oracle = HeadlessOracle()
    result = oracle.verify(MOCK_RECEIPT)
    assert result.valid is True
    assert result.reason == "SIGNATURE_VALID"


@respx.mock
def test_get_instant_key():
    key_data = {
        "api_key": "ho_free_abc123",
        "daily_limit": 500,
        "plan": "free",
        "created_at": "2026-04-09T12:00:00Z",
        "usage": "Add header: X-Oracle-Key: ho_free_abc123",
        "example": "curl ...",
        "upgrade_url": "https://headlessoracle.com/pricing",
    }
    respx.post(f"{BASE}/v5/keys/instant").mock(
        return_value=httpx.Response(200, json=key_data)
    )
    oracle = HeadlessOracle()
    result = oracle.get_instant_key("my-agent")
    assert result.api_key == "ho_free_abc123"
    assert result.plan == "free"


@respx.mock
def test_429_raises_oracle_error():
    respx.get(f"{BASE}/v5/demo").mock(
        return_value=httpx.Response(429, json={"error": "RATE_LIMITED", "message": "Too fast"})
    )
    oracle = HeadlessOracle(max_retries=0)
    with pytest.raises(OracleError) as exc_info:
        oracle.get_status("XNYS")
    assert exc_info.value.status == 429
    assert exc_info.value.code == "RATE_LIMITED"


@respx.mock
def test_403_raises_oracle_error():
    respx.get(f"{BASE}/v5/status").mock(
        return_value=httpx.Response(403, json={"error": "INVALID_API_KEY", "message": "Bad key"})
    )
    oracle = HeadlessOracle(api_key="bad_key")
    with pytest.raises(OracleError) as exc_info:
        oracle.get_status("XNYS")
    assert exc_info.value.status == 403


@respx.mock
def test_is_safe_to_execute():
    respx.get(f"{BASE}/v5/demo").mock(
        return_value=httpx.Response(200, json=MOCK_RECEIPT)
    )
    oracle = HeadlessOracle()
    assert oracle.is_safe_to_execute("XNYS") is True


@respx.mock
def test_is_safe_to_execute_closed():
    closed_receipt = {**MOCK_RECEIPT, "status": "CLOSED"}
    respx.get(f"{BASE}/v5/demo").mock(
        return_value=httpx.Response(200, json=closed_receipt)
    )
    oracle = HeadlessOracle()
    assert oracle.is_safe_to_execute("XNYS") is False


@respx.mock
def test_health():
    health_data = {
        "receipt_id": "health-uuid",
        "issued_at": "2026-04-09T12:00:00Z",
        "expires_at": "2026-04-09T12:01:00Z",
        "status": "OK",
        "source": "SYSTEM",
        "public_key_id": "key_2026_v1",
        "signature": "abcd" * 32,
        "exchange_count": 28,
        "supported_mics": ["XNYS"],
    }
    respx.get(f"{BASE}/v5/health").mock(
        return_value=httpx.Response(200, json=health_data)
    )
    oracle = HeadlessOracle()
    result = oracle.health()
    assert result.status == "OK"
    assert result.exchange_count == 28
