from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

from ..config import Settings
from ..logging import get_logger, log_event
from ..models import ExecutorInput, ExecutorOutput, NotionRunRecord, ScheduleType
from ..notion.client import backoff_seconds
from ..notion.recorder import NotionRecorder, log_notion_result
from ..router.decision import decide
from ..scheduler.utils import compute_backoff, make_run_id, now_epoch, pick_jitter, scheduled_bucket
from ..state.db import StateDB


@dataclass(frozen=True)
class TaskSpec:
    wallet_id: str
    task_type: str
    schedule_type: ScheduleType
    scheduled_at: int
    jitter_seconds: int
    attempt: int
    backoff_seconds: int


class Orchestrator:
    def __init__(self, settings: Settings):
        self._s = settings
        self._logger = get_logger("orchestrator")
        self._db = StateDB(settings.brnoo_state_db_path)
        self._db.init()
        self._global_sem = asyncio.Semaphore(settings.brnoo_global_max_concurrency)
        self._wallet_locks: dict[str, asyncio.Semaphore] = {}
        self._wallet_failures: dict[str, int] = {}
        self._running = True

        for wid in settings.wallet_id_list():
            self._db.ensure_wallet(wid, settings.brnoo_default_daily_budget_usd, settings.brnoo_default_max_cost_per_run_usd)

        self._notion: NotionRecorder | None = None
        if settings.notion_token and settings.notion_runs_database_id:
            self._notion = NotionRecorder(
                token=settings.notion_token,
                runs_database_id=settings.notion_runs_database_id,
                timeout_seconds=settings.notion_timeout_seconds,
                state_db=self._db,
            )

    async def run_forever(self) -> None:
        log_event(self._logger, logging.INFO, "orchestrator_start", version=self._s.brnoo_orchestrator_version)
        schedule_task = asyncio.create_task(self._schedule_loop())
        outbox_task = asyncio.create_task(self._outbox_loop())
        try:
            await asyncio.gather(schedule_task, outbox_task)
        except asyncio.CancelledError:
            raise
        finally:
            self._running = False

    def _wallet_sem(self, wallet_id: str) -> asyncio.Semaphore:
        sem = self._wallet_locks.get(wallet_id)
        if sem is None:
            sem = asyncio.Semaphore(self._s.brnoo_per_wallet_max_concurrency)
            self._wallet_locks[wallet_id] = sem
        return sem

    async def _schedule_loop(self) -> None:
        while self._running:
            tick_start = now_epoch()
            wallets = self._db.list_wallets()
            for w in wallets:
                self._db.refresh_daily_spent_if_needed(w.wallet_id)

            for wallet in wallets:
                for task_type in self._s.task_type_list():
                    jitter = pick_jitter(self._s.brnoo_jitter_max_seconds)
                    scheduled_at = tick_start + jitter
                    spec = TaskSpec(
                        wallet_id=wallet.wallet_id,
                        task_type=task_type,
                        schedule_type="cron",
                        scheduled_at=scheduled_at,
                        jitter_seconds=jitter,
                        attempt=1,
                        backoff_seconds=0,
                    )
                    asyncio.create_task(self._delayed_run(spec))

            elapsed = now_epoch() - tick_start
            sleep_for = max(0, self._s.brnoo_base_interval_seconds - elapsed)
            await asyncio.sleep(sleep_for)

    async def _delayed_run(self, spec: TaskSpec) -> None:
        delay = max(0, spec.scheduled_at - now_epoch())
        if delay:
            await asyncio.sleep(delay)
        await self._run_once(spec)

    async def _run_once(self, spec: TaskSpec) -> None:
        now = now_epoch()
        wallet = self._db.refresh_daily_spent_if_needed(spec.wallet_id)
        if not wallet:
            return

        circuit = self._db.get_circuit("blockrun")
        dec = decide(wallet, circuit, now)
        bucket = scheduled_bucket(spec.scheduled_at, self._s.brnoo_base_interval_seconds)
        run_id = make_run_id(spec.wallet_id, spec.task_type, bucket, self._s.brnoo_run_id_salt)

        idx = self._db.get_run_index(spec.wallet_id, spec.task_type, bucket)
        attempt = idx["attempt"] + 1 if idx and idx.get("run_id") == run_id and spec.schedule_type == "retry" else spec.attempt

        if dec.decision == "deny":
            out = ExecutorOutput(
                run_id=run_id,
                wallet_id=spec.wallet_id,
                task_type=spec.task_type,
                attempt=attempt,
                decision="deny",
                channel="blockrun",
                model=None,
                status="skipped",
                latency_ms=0,
                total_cost=None,
                input_tokens=None,
                output_tokens=None,
                request_id=None,
                error_type="budget" if "budget" in (dec.reason or "") else "unknown",
                error_code=dec.reason,
                error_message=dec.reason,
            )
            self._db.upsert_run_index(run_id, spec.wallet_id, spec.task_type, bucket, attempt, idx.get("notion_page_id") if idx else None)
            await self._record_and_update(spec, out, bucket)
            return

        async with self._global_sem, self._wallet_sem(spec.wallet_id):
            self._db.upsert_run_index(run_id, spec.wallet_id, spec.task_type, bucket, attempt, idx.get("notion_page_id") if idx else None)
            out = await self._spawn_executor(
                ExecutorInput(
                    wallet_id=spec.wallet_id,
                    task_type=spec.task_type,
                    run_id=run_id,
                    attempt=attempt,
                    schedule_type=spec.schedule_type,
                    jitter_seconds=spec.jitter_seconds,
                    backoff_seconds=spec.backoff_seconds,
                    blockrun_path=None,
                    blockrun_json={"wallet_id": spec.wallet_id, "task_type": spec.task_type},
                )
            )
            await self._record_and_update(spec, out, bucket)

            if out.status == "success":
                self._wallet_failures[spec.wallet_id] = 0
                if out.total_cost is not None:
                    self._db.add_spent(spec.wallet_id, float(out.total_cost))
                self._db.update_circuit("blockrun", failure_count=0, open_until=0)
                return

            failures = self._wallet_failures.get(spec.wallet_id, 0) + 1
            self._wallet_failures[spec.wallet_id] = failures
            circuit_state = self._db.get_circuit("blockrun")
            self._db.update_circuit("blockrun", failure_count=circuit_state.failure_count + 1, open_until=circuit_state.open_until)

            if failures >= 3:
                self._db.set_cooldown(spec.wallet_id, now + self._s.brnoo_wallet_cooldown_seconds)

            if circuit_state.failure_count + 1 >= 5:
                self._db.update_circuit("blockrun", failure_count=0, open_until=now + 300)

            if attempt < self._s.brnoo_max_attempts and out.error_type in ("network", "upstream", "rate_limit"):
                bo = compute_backoff(self._s.brnoo_backoff_base_seconds, attempt, self._s.brnoo_backoff_max_seconds)
                retry_spec = TaskSpec(
                    wallet_id=spec.wallet_id,
                    task_type=spec.task_type,
                    schedule_type="retry",
                    scheduled_at=now + bo,
                    jitter_seconds=0,
                    attempt=attempt + 1,
                    backoff_seconds=bo,
                )
                asyncio.create_task(self._delayed_run(retry_spec))

    async def _spawn_executor(self, inp: ExecutorInput) -> ExecutorOutput:
        logger = self._logger
        cmd = self._s.brnoo_executor_path
        if not cmd:
            raise RuntimeError("executor path not configured")

        args = cmd.split(" ")
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ},
        )
        assert proc.stdin is not None
        assert proc.stdout is not None

        proc.stdin.write(inp.model_dump_json().encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=self._s.brnoo_executor_timeout_seconds)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            log_event(logger, logging.ERROR, "executor_timeout", wallet_id=inp.wallet_id, run_id=inp.run_id)
            return ExecutorOutput(
                run_id=inp.run_id,
                wallet_id=inp.wallet_id,
                task_type=inp.task_type,
                attempt=inp.attempt,
                decision="blockrun",
                channel="blockrun",
                model=None,
                status="failed",
                latency_ms=self._s.brnoo_executor_timeout_seconds * 1000,
                total_cost=None,
                input_tokens=None,
                output_tokens=None,
                request_id=None,
                error_type="network",
                error_code="executor_timeout",
                error_message="executor_timeout",
            )

        if stderr_b:
            log_event(
                logger,
                logging.WARNING,
                "executor_stderr",
                wallet_id=inp.wallet_id,
                run_id=inp.run_id,
                stderr=stderr_b.decode("utf-8", errors="replace")[:200],
            )

        try:
            data = json.loads(stdout_b.decode("utf-8"))
            return ExecutorOutput.model_validate(data)
        except Exception as e:
            log_event(logger, logging.ERROR, "executor_output_error", wallet_id=inp.wallet_id, run_id=inp.run_id, error=str(e)[:200])
            return ExecutorOutput(
                run_id=inp.run_id,
                wallet_id=inp.wallet_id,
                task_type=inp.task_type,
                attempt=inp.attempt,
                decision="blockrun",
                channel="blockrun",
                model=None,
                status="failed",
                latency_ms=0,
                total_cost=None,
                input_tokens=None,
                output_tokens=None,
                request_id=None,
                error_type="unknown",
                error_code="bad_executor_output",
                error_message="bad_executor_output",
            )

    async def _record_and_update(self, spec: TaskSpec, out: ExecutorOutput, bucket: int) -> None:
        rec = NotionRunRecord(
            run_id=out.run_id,
            created_at=out.created_at,
            wallet_id=out.wallet_id,
            task_type=out.task_type,
            schedule_type=spec.schedule_type,
            attempt=out.attempt,
            decision=out.decision,
            channel=out.channel,
            model=out.model,
            status=out.status,
            latency_ms=out.latency_ms,
            total_cost=out.total_cost,
            input_tokens=out.input_tokens,
            output_tokens=out.output_tokens,
            error_type=out.error_type,
            error_code=out.error_code,
            error_message=out.error_message,
            orchestrator_version=self._s.brnoo_orchestrator_version,
            request_id=out.request_id,
        )

        if not self._notion:
            log_event(self._logger, logging.INFO, "run_record", run_id=out.run_id, wallet_id=out.wallet_id, status=out.status)
            return

        res = self._notion.upsert_run(rec)
        log_notion_result(self._logger, out.run_id, res)
        if res.ok and res.page_id:
            self._db.upsert_run_index(out.run_id, out.wallet_id, out.task_type, bucket, out.attempt, res.page_id)
            return

        if not res.ok and res.retryable:
            now = now_epoch()
            next_retry = now + backoff_seconds(2, 1, 60)
            self._db.enqueue_notion_outbox(out.run_id, rec.model_dump(mode="json"), next_retry, 1, res.error)

    async def _outbox_loop(self) -> None:
        if not self._notion:
            while self._running:
                await asyncio.sleep(60)
            return

        while self._running:
            now = now_epoch()
            items = self._db.pop_due_outbox(now)
            if not items:
                await asyncio.sleep(5)
                continue

            for item in items:
                item_id = int(item["id"])
                run_id = item["run_id"]
                attempt = int(item["attempt"])
                payload_json = item["payload_json"]
                try:
                    rec = NotionRunRecord.model_validate(json.loads(payload_json))
                except Exception:
                    self._db.delete_outbox_item(item_id)
                    continue

                res = self._notion.upsert_run(rec)
                log_notion_result(self._logger, run_id, res)
                if res.ok:
                    self._db.delete_outbox_item(item_id)
                    continue

                next_retry = now + backoff_seconds(2, attempt + 1, 300)
                self._db.update_outbox_item(item_id, next_retry_at=next_retry, attempt=attempt + 1, last_error=res.error)
