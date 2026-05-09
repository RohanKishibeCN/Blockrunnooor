from __future__ import annotations

from typing import Any

from ..models import NotionRunRecord


def _title(s: str) -> dict[str, Any]:
    return {"title": [{"type": "text", "text": {"content": s}}]}


def _rich_text(s: str) -> dict[str, Any]:
    return {"rich_text": [{"type": "text", "text": {"content": s}}]}


def _select(s: str) -> dict[str, Any]:
    return {"select": {"name": s}}


def _number(n: float | int) -> dict[str, Any]:
    return {"number": n}


def _date(iso: str) -> dict[str, Any]:
    return {"date": {"start": iso}}


def build_run_properties(rec: NotionRunRecord) -> dict[str, Any]:
    props: dict[str, Any] = {
        "run_id": _title(rec.run_id),
        "created_at": _date(rec.created_at.replace(microsecond=0).isoformat() + "Z"),
        "wallet_id": _rich_text(rec.wallet_id),
        "task_type": _select(rec.task_type),
        "schedule_type": _select(rec.schedule_type),
        "attempt": _number(rec.attempt),
        "decision": _select(rec.decision),
        "channel": _select(rec.channel),
        "status": _select(rec.status),
        "latency_ms": _number(rec.latency_ms),
        "orchestrator_version": _rich_text(rec.orchestrator_version),
    }

    if rec.model:
        props["model"] = _rich_text(rec.model)
    if rec.total_cost is not None:
        props["total_cost"] = _number(rec.total_cost)
    if rec.input_tokens is not None:
        props["input_tokens"] = _number(rec.input_tokens)
    if rec.output_tokens is not None:
        props["output_tokens"] = _number(rec.output_tokens)
    if rec.error_type:
        props["error_type"] = _select(rec.error_type)
    if rec.error_code:
        props["error_code"] = _rich_text(rec.error_code)
    if rec.error_message:
        props["error_message"] = _rich_text(rec.error_message)
    if rec.request_id:
        props["request_id"] = _rich_text(rec.request_id)

    return props


def build_create_payload(database_id: str, rec: NotionRunRecord) -> dict[str, Any]:
    return {"parent": {"database_id": database_id}, "properties": build_run_properties(rec)}


def build_update_payload(rec: NotionRunRecord) -> dict[str, Any]:
    props = build_run_properties(rec)
    props.pop("run_id", None)
    props.pop("created_at", None)
    props.pop("wallet_id", None)
    props.pop("task_type", None)
    props.pop("schedule_type", None)
    return {"properties": props}

