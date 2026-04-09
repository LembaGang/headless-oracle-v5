"""Pydantic models for Headless Oracle API responses."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class MarketStatus(str, Enum):
    """Market status. UNKNOWN MUST be treated as CLOSED — halt all execution."""

    OPEN = "OPEN"
    CLOSED = "CLOSED"
    HALTED = "HALTED"
    UNKNOWN = "UNKNOWN"


class StatusSource(str, Enum):
    """Source of the status determination."""

    SCHEDULE = "SCHEDULE"
    OVERRIDE = "OVERRIDE"
    SYSTEM = "SYSTEM"
    REALTIME = "REALTIME"


class ReceiptMode(str, Enum):
    """Receipt mode: demo (unauthenticated) or live (authenticated)."""

    DEMO = "demo"
    LIVE = "live"


class SignedReceipt(BaseModel):
    """Ed25519-signed market-state receipt."""

    receipt_id: str
    issued_at: str
    expires_at: str
    issuer: str
    mic: str
    status: MarketStatus
    source: StatusSource
    reason: str | None = None
    halt_detection: str = Field(description="'active' or 'schedule_only'")
    receipt_mode: ReceiptMode
    schema_version: str
    public_key_id: str
    signature: str


class StatusResponse(SignedReceipt):
    """Wrapper returned by /v5/status and /v5/demo."""

    discovery_url: str | None = None
    receipt: dict[str, Any] | None = None
    extensions: dict[str, Any] | None = None


class BatchSummary(BaseModel):
    """Summary of a batch receipt response."""

    total: int
    open: int
    closed: int
    halted: int
    unknown: int
    all_open: bool
    any_halted: bool
    safe_to_execute: bool
    reason: str


class BatchResponse(BaseModel):
    """Batch response from /v5/batch."""

    batch_id: str
    correlation_id: str = ""
    queried_at: str
    receipts: list[dict[str, Any]]
    exchanges: dict[str, Any] = {}
    summary: BatchSummary
    batch_signature: str = ""


class HistoricalResponse(BaseModel):
    """Historical reconstruction (unsigned)."""

    mic: str
    queried_at: str
    computed_status: MarketStatus
    source: str = "SCHEDULE_RECONSTRUCTION"
    reasoning: dict[str, Any] = {}
    dst_note: str | None = None
    disclaimer: str = ""
    schema_version: str = "v5.0"


class Exchange(BaseModel):
    """Exchange info from /v5/exchanges."""

    mic: str
    name: str
    timezone: str
    mic_type: str = "iso"


class ScheduleResponse(BaseModel):
    """Schedule info from /v5/schedule."""

    mic: str
    name: str
    timezone: str
    queried_at: str
    current_status: MarketStatus
    next_open: str | None = None
    next_close: str | None = None
    data_coverage_years: list[str] = []
    lunch_break: dict[str, str] | None = None
    settlement_window: str | None = None
    note: str = ""


class VerifyResult(BaseModel):
    """Verification result."""

    valid: bool
    expired: bool
    reason: str
    mic: str | None = None
    status: str | None = None
    expires_at: str | None = None
    checks: dict[str, bool] | None = None


class InstantKeyResponse(BaseModel):
    """Instant key response."""

    api_key: str
    daily_limit: int
    plan: str
    created_at: str = ""
    usage: str = ""
    example: str = ""
    upgrade_url: str = ""


class HealthResponse(BaseModel):
    """Health response."""

    receipt_id: str
    issued_at: str
    expires_at: str
    status: str = "OK"
    source: str = "SYSTEM"
    public_key_id: str
    signature: str
    exchange_count: int = 0
    supported_mics: list[str] = []


class BriefingResponse(BaseModel):
    """Market briefing."""

    briefing_date: str
    briefing_time_utc: str
    markets_open_now: list[str] = []
    markets_closed_now: list[str] = []
    markets_in_lunch_break: list[str] = []
    upcoming_opens: list[dict[str, Any]] = []
    upcoming_closes: list[dict[str, Any]] = []
    holidays_today: list[str] = []
    coverage: int = 0
