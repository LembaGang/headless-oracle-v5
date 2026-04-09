"""Headless Oracle Python SDK client."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError

from .errors import OracleError
from .models import (
    BatchResponse,
    BriefingResponse,
    Exchange,
    HealthResponse,
    HistoricalResponse,
    InstantKeyResponse,
    ScheduleResponse,
    SignedReceipt,
    StatusResponse,
    VerifyResult,
)


class HeadlessOracle:
    """Client for the Headless Oracle API.

    Args:
        api_key: API key (ho_free_, ho_live_, sb_, ho_crd_ prefix). Optional.
        base_url: Base URL. Default: https://headlessoracle.com
        public_key: Ed25519 public key hex for offline verification. Fetched if omitted.
        max_retries: Max retries on 429. Default: 3.
        timeout: Request timeout in seconds. Default: 10.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://headlessoracle.com",
        public_key: str | None = None,
        max_retries: int = 3,
        timeout: float = 10.0,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._public_key_hex = public_key
        self.max_retries = max_retries
        self.timeout = timeout
        self._client = httpx.Client(timeout=timeout)

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> "HeadlessOracle":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    # ── Core Methods ─────────────────────────────────────────────────────────

    def get_status(self, mic: str) -> StatusResponse:
        """Get a signed market-state receipt for one exchange.

        Uses /v5/status (authenticated) if api_key is set, otherwise /v5/demo.
        """
        endpoint = "/v5/status" if self.api_key else "/v5/demo"
        data = self._get(f"{endpoint}?mic={mic.upper()}")
        return StatusResponse.model_validate(data)

    def get_demo(self, mic: str) -> StatusResponse:
        """Get a public demo receipt (never uses API key)."""
        data = self._get(f"/v5/demo?mic={mic.upper()}")
        return StatusResponse.model_validate(data)

    def batch(self, mics: list[str]) -> BatchResponse:
        """Batch signed receipts for multiple exchanges."""
        param = ",".join(m.upper() for m in mics)
        data = self._get(f"/v5/batch?mics={param}")
        return BatchResponse.model_validate(data)

    def historical(self, mic: str, at: str) -> HistoricalResponse:
        """Historical market-state reconstruction (unsigned)."""
        data = self._get(f"/v5/historical?mic={mic.upper()}&at={at}")
        return HistoricalResponse.model_validate(data)

    def get_schedule(self, mic: str) -> ScheduleResponse:
        """Get next open/close times for an exchange."""
        data = self._get(f"/v5/schedule?mic={mic.upper()}")
        return ScheduleResponse.model_validate(data)

    def list_exchanges(self) -> list[Exchange]:
        """List all 28 supported exchanges."""
        data = self._get("/v5/exchanges")
        return [Exchange.model_validate(e) for e in data["exchanges"]]

    def health(self) -> HealthResponse:
        """Signed liveness probe."""
        data = self._get("/v5/health")
        return HealthResponse.model_validate(data)

    def briefing(self) -> BriefingResponse:
        """Daily market intelligence snapshot."""
        data = self._get("/v5/briefing")
        return BriefingResponse.model_validate(data)

    # ── Verification ─────────────────────────────────────────────────────────

    def verify(self, receipt: SignedReceipt | dict[str, Any]) -> VerifyResult:
        """Verify a receipt's Ed25519 signature via server-side /v5/verify."""
        body = receipt if isinstance(receipt, dict) else receipt.model_dump()
        data = self._post("/v5/verify", {"receipt": body})
        return VerifyResult.model_validate(data)

    def verify_offline(self, receipt: SignedReceipt | dict[str, Any]) -> dict[str, Any]:
        """Verify a receipt offline using Ed25519 (PyNaCl).

        Returns:
            {"valid": bool, "expired": bool, "reason": str}
        """
        r = receipt if isinstance(receipt, dict) else receipt.model_dump()

        # Check expiry
        expires_at = datetime.fromisoformat(r["expires_at"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires_at:
            return {"valid": False, "expired": True, "reason": "RECEIPT_EXPIRED"}

        # Get public key
        pub_hex = self.get_public_key()
        if not pub_hex:
            return {"valid": False, "expired": False, "reason": "PUBLIC_KEY_UNAVAILABLE"}

        # Build canonical payload (alphabetical key sort, no whitespace)
        signature_hex = r["signature"]
        payload = {k: v for k, v in sorted(r.items()) if k != "signature"}
        canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        msg_bytes = canonical.encode("utf-8")

        try:
            verify_key = VerifyKey(bytes.fromhex(pub_hex))
            sig_bytes = bytes.fromhex(signature_hex)
            verify_key.verify(msg_bytes, sig_bytes)
            return {"valid": True, "expired": False, "reason": "SIGNATURE_VALID"}
        except BadSignatureError:
            return {"valid": False, "expired": False, "reason": "INVALID_SIGNATURE"}
        except Exception:
            return {"valid": False, "expired": False, "reason": "VERIFICATION_ERROR"}

    # ── Key Management ───────────────────────────────────────────────────────

    def get_instant_key(self, agent_id: str) -> InstantKeyResponse:
        """Get an instant free API key (zero friction, one per agent_id)."""
        data = self._post("/v5/keys/instant", {"agent_id": agent_id})
        return InstantKeyResponse.model_validate(data)

    def get_public_key(self) -> str | None:
        """Fetch and cache the Ed25519 public key from /v5/keys."""
        if self._public_key_hex:
            return self._public_key_hex
        try:
            data = self._get("/v5/keys")
            keys = data.get("keys", [])
            if keys:
                self._public_key_hex = keys[0]["public_key"]
            return self._public_key_hex
        except Exception:
            return None

    # ── Safety Helpers ────────────────────────────────────────────────────────

    def is_safe_to_execute(self, mic: str) -> bool:
        """Returns True only if the exchange status is OPEN."""
        receipt = self.get_status(mic)
        return receipt.status.value == "OPEN"

    def all_open(self, mics: list[str]) -> bool:
        """Returns True if ALL given exchanges are OPEN."""
        result = self.batch(mics)
        return result.summary.all_open

    # ── Internal ─────────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if self.api_key:
            headers["X-Oracle-Key"] = self.api_key
        return headers

    def _get(self, path: str) -> dict[str, Any]:
        return self._request("GET", path)

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", path, json_body=body)

    def _request(
        self,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        last_error: Exception | None = None

        for attempt in range(self.max_retries + 1):
            if attempt > 0:
                time.sleep(min(2 ** (attempt - 1), 8))

            try:
                if method == "POST" and json_body is not None:
                    resp = self._client.post(url, json=json_body, headers=self._headers())
                else:
                    resp = self._client.get(url, headers=self._headers())
            except httpx.HTTPError as e:
                last_error = e
                continue

            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                if retry_after and attempt < self.max_retries:
                    time.sleep(int(retry_after))
                body = resp.json() if resp.content else {}
                last_error = OracleError("Rate limited", 429, "RATE_LIMITED", body)
                continue

            if resp.status_code == 402 and not self.api_key:
                # Auto-provision instant key
                try:
                    key_resp = self.get_instant_key(f"sdk-auto-{int(time.time())}")
                    self.api_key = key_resp.api_key
                    # Retry with new key
                    if method == "POST" and json_body is not None:
                        retry = self._client.post(url, json=json_body, headers=self._headers())
                    else:
                        retry = self._client.get(url, headers=self._headers())
                    if not retry.is_success:
                        body = retry.json() if retry.content else {}
                        raise OracleError(
                            body.get("message", f"HTTP {retry.status_code}"),
                            retry.status_code,
                            body.get("error", "UNKNOWN"),
                            body,
                        )
                    return retry.json()
                except OracleError:
                    raise
                except Exception:
                    body = resp.json() if resp.content else {}
                    raise OracleError("Payment required", 402, "PAYMENT_REQUIRED", body)

            if not resp.is_success:
                body = resp.json() if resp.content else {}
                raise OracleError(
                    body.get("message", f"HTTP {resp.status_code}"),
                    resp.status_code,
                    body.get("error", "UNKNOWN"),
                    body,
                )

            return resp.json()

        if last_error:
            raise last_error
        raise OracleError("Request failed after retries", 0, "RETRY_EXHAUSTED")
