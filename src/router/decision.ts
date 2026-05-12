import type { CircuitRow, WalletRow } from "../state/repo"

export type DecisionResult =
  | { decision: "deny"; reason: string }
  | { decision: "blockrun" }

export function decide(wallet: WalletRow, circuit: CircuitRow, now: number): DecisionResult {
  if (wallet.status !== "active") return { decision: "deny", reason: `wallet_status:${wallet.status}` }
  if (wallet.cooldown_until && wallet.cooldown_until > now) return { decision: "deny", reason: "wallet_cooldown" }
  if (wallet.daily_budget_usd > 0 && wallet.spent_today_usd >= wallet.daily_budget_usd) return { decision: "deny", reason: "daily_budget_exhausted" }
  if (circuit.open_until && circuit.open_until > now) return { decision: "deny", reason: "channel_circuit_open" }
  return { decision: "blockrun" }
}

