"""Headless Oracle SDK — Ed25519-signed market-state attestations for 28 global exchanges."""

from .client import HeadlessOracle
from .models import (
    BatchResponse,
    BatchSummary,
    BriefingResponse,
    Exchange,
    HealthResponse,
    HistoricalResponse,
    InstantKeyResponse,
    MarketStatus,
    ReceiptMode,
    ScheduleResponse,
    SignedReceipt,
    StatusResponse,
    StatusSource,
    VerifyResult,
)
from .errors import OracleError

__all__ = [
    "HeadlessOracle",
    "OracleError",
    "SignedReceipt",
    "StatusResponse",
    "BatchResponse",
    "BatchSummary",
    "HistoricalResponse",
    "Exchange",
    "ScheduleResponse",
    "VerifyResult",
    "InstantKeyResponse",
    "HealthResponse",
    "BriefingResponse",
    "MarketStatus",
    "StatusSource",
    "ReceiptMode",
]

__version__ = "0.1.0"
