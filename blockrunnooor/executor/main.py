from __future__ import annotations

import json
import logging
import sys

from ..config import Settings
from ..logging import configure_logging, get_logger, log_event
from ..models import ExecutorInput, ExecutorOutput
from ..router.blockrun import BlockRunClient
from ..wallet_store import load_wallet_manifest


def _read_stdin_json() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def main() -> int:
    logger = get_logger("executor")

    try:
        settings = Settings()
    except Exception as e:
        configure_logging()
        log_event(logger, logging.ERROR, "settings_error", error=str(e)[:200])
        return 2
    configure_logging(settings.brnoo_log_level)

    try:
        payload = _read_stdin_json()
        inp = ExecutorInput.model_validate(payload)
    except Exception as e:
        log_event(logger, logging.ERROR, "input_error", error=str(e)[:200])
        return 2

    wallet_key = settings.blockrun_wallet_key
    if settings.brnoo_wallets_manifest_path:
        manifest = load_wallet_manifest(settings.brnoo_wallets_manifest_path)
        rec = manifest.get(inp.wallet_id)
        if rec:
            wallet_key = rec.private_key

    client = BlockRunClient(
        api_url=settings.blockrun_api_url,
        wallet_key=wallet_key,
        timeout_seconds=settings.blockrun_timeout_seconds,
    )

    path = inp.blockrun_path or settings.blockrun_chat_path
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
