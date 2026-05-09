from __future__ import annotations

import asyncio
import logging

from ..config import Settings
from ..logging import configure_logging, get_logger, log_event
from .service import Orchestrator


def main() -> int:
    logger = get_logger("orchestrator_main")
    try:
        settings = Settings()
    except Exception as e:
        configure_logging()
        log_event(logger, logging.ERROR, "settings_error", error=str(e)[:200])
        return 2

    configure_logging(settings.brnoo_log_level)
    orch = Orchestrator(settings)
    asyncio.run(orch.run_forever())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
