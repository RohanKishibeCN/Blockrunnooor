import type { DB } from "./db"

export type Migration = {
  version: number
  sql: string
}

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  daily_budget_usd REAL NOT NULL,
  max_cost_per_run_usd REAL NOT NULL,
  spent_today_usd REAL NOT NULL,
  spent_day TEXT NOT NULL,
  cooldown_until INTEGER NOT NULL,
  last_run_at INTEGER NOT NULL,
  address TEXT,
  secret_ref TEXT
);

CREATE INDEX IF NOT EXISTS idx_wallets_account
ON wallets(account_id, wallet_id);

CREATE TABLE IF NOT EXISTS circuits (
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  open_until INTEGER NOT NULL,
  PRIMARY KEY (account_id, channel)
);

CREATE TABLE IF NOT EXISTS runs_index (
  run_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  scheduled_bucket INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  notion_page_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_lookup
ON runs_index(account_id, wallet_id, task_type, scheduled_bucket);

CREATE TABLE IF NOT EXISTS notion_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  next_retry_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_retry
ON notion_outbox(account_id, next_retry_at);
`
  }
]

export function applyMigrations(db: DB, nowEpoch: number): void {
  db.exec("BEGIN")
  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`)
    const cur = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get() as { version?: number } | undefined
    const current = typeof cur?.version === "number" ? cur.version : 0
    const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
    for (const m of pending) {
      db.exec(m.sql)
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(m.version, nowEpoch)
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}
