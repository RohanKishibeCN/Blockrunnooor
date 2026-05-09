from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import requests


@dataclass(frozen=True)
class NotionPage:
    page_id: str
    properties: dict[str, Any]


class NotionClient:
    def __init__(self, token: str, timeout_seconds: int):
        self._token = token
        self._timeout = timeout_seconds
        self._base_url = "https://api.notion.com/v1"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        }

    def query_database(self, database_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}/databases/{database_id}/query"
        resp = requests.post(url, headers=self._headers(), json=payload, timeout=self._timeout)
        resp.raise_for_status()
        return resp.json()

    def create_page(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}/pages"
        resp = requests.post(url, headers=self._headers(), json=payload, timeout=self._timeout)
        resp.raise_for_status()
        return resp.json()

    def update_page(self, page_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}/pages/{page_id}"
        resp = requests.patch(url, headers=self._headers(), json=payload, timeout=self._timeout)
        resp.raise_for_status()
        return resp.json()

    def find_page_by_run_id(self, database_id: str, run_id: str) -> str | None:
        q = {
            "filter": {
                "property": "run_id",
                "title": {"equals": run_id},
            }
        }
        data = self.query_database(database_id, q)
        results = data.get("results")
        if not isinstance(results, list) or not results:
            return None
        page = results[0]
        pid = page.get("id")
        return pid if isinstance(pid, str) else None

    @staticmethod
    def can_retry_http(status_code: int) -> bool:
        return status_code in (408, 409, 429) or status_code >= 500


def safe_request_error(e: Exception) -> str:
    s = str(e)
    if len(s) > 200:
        s = s[:200]
    return s


def backoff_seconds(base: int, attempt: int, max_seconds: int) -> int:
    if attempt <= 1:
        raw = base
    else:
        raw = base * (2 ** (attempt - 1))
    return int(min(raw + (time.time() % 1), max_seconds))

