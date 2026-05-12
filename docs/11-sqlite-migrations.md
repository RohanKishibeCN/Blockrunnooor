# SQLite 初始化与迁移策略（建议）

目标：保证 schema 可演进、可幂等执行、可回滚排障，且不依赖外部迁移工具。

## 1. 总原则
- 迁移必须幂等：同一迁移重复执行不应报错或破坏数据
- 启动时自动迁移：orchestrator 启动后先跑 migrations，再进入调度循环
- 迁移必须可追踪：SQLite 内记录已执行的迁移版本

## 2. schema_migrations 表

建议新增：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

规则：
- `version` 单调递增（例如 1, 2, 3...）
- 每个版本对应一段 SQL（或一组语句）
- 执行成功后插入一行记录

## 3. V1（多账号 B 模式）基础 schema

V1 目标：把所有状态表增加 `account_id` 分区能力，并为 outbox/circuit/runs_index 建立必要索引。

建议的 V1 schema（示例，实际以代码实现为准）：

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

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
```

## 4. 从旧 schema 迁移（如果已有 Python 版本数据）

如果你已有旧的 `state.db`（无 account_id）并希望继承历史数据，建议策略：
- 新建一套新库（推荐）：避免复杂 ALTER TABLE，排障更简单
- 或者做一次性迁移：
  - 新建带 account_id 的新表（wallets_v2 等）
  - 把旧表数据全量复制进新表，并把 `account_id` 统一填 `default`
  - rename 替换旧表

## 5. 迁移执行建议（代码层）

建议实现一个 migrate 函数：
- 开启 transaction
- 读 `schema_migrations` 得到当前版本
- 逐个执行缺失版本的 SQL
- 成功后写入 `schema_migrations`
- commit

约束：
- 迁移期间不要并发访问数据库
- 任一版本失败要 rollback 并退出进程（让 pm2 自动重启，避免半迁移状态继续跑）
