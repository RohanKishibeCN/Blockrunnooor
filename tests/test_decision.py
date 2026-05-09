from __future__ import annotations

from blockrunnooor.router.decision import decide
from blockrunnooor.state.db import CircuitState, WalletState


def test_decide_budget_exhausted():
    wallet = WalletState(
        wallet_id="w1",
        status="active",
        daily_budget_usd=1.0,
        max_cost_per_run_usd=0.1,
        spent_today_usd=1.0,
        spent_day="2026-01-01",
        cooldown_until=0,
        last_run_at=0,
    )
    circuit = CircuitState(channel="blockrun", failure_count=0, open_until=0)
    res = decide(wallet, circuit, now=0)
    assert res.decision == "deny"


def test_decide_circuit_open():
    wallet = WalletState(
        wallet_id="w1",
        status="active",
        daily_budget_usd=1.0,
        max_cost_per_run_usd=0.1,
        spent_today_usd=0.0,
        spent_day="2026-01-01",
        cooldown_until=0,
        last_run_at=0,
    )
    circuit = CircuitState(channel="blockrun", failure_count=10, open_until=10)
    res = decide(wallet, circuit, now=0)
    assert res.decision == "deny"

