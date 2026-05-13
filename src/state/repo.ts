import type { DB } from "./db"

export type AccountRow = {
  account_id: string
  status: string
  display_name: string | null
  created_at: number
  updated_at: number
}

export type WalletRow = {
  wallet_id: string
  account_id: string
  status: string
  daily_budget_usd: number
  max_cost_per_run_usd: number
  spent_today_usd: number
  spent_day: string
  cooldown_until: number
  last_run_at: number
  address: string | null
  secret_ref: string | null
}

export type CircuitRow = {
  account_id: string
  channel: string
  failure_count: number
  open_until: number
}

export type RunIndexRow = {
  run_id: string
  account_id: string
  wallet_id: string
  task_type: string
  scheduled_bucket: number
  attempt: number
  notion_page_id: string | null
  updated_at: number
}

export type OutboxRow = {
  id: number
  account_id: string
  run_id: string
  payload_json: string
  next_retry_at: number
  attempt: number
  last_error: string | null
}

export class StateRepo {
  constructor(private readonly db: DB) {}

  upsertAccount(accountId: string, status: string, displayName: string | undefined, now: number): void {
    this.db
      .prepare(
        `
INSERT INTO accounts(account_id, status, display_name, created_at, updated_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(account_id) DO UPDATE SET status=excluded.status, display_name=COALESCE(excluded.display_name, accounts.display_name), updated_at=excluded.updated_at
`
      )
      .run(accountId, status, displayName ?? null, now, now)
  }

  listWallets(accountId: string): WalletRow[] {
    return this.db
      .prepare("SELECT * FROM wallets WHERE account_id=? ORDER BY wallet_id")
      .all(accountId) as WalletRow[]
  }

  ensureWallet(accountId: string, walletId: string, dailyBudgetUsd: number, maxCostPerRunUsd: number, day: string): void {
    this.db
      .prepare(
        `
INSERT INTO wallets(wallet_id, account_id, status, daily_budget_usd, max_cost_per_run_usd, spent_today_usd, spent_day, cooldown_until, last_run_at, address, secret_ref)
VALUES(?, ?, 'active', ?, ?, 0.0, ?, 0, 0, NULL, NULL)
ON CONFLICT(wallet_id) DO NOTHING
`
      )
      .run(walletId, accountId, dailyBudgetUsd, maxCostPerRunUsd, day)
  }

  updateWalletIdentity(accountId: string, walletId: string, address: string | undefined, secretRef: string | undefined): void {
    this.db
      .prepare("UPDATE wallets SET address=COALESCE(?, address), secret_ref=COALESCE(?, secret_ref) WHERE account_id=? AND wallet_id=?")
      .run(address ?? null, secretRef ?? null, accountId, walletId)
  }

  refreshDailySpentIfNeeded(accountId: string, walletId: string, day: string): WalletRow | null {
    const row = this.db
      .prepare("SELECT spent_day FROM wallets WHERE account_id=? AND wallet_id=?")
      .get(accountId, walletId) as { spent_day?: string } | undefined
    if (!row?.spent_day) return null
    if (row.spent_day !== day) {
      this.db
        .prepare("UPDATE wallets SET spent_today_usd=0.0, spent_day=? WHERE account_id=? AND wallet_id=?")
        .run(day, accountId, walletId)
    }
    return this.getWallet(accountId, walletId)
  }

  getWallet(accountId: string, walletId: string): WalletRow | null {
    const row = this.db
      .prepare("SELECT * FROM wallets WHERE account_id=? AND wallet_id=?")
      .get(accountId, walletId) as WalletRow | undefined
    return row ?? null
  }

  addSpent(accountId: string, walletId: string, deltaUsd: number, now: number): void {
    this.db
      .prepare("UPDATE wallets SET spent_today_usd = spent_today_usd + ?, last_run_at=? WHERE account_id=? AND wallet_id=?")
      .run(deltaUsd, now, accountId, walletId)
  }

  touchWalletLastRun(accountId: string, walletId: string, now: number): void {
    this.db.prepare("UPDATE wallets SET last_run_at=? WHERE account_id=? AND wallet_id=?").run(now, accountId, walletId)
  }

  setCooldown(accountId: string, walletId: string, cooldownUntil: number): void {
    this.db.prepare("UPDATE wallets SET cooldown_until=? WHERE account_id=? AND wallet_id=?").run(cooldownUntil, accountId, walletId)
  }

  getCircuit(accountId: string, channel: string): CircuitRow {
    const row = this.db.prepare("SELECT * FROM circuits WHERE account_id=? AND channel=?").get(accountId, channel) as CircuitRow | undefined
    if (row) return row
    this.db.prepare("INSERT INTO circuits(account_id, channel, failure_count, open_until) VALUES(?, ?, 0, 0)").run(accountId, channel)
    return { account_id: accountId, channel, failure_count: 0, open_until: 0 }
  }

  upsertCircuit(accountId: string, channel: string, failureCount: number, openUntil: number): void {
    this.db
      .prepare(
        `
INSERT INTO circuits(account_id, channel, failure_count, open_until)
VALUES(?, ?, ?, ?)
ON CONFLICT(account_id, channel) DO UPDATE SET failure_count=excluded.failure_count, open_until=excluded.open_until
`
      )
      .run(accountId, channel, failureCount, openUntil)
  }

  getRunIndex(accountId: string, walletId: string, taskType: string, scheduledBucket: number): RunIndexRow | null {
    const row = this.db
      .prepare("SELECT * FROM runs_index WHERE account_id=? AND wallet_id=? AND task_type=? AND scheduled_bucket=?")
      .get(accountId, walletId, taskType, scheduledBucket) as RunIndexRow | undefined
    return row ?? null
  }

  upsertRunIndex(
    runId: string,
    accountId: string,
    walletId: string,
    taskType: string,
    scheduledBucket: number,
    attempt: number,
    notionPageId: string | null,
    updatedAt: number
  ): void {
    this.db
      .prepare(
        `
INSERT INTO runs_index(run_id, account_id, wallet_id, task_type, scheduled_bucket, attempt, notion_page_id, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(run_id) DO UPDATE SET attempt=excluded.attempt, notion_page_id=COALESCE(excluded.notion_page_id, runs_index.notion_page_id), updated_at=excluded.updated_at
`
      )
      .run(runId, accountId, walletId, taskType, scheduledBucket, attempt, notionPageId, updatedAt)
  }

  enqueueOutbox(accountId: string, runId: string, payloadJson: string, nextRetryAt: number, attempt: number, lastError: string | null): void {
    this.db
      .prepare(
        "INSERT INTO notion_outbox(account_id, run_id, payload_json, next_retry_at, attempt, last_error) VALUES(?, ?, ?, ?, ?, ?)"
      )
      .run(accountId, runId, payloadJson, nextRetryAt, attempt, lastError)
  }

  popDueOutbox(accountId: string, now: number, limit: number): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM notion_outbox WHERE account_id=? AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT ?")
      .all(accountId, now, limit) as OutboxRow[]
  }

  deleteOutboxItem(id: number): void {
    this.db.prepare("DELETE FROM notion_outbox WHERE id=?").run(id)
  }

  updateOutboxItem(id: number, nextRetryAt: number, attempt: number, lastError: string | null): void {
    this.db.prepare("UPDATE notion_outbox SET next_retry_at=?, attempt=?, last_error=? WHERE id=?").run(nextRetryAt, attempt, lastError, id)
  }
}
