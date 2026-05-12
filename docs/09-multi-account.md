# 多账号（B 模式：共享 Notion Runs）设计与配置

目标：在同一个 orchestrator 进程中管理多个账号/业务分组，所有 run 写入同一个 Notion Runs 数据库，并通过 `account_id` 字段隔离筛选与统计。

## 1. 账号模型（B 模式）
- Notion：所有账号共享同一组 Notion 配置（`NOTION_TOKEN` + `NOTION_RUNS_DATABASE_ID`）
- 数据隔离：在 Runs 表中强制写入 `account_id` 字段，作为 Notion 侧筛选与统计的分区键
- 状态隔离：SQLite 中所有状态表均以 `account_id` 分区（wallets/circuits/runs_index/notion_outbox）

## 2. 目录与文件约定
- 账号配置目录：`BRNOO_ACCOUNTS_DIR`，默认建议 `/etc/blockrunnooor/accounts/`
  - 每个账号一个 JSON 文件：`<anything>.json`
  - orchestrator 启动时扫描目录，加载所有 JSON 文件
- 钱包清单：每个账号一份 jsonl（也可多账号复用同一个文件，但不推荐）
  - 例如：`/var/lib/blockrunnooor/wallets/manifest.<account_id>.jsonl`
- prompts：每个账号一份 jsonl（也可共享）
  - 例如：`/etc/blockrunnooor/prompts.<account_id>.jsonl`

## 3. 账号配置 JSON Schema（建议）

账号配置文件是一个 JSON 对象，字段建议如下（MVP 支持子集即可）：

```json
{
  "account_id": "default",
  "display_name": "default",

  "wallets_manifest_path": "/var/lib/blockrunnooor/wallets/manifest.default.jsonl",
  "prompts_file": "/etc/blockrunnooor/prompts.default.jsonl",

  "default_daily_budget_usd": 2.0,
  "default_max_cost_per_run_usd": 0.2,

  "status": "active",
  "tags": ["prod"]
}
```

字段说明：
- `account_id`：必填，建议仅使用 `[a-zA-Z0-9_-]`，用于：
  - Notion Runs 字段 `account_id`
  - SQLite 分区键（建议所有查询都带上）
- `display_name`：可选，便于日志与运维展示
- `wallets_manifest_path`：必填，该账号的钱包列表来源
- `prompts_file`：可选；为空时可改为从 env 的任务类型列表生成（但建议用 prompts.jsonl）
- `default_daily_budget_usd` / `default_max_cost_per_run_usd`：可选，作为新 wallet 初始化默认值
- `status`：可选，`active` / `paused`（paused 账号不调度但仍允许 outbox 清理）
- `tags`：可选，便于分组与排障

## 4. 钱包清单 jsonl 格式（建议）

每行一个 JSON，对应一个钱包。建议字段：

```json
{"wallet_id":"wallet_default_0001","address":"0xabc...","secret_ref":"file:/var/lib/blockrunnooor/secrets/wallet_default_0001.pk","created_at":1710000000}
```

字段说明：
- `wallet_id`：必填，账号内唯一即可；建议带 `account_id` 前缀降低撞名风险
- `address`：可选，用于 Notion 记录或运维；建议脱敏展示
- `secret_ref`：可选，引用密钥来源，见下一节

## 5. 密钥与 token 引用规则（ref 机制）

约束：SQLite 不存任何明文 token/私钥；所有敏感信息仅通过 ref 间接引用。

建议支持两种 ref：
- `env:<ENV_NAME>`：从环境变量读取
- `file:<ABS_PATH>`：从绝对路径文件读取（文件权限建议 600，目录 700）

示例：
- Notion token：`env:NOTION_TOKEN`
- 钱包私钥：`file:/var/lib/blockrunnooor/secrets/wallet_default_0001.pk`

ref 解析规则建议：
- 只允许 `env:` 与 `file:` 两种 scheme
- `file:` 只允许绝对路径，读取时 trim 空白
- 读取失败时视为该 run 的失败（error_type=validation），并记录脱敏错误信息

## 6. Notion Runs 表字段要求（B 模式）

在 `docs/05-notion-schema.md` 的基础上，B 模式必须新增/确保以下字段存在：
- `account_id`（Select 或 Text）：必填

建议 Notion 侧增加两个视图：
- 按 `account_id` 过滤的视图（每个账号一个）
- 按 `account_id + status` 分组的统计视图

## 7. 并发与预算的优先级（建议）

并发与预算建议按三层约束：
- 全局：保护 VPS 资源，避免打满
- 账号：避免某账号挤占资源
- 钱包：默认单钱包不并发（通常为 1）

预算建议按两层约束：
- 每钱包每日预算（daily_budget_usd）
- 每钱包单次上限（max_cost_per_run_usd）

## 8. SQLite 表的 account_id 约束

建议所有状态表都带 `account_id`：
- `wallets.account_id`
- `circuits` 复合主键 `(account_id, channel)`
- `runs_index.account_id`
- `notion_outbox.account_id`

运维查询示例见 `docs/08-operations-manual.md`。
