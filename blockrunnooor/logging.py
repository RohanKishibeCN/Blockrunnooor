from __future__ import annotations

import json
import logging
import sys
from typing import Any


def mask_address(addr: str) -> str:
    if len(addr) <= 12:
        return addr
    return f"{addr[:6]}...{addr[-4:]}"


def redact_value(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, str):
        lowered = v.lower()
        if "private" in lowered or "mnemonic" in lowered or "seed" in lowered:
            return "[redacted]"
        if "bearer " in lowered:
            return "Bearer [redacted]"
        return v
    if isinstance(v, dict):
        return {k: redact_value(val) for k, val in v.items()}
    if isinstance(v, list):
        return [redact_value(x) for x in v]
    return v


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = {
            "ts": int(record.created * 1000),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        extra = getattr(record, "extra", None)
        if isinstance(extra, dict):
            base.update(redact_value(extra))
        if record.exc_info:
            base["exc"] = self.formatException(record.exc_info)
        return json.dumps(base, ensure_ascii=False, separators=(",", ":"))


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.setLevel(level)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.handlers = [handler]


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_event(logger: logging.Logger, level: int, msg: str, **fields: Any) -> None:
    logger.log(level, msg, extra={"extra": fields})

