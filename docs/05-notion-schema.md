# Notion 表结构（Schema）与写入规范

## 核心表：Runs（事实表，必选）
用途：每次 run 一行（成功/失败都写），用于统计成功率、成本、耗时、渠道分布。

建议字段（属性名 -> 类型 -> 说明）：
- run_id -> Title(文本) -> 幂等键（建议：hash(wallet_id + task_type + scheduled_time_bucket + nonce)）
- created_at -> Date -> 运行开始时间
- wallet_id -> Select/文本 -> 钱包标识（不要写私钥/助记词）
- wallet_address -> 文本 -> 可选；建议脱敏或只存后缀
- task_type -> Select -> 任务类型
- schedule_type -> Select -> cron/random/retry
- attempt -> Number -> 重试第几次
- decision -> Select -> blockrun/fallback/deny
- channel -> Select -> blockrun/kimi
- model -> Select/文本 -> 实际模型/通道标识
- status -> Select -> success/failed/skipped
- latency_ms -> Number
- total_cost -> Number -> 统一成本口径（注明币种，如 USD）
- input_tokens -> Number -> 可选
- output_tokens -> Number -> 可选
- error_type -> Select -> network/upstream/validation/budget/unknown
- error_code -> 文本 -> 可选
- error_message -> 文本 -> 脱敏后的简述
- orchestrator_version -> 文本 -> 便于回溯
- executor_host -> 文本 -> 机器名（可选）

## 可选表：Wallets（状态表）
用途：预算、冷却、风险状态。
- wallet_id（主键）
- daily_budget
- spent_today
- last_run_at
- cooldown_until
- status（active/depleted/paused）
- notes

## 可选表：Errors（错误明细表）
用途：当 Runs 表不够放时记录更多上下文（仍需脱敏）。
- error_id（主键）
- run_id（关联）
- raw（严格脱敏后的结构化 JSON 字符串）

## 幂等与去重（必须）
- Runs 的 run_id 必须稳定可复算：同一任务同一 bucket 的重试应写同一 run_id，并通过 attempt 字段区分
- 若实现难以更新同一行：
  - 允许多行，但增加 idempotency_key 字段，并在统计时去重
  - 或先落本地状态（SQLite/文件）再补写 Notion

## 统计口径（建议）
- 成功率：success / (success + failed)
- 渠道分布：按 channel/model 分组
- 成本：sum(total_cost) 并按 wallet_id 分摊
- 耗时：p50/p95 latency_ms
