from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


ErrorType = Literal["network", "upstream", "validation", "budget", "rate_limit", "unknown"]
Decision = Literal["blockrun", "deny"]
RunStatus = Literal["success", "failed", "skipped"]
ScheduleType = Literal["cron", "random", "retry"]


class ExecutorInput(BaseModel):
    wallet_id: str
    task_type: str
    run_id: str
    attempt: int
    schedule_type: ScheduleType
    jitter_seconds: int = 0
    backoff_seconds: int = 0
    blockrun_path: str | None = None
    blockrun_json: dict[str, Any] = Field(default_factory=dict)


class ExecutorOutput(BaseModel):
    run_id: str
    wallet_id: str
    task_type: str
    attempt: int
    decision: Decision
    channel: str
    model: str | None = None
    status: RunStatus
    latency_ms: int
    total_cost: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    request_id: str | None = None
    error_type: ErrorType | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class NotionRunRecord(BaseModel):
    run_id: str
    created_at: datetime
    wallet_id: str
    task_type: str
    schedule_type: ScheduleType
    attempt: int
    decision: Decision
    channel: str
    model: str | None
    status: RunStatus
    latency_ms: int
    total_cost: float | None
    input_tokens: int | None
    output_tokens: int | None
    error_type: ErrorType | None
    error_code: str | None
    error_message: str | None
    orchestrator_version: str
    request_id: str | None = None
