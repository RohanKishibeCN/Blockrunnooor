from __future__ import annotations

from blockrunnooor.scheduler.utils import compute_backoff, make_run_id, scheduled_bucket


def test_scheduled_bucket():
    assert scheduled_bucket(0, 60) == 0
    assert scheduled_bucket(59, 60) == 0
    assert scheduled_bucket(60, 60) == 60
    assert scheduled_bucket(61, 60) == 60


def test_make_run_id_stable():
    a = make_run_id("w1", "t1", 123, "salt")
    b = make_run_id("w1", "t1", 123, "salt")
    c = make_run_id("w1", "t1", 124, "salt")
    assert a == b
    assert a != c


def test_compute_backoff_bounds():
    for attempt in range(1, 6):
        v = compute_backoff(2, attempt, 10)
        assert 0 <= v <= 10

