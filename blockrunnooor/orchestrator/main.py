from __future__ import annotations

import asyncio
import logging

from ..config import Settings
from ..logging import configure_logging, get_logger, log_event
from .service import Orchestrator


def main() -> int:
    configure_logging()
    logger = get_logger("orchestrator_main")
    try:
        settings = Settings()
    except Exception as e:
        log_event(logger, logging.ERROR, "settings_error", error=str(e)[:200])
        return 2

    orch = Orchestrator(settings)
    asyncio.run(orch.run_forever())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

