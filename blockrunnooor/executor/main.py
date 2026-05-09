from __future__ import annotations

import json
import logging
import sys

from ..config import Settings
from ..logging import configure_logging, get_logger, log_event
from ..models import ExecutorInput, ExecutorOutput
from ..router.blockrun import BlockRunClient


def _read_stdin_json() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def main() -> int:
    configure_logging()
    logger = get_logger("executor")

    try:
        settings = Settings()
    except Exception as e:
        log_event(logger, logging.ERROR, "settings_error", error=str(e)[:200])
        return 2

    try:
        payload = _read_stdin_json()
        inp = ExecutorInput.model_validate(payload)
    except Exception as e:
        log_event(logger, logging.ERROR, "input_error", error=str(e)[:200])
        return 2

    client = BlockRunClient(
        base_url=settings.blockrun_base_url,
        auth_token=settings.blockrun_auth_token,
        timeout_seconds=settings.blockrun_timeout_seconds,
    )

    path = inp.blockrun_path or settings.blockrun_default_path
    resp = client.call(path=path, payload=inp.blockrun_json)

    if resp.ok:
        out = ExecutorOutput(
            run_id=inp.run_id,
            wallet_id=inp.wallet_id,
            task_type=inp.task_type,
            attempt=inp.attempt,
            decision="blockrun",
            channel="blockrun",
            model=resp.model,
            status="success",
            latency_ms=resp.latency_ms,
            total_cost=resp.total_cost,
            input_tokens=resp.input_tokens,
            output_tokens=resp.output_tokens,
            request_id=resp.request_id,
        )
    else:
        out = ExecutorOutput(
            run_id=inp.run_id,
            wallet_id=inp.wallet_id,
            task_type=inp.task_type,
            attempt=inp.attempt,
            decision="blockrun",
            channel="blockrun",
            model=None,
            status="failed",
            latency_ms=resp.latency_ms,
            total_cost=None,
            input_tokens=None,
            output_tokens=None,
            request_id=resp.request_id,
            error_type=resp.error_type or "unknown",
            error_code=resp.error_code,
            error_message=resp.error_message,
        )

    sys.stdout.write(out.model_dump_json())
    sys.stdout.flush()
    return 0 if out.status == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())

