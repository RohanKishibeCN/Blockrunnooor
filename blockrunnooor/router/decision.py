from __future__ import annotations

from dataclasses import dataclass

from ..models import Decision
from ..state.db import CircuitState, WalletState


@dataclass(frozen=True)
class DecisionResult:
    decision: Decision
    reason: str | None = None


def decide(wallet: WalletState, circuit: CircuitState, now: int) -> DecisionResult:
    if wallet.status != "active":
        return DecisionResult(decision="deny", reason=f"wallet_status:{wallet.status}")
    if wallet.cooldown_until and wallet.cooldown_until > now:
        return DecisionResult(decision="deny", reason="wallet_cooldown")
    if wallet.spent_today_usd >= wallet.daily_budget_usd and wallet.daily_budget_usd > 0:
        return DecisionResult(decision="deny", reason="daily_budget_exhausted")
    if circuit.open_until and circuit.open_until > now:
        return DecisionResult(decision="deny", reason="channel_circuit_open")
    return DecisionResult(decision="blockrun", reason=None)

