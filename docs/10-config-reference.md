# 配置参考（Node.js / TypeScript）

本文给出环境变量与配置文件的完整清单，以及优先级规则。

## 1. 优先级规则

从高到低：
1. `.env` / `BRNOO_ENV_FILE` 加载后的环境变量（process.env）
2. 账号配置（`BRNOO_ACCOUNTS_JSON` 或 `BRNOO_ACCOUNTS_DIR/*.json`）
3. 代码默认值

说明：
- Notion（B 模式）为全局配置：账号配置文件不应包含 Notion token/database 字段
- 账号配置文件只管理该账号的钱包集合与默认预算等“账号域”信息

## 2. 全局环境变量（必填）

- `BRNOO_ENV_FILE`
  - 可选；env 文件路径，例如 `/etc/blockrunnooor/blockrunnooor.env`
- `BRNOO_STATE_DB_PATH`
  - SQLite 路径，例如 `/var/lib/blockrunnooor/state/state.db`
- `BRNOO_ACCOUNTS_DIR` 或 `BRNOO_ACCOUNTS_JSON`
  - 二选一
  - `BRNOO_ACCOUNTS_DIR`：账号配置目录，例如 `/etc/blockrunnooor/accounts`
  - `BRNOO_ACCOUNTS_JSON`：JSON 数组字符串（单行），用于把账号配置也集中到 env 文件里
- `BRNOO_RUN_ID_SALT`
  - 生成 run_id 的盐（不要泄漏）
- `BRNOO_BLOCKRUN_MODEL`
  - 全局单模型配置；每次 run 都使用该模型 id（例如 `deepseek/deepseek-chat`、`openai/gpt-5.5`、`nvidia/gpt-oss-120b`）
- `BRNOO_BLOCKRUN_MODELS_FREE`
  - 可选；逗号分隔的免费模型池（例如 `nvidia/gpt-oss-120b,nvidia/deepseek-v4-flash`）
  - 当 prompt 的 `model` 为空或为 `random` 时，会按池子随机选模型
- `BRNOO_BLOCKRUN_MODELS_PAID`
  - 可选；逗号分隔的付费模型池（例如 `deepseek/deepseek-chat,openai/gpt-5.4-nano`）
- `BRNOO_BLOCKRUN_PAID_RATIO`
  - 可选；当 `model=random` 时，从付费池取模型的概率（0~1，例如 `0.5`）
- `BRNOO_TASK_KIND_WEIGHTS`
  - 可选；任务类型权重（例如 `chat=40,surf=20,predexon=20,markets=20`）
- `BLOCKRUN_API_URL`
  - 例如 `https://blockrun.ai/api`
- `BLOCKRUN_CHAT_PATH`
  - 例如 `/v1/chat/completions`
  - 兼容保留：接入 BlockRun 官方 TypeScript SDK 后不再依赖该字段，但当前仍建议保留配置以便回滚
- `BLOCKRUN_TIMEOUT_SECONDS`
  - 例如 `30`

## 3. 全局环境变量（可选）

调度：
- `BRNOO_BASE_INTERVAL_SECONDS`：每个钱包的目标执行间隔（秒）
- `BRNOO_JITTER_MAX_SECONDS`：抖动上限（秒），用于错峰
- `BRNOO_BUCKET_SECONDS`：幂等桶大小（秒），同一 bucket 重试复用 run_id
- `BRNOO_SCHEDULER_POLL_SECONDS`：调度轮询间隔（秒），默认 5
- `BRNOO_WALLET_ORDER`：钱包触发顺序（`sequential` / `random`）

并发：
- `BRNOO_GLOBAL_MAX_CONCURRENCY`
- `BRNOO_PER_ACCOUNT_MAX_CONCURRENCY`
- `BRNOO_PER_WALLET_MAX_CONCURRENCY`

重试：
- `BRNOO_MAX_ATTEMPTS`
- `BRNOO_BACKOFF_BASE_SECONDS`
- `BRNOO_BACKOFF_MAX_SECONDS`

冷却/熔断：
- `BRNOO_WALLET_FAILURE_THRESHOLD`
- `BRNOO_WALLET_COOLDOWN_SECONDS`
- `BRNOO_CIRCUIT_FAILURE_THRESHOLD`
- `BRNOO_CIRCUIT_OPEN_SECONDS`

Notion（可选）：
- `NOTION_TOKEN`
- `NOTION_RUNS_DATABASE_ID`
- `NOTION_TIMEOUT_SECONDS`
- `NOTION_RETRY_BACKOFF_BASE_SECONDS`：Notion 写入失败的重试退避基数（默认 2）
- `NOTION_RETRY_BACKOFF_MAX_SECONDS`：Notion 写入失败的重试退避最大秒数（默认 300）

日志：
- `BRNOO_LOG_LEVEL`

## 4. 账号配置字段（`accounts/*.json`）

必填：
- `account_id`
- `wallets_manifest_path`

常用可选：
- `display_name`
- `prompts_file`
- `default_daily_budget_usd`
- `default_max_cost_per_run_usd`
- `status`：`active` / `paused`
- `tags`

## 5. 建议的 pm2 注入方式

推荐把全局 env 放进 pm2 ecosystem 配置：
- `BRNOO_STATE_DB_PATH`
- `BRNOO_ACCOUNTS_DIR`
- `BRNOO_RUN_ID_SALT`
- `BRNOO_BLOCKRUN_MODEL`
- `BLOCKRUN_API_URL` / `BLOCKRUN_CHAT_PATH` / `BLOCKRUN_TIMEOUT_SECONDS`
- Notion（如启用）：`NOTION_TOKEN` / `NOTION_RUNS_DATABASE_ID`

账号差异通过 `accounts/*.json` 提供，不通过 pm2 env 做 N 套变量。
