from __future__ import annotations

import hashlib
import random
import time


def now_epoch() -> int:
    return int(time.time())


def scheduled_bucket(ts: int, bucket_seconds: int) -> int:
    if bucket_seconds <= 0:
        return ts
    return ts - (ts % bucket_seconds)


def make_run_id(wallet_id: str, task_type: str, bucket: int, salt: str) -> str:
    h = hashlib.sha256()
    h.update(wallet_id.encode("utf-8"))
    h.update(b"\n")
    h.update(task_type.encode("utf-8"))
    h.update(b"\n")
    h.update(str(bucket).encode("utf-8"))
    h.update(b"\n")
    h.update(salt.encode("utf-8"))
    return h.hexdigest()


def pick_jitter(max_seconds: int) -> int:
    if max_seconds <= 0:
        return 0
    return random.randint(0, max_seconds)


def compute_backoff(base_seconds: int, attempt: int, max_seconds: int) -> int:
    if attempt <= 1:
        raw = base_seconds
    else:
        raw = base_seconds * (2 ** (attempt - 1))
    jitter = random.random()
    val = int(min(raw + jitter, max_seconds))
    return max(val, 0)

