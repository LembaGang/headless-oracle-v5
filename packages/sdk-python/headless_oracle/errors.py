"""Errors for Headless Oracle SDK."""

from __future__ import annotations

from typing import Any


class OracleError(Exception):
    """Structured error from the Headless Oracle API."""

    def __init__(
        self,
        message: str,
        status: int,
        code: str,
        body: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body or {}
