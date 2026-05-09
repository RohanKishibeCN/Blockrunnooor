from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import requests

from ..models import ErrorType


@dataclass(frozen=True)
class BlockRunResponse:
    ok: bool
    status_code: int
    latency_ms: int
    json: dict[str, Any] | None
    error_type: ErrorType | None
    error_code: str | None
    error_message: str | None
    request_id: str | None
    model: str | None
    total_cost: float | None
    input_tokens: int | None
    output_tokens: int | None


class BlockRunClient:
    def __init__(self, api_url: str, wallet_key: str | None, timeout_seconds: int):
        self._base_url = api_url.rstrip("/")
        self._wallet_key = wallet_key
        self._timeout = timeout_seconds

    def call(self, path: str, payload: dict[str, Any]) -> BlockRunResponse:
        url = f"{self._base_url}{path}"
        headers = {"Content-Type": "application/json"}
        if self._wallet_key:
            headers["Authorization"] = f"Bearer {self._wallet_key}"

        start = time.time()
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=self._timeout)
            latency_ms = int((time.time() - start) * 1000)
        except requests.Timeout:
            latency_ms = int((time.time() - start) * 1000)
            return BlockRunResponse(
                ok=False,
                status_code=0,
                latency_ms=latency_ms,
                json=None,
                error_type="network",
                error_code="timeout",
                error_message="timeout",
                request_id=None,
                model=None,
                total_cost=None,
                input_tokens=None,
                output_tokens=None,
            )
        except requests.RequestException as e:
            latency_ms = int((time.time() - start) * 1000)
            return BlockRunResponse(
                ok=False,
                status_code=0,
                latency_ms=latency_ms,
                json=None,
                error_type="network",
                error_code="request_error",
                error_message=str(e)[:200],
                request_id=None,
                model=None,
                total_cost=None,
                input_tokens=None,
                output_tokens=None,
            )

        req_id = resp.headers.get("x-request-id") or resp.headers.get("request-id")
        parsed: dict[str, Any] | None = None
        try:
            if resp.content:
                parsed = resp.json()
        except ValueError:
            parsed = None

        if 200 <= resp.status_code < 300:
            model = None
            total_cost = None
            in_tokens = None
            out_tokens = None
            if isinstance(parsed, dict):
                model = parsed.get("model") or parsed.get("channel_model")
                req_id = req_id or parsed.get("request_id") or parsed.get("id")
                usage = parsed.get("usage") if isinstance(parsed.get("usage"), dict) else None
                if usage:
                    in_tokens = usage.get("input_tokens") or usage.get("prompt_tokens")
                    out_tokens = usage.get("output_tokens") or usage.get("completion_tokens")
                    total_cost = usage.get("total_cost") or usage.get("cost")
                total_cost = parsed.get("total_cost", total_cost)
            return BlockRunResponse(
                ok=True,
                status_code=resp.status_code,
                latency_ms=latency_ms,
                json=parsed,
                error_type=None,
                error_code=None,
                error_message=None,
                request_id=req_id,
                model=model,
                total_cost=total_cost if isinstance(total_cost, (int, float)) else None,
                input_tokens=in_tokens if isinstance(in_tokens, int) else None,
                output_tokens=out_tokens if isinstance(out_tokens, int) else None,
            )

        if resp.status_code == 429:
            et: ErrorType = "rate_limit"
        elif 400 <= resp.status_code < 500:
            et = "validation"
        elif resp.status_code >= 500:
            et = "upstream"
        else:
            et = "unknown"

        msg = None
        if isinstance(parsed, dict):
            msg = parsed.get("error") or parsed.get("message")
        msg = (str(msg) if msg is not None else resp.text)[:200]

        return BlockRunResponse(
            ok=False,
            status_code=resp.status_code,
            latency_ms=latency_ms,
            json=parsed,
            error_type=et,
            error_code=str(resp.status_code),
            error_message=msg,
            request_id=req_id,
            model=None,
            total_cost=None,
            input_tokens=None,
            output_tokens=None,
        )
