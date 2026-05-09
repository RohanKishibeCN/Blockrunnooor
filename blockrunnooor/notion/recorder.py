from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import requests

from ..logging import log_event
from ..models import NotionRunRecord
from ..state.db import StateDB
from .client import NotionClient, NotionPage, safe_request_error
from .runs import build_create_payload, build_update_payload


@dataclass(frozen=True)
class UpsertResult:
    ok: bool
    page_id: str | None
    error: str | None
    retryable: bool


class NotionRecorder:
    def __init__(self, *, token: str, runs_database_id: str, timeout_seconds: int, state_db: StateDB):
        self._client = NotionClient(token=token, timeout_seconds=timeout_seconds)
        self._db = runs_database_id
        self._state = state_db

    def upsert_run(self, rec: NotionRunRecord) -> UpsertResult:
        try:
            page_id = self._client.find_page_by_run_id(self._db, rec.run_id)
            if page_id:
                payload = build_update_payload(rec)
                self._client.update_page(page_id, payload)
                return UpsertResult(ok=True, page_id=page_id, error=None, retryable=False)
            payload = build_create_payload(self._db, rec)
            created = self._client.create_page(payload)
            pid = created.get("id") if isinstance(created, dict) else None
            return UpsertResult(ok=True, page_id=pid if isinstance(pid, str) else None, error=None, retryable=False)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            retryable = NotionClient.can_retry_http(status)
            return UpsertResult(ok=False, page_id=None, error=f"http_{status}", retryable=retryable)
        except Exception as e:
            return UpsertResult(ok=False, page_id=None, error=safe_request_error(e), retryable=True)

    def enqueue_outbox(self, run_id: str, payload: dict[str, Any], next_retry_at: int, attempt: int, last_error: str | None) -> None:
        self._state.enqueue_notion_outbox(run_id, payload, next_retry_at, attempt, last_error)


def log_notion_result(logger: logging.Logger, run_id: str, res: UpsertResult) -> None:
    if res.ok:
        log_event(logger, logging.INFO, "notion_upsert_ok", run_id=run_id, page_id=res.page_id)
    else:
        log_event(logger, logging.WARNING, "notion_upsert_failed", run_id=run_id, error=res.error, retryable=res.retryable)

