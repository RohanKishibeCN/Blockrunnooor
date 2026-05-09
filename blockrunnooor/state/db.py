from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class WalletState:
    wallet_id: str
    status: str
    daily_budget_usd: float
    max_cost_per_run_usd: float
    spent_today_usd: float
    spent_day: str
    cooldown_until: int
    last_run_at: int


@dataclass(frozen=True)
class CircuitState:
    channel: str
    failure_count: int
    open_until: int


class StateDB:
    def __init__(self, path: str):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS wallets (
                  wallet_id TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  daily_budget_usd REAL NOT NULL,
                  max_cost_per_run_usd REAL NOT NULL,
                  spent_today_usd REAL NOT NULL,
                  spent_day TEXT NOT NULL,
                  cooldown_until INTEGER NOT NULL,
                  last_run_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS circuits (
                  channel TEXT PRIMARY KEY,
                  failure_count INTEGER NOT NULL,
                  open_until INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS runs_index (
                  run_id TEXT PRIMARY KEY,
                  wallet_id TEXT NOT NULL,
                  task_type TEXT NOT NULL,
                  scheduled_bucket INTEGER NOT NULL,
                  attempt INTEGER NOT NULL,
                  notion_page_id TEXT,
                  updated_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_runs_lookup
                ON runs_index(wallet_id, task_type, scheduled_bucket);

                CREATE TABLE IF NOT EXISTS notion_outbox (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  run_id TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  next_retry_at INTEGER NOT NULL,
                  attempt INTEGER NOT NULL,
                  last_error TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_outbox_retry
                ON notion_outbox(next_retry_at);
                """
            )

    def ensure_wallet(self, wallet_id: str, daily_budget_usd: float, max_cost_per_run_usd: float) -> None:
        now = int(time.time())
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO wallets(wallet_id, status, daily_budget_usd, max_cost_per_run_usd, spent_today_usd, spent_day, cooldown_until, last_run_at)
                VALUES(?, 'active', ?, ?, 0.0, ?, 0, 0)
                ON CONFLICT(wallet_id) DO NOTHING;
                """,
                (wallet_id, daily_budget_usd, max_cost_per_run_usd, day),
            )

    def list_wallets(self) -> list[WalletState]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM wallets ORDER BY wallet_id").fetchall()
        return [WalletState(**dict(r)) for r in rows]

    def get_wallet(self, wallet_id: str) -> WalletState | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM wallets WHERE wallet_id=?", (wallet_id,)).fetchone()
        return WalletState(**dict(row)) if row else None

    def refresh_daily_spent_if_needed(self, wallet_id: str) -> WalletState | None:
        now = int(time.time())
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        with self.connect() as conn:
            row = conn.execute("SELECT spent_day FROM wallets WHERE wallet_id=?", (wallet_id,)).fetchone()
            if not row:
                return None
            if row["spent_day"] != day:
                conn.execute(
                    "UPDATE wallets SET spent_today_usd=0.0, spent_day=? WHERE wallet_id=?",
                    (day, wallet_id),
                )
        return self.get_wallet(wallet_id)

    def add_spent(self, wallet_id: str, delta_usd: float) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE wallets SET spent_today_usd = spent_today_usd + ?, last_run_at=? WHERE wallet_id=?",
                (delta_usd, int(time.time()), wallet_id),
            )

    def set_wallet_status(self, wallet_id: str, status: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE wallets SET status=? WHERE wallet_id=?", (status, wallet_id))

    def set_cooldown(self, wallet_id: str, cooldown_until: int) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE wallets SET cooldown_until=? WHERE wallet_id=?", (cooldown_until, wallet_id))

    def get_circuit(self, channel: str) -> CircuitState:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM circuits WHERE channel=?", (channel,)).fetchone()
            if not row:
                conn.execute(
                    "INSERT INTO circuits(channel, failure_count, open_until) VALUES(?, 0, 0)",
                    (channel,),
                )
                return CircuitState(channel=channel, failure_count=0, open_until=0)
        return CircuitState(**dict(row))

    def update_circuit(self, channel: str, failure_count: int, open_until: int) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO circuits(channel, failure_count, open_until) VALUES(?, ?, ?)
                ON CONFLICT(channel) DO UPDATE SET failure_count=excluded.failure_count, open_until=excluded.open_until;
                """,
                (channel, failure_count, open_until),
            )

    def upsert_run_index(
        self,
        run_id: str,
        wallet_id: str,
        task_type: str,
        scheduled_bucket: int,
        attempt: int,
        notion_page_id: str | None,
    ) -> None:
        now = int(time.time())
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO runs_index(run_id, wallet_id, task_type, scheduled_bucket, attempt, notion_page_id, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET attempt=excluded.attempt, notion_page_id=COALESCE(excluded.notion_page_id, runs_index.notion_page_id), updated_at=excluded.updated_at;
                """,
                (run_id, wallet_id, task_type, scheduled_bucket, attempt, notion_page_id, now),
            )

    def get_run_index(self, wallet_id: str, task_type: str, scheduled_bucket: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM runs_index WHERE wallet_id=? AND task_type=? AND scheduled_bucket=?",
                (wallet_id, task_type, scheduled_bucket),
            ).fetchone()
        return dict(row) if row else None

    def enqueue_notion_outbox(self, run_id: str, payload: dict[str, Any], next_retry_at: int, attempt: int, last_error: str | None) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO notion_outbox(run_id, payload_json, next_retry_at, attempt, last_error) VALUES(?, ?, ?, ?, ?)",
                (run_id, json.dumps(payload, ensure_ascii=False), next_retry_at, attempt, last_error),
            )

    def pop_due_outbox(self, now: int, limit: int = 20) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM notion_outbox WHERE next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT ?",
                (now, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_outbox_item(self, item_id: int) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM notion_outbox WHERE id=?", (item_id,))

    def update_outbox_item(self, item_id: int, next_retry_at: int, attempt: int, last_error: str | None) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE notion_outbox SET next_retry_at=?, attempt=?, last_error=? WHERE id=?",
                (next_retry_at, attempt, last_error, item_id),
            )

