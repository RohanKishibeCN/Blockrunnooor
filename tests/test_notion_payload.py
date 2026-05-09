from __future__ import annotations

from datetime import datetime

from blockrunnooor.models import NotionRunRecord
from blockrunnooor.notion.runs import build_create_payload, build_update_payload


def test_build_notion_payload_shapes():
    rec = NotionRunRecord(
        run_id="rid",
        created_at=datetime(2026, 1, 1),
        wallet_id="w1",
        task_type="default",
        schedule_type="cron",
        attempt=1,
        decision="blockrun",
        channel="blockrun",
        model="m",
        status="success",
        latency_ms=12,
        total_cost=0.01,
        input_tokens=1,
        output_tokens=2,
        error_type=None,
        error_code=None,
        error_message=None,
        orchestrator_version="v",
        request_id="req",
    )

    create = build_create_payload("db", rec)
    assert create["parent"]["database_id"] == "db"
    props = create["properties"]
    assert "run_id" in props
    assert "created_at" in props
    assert props["run_id"]["title"][0]["text"]["content"] == "rid"

    update = build_update_payload(rec)
    uprops = update["properties"]
    assert "run_id" not in uprops
    assert "attempt" in uprops

