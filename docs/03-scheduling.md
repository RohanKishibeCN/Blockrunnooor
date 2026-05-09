# 调度

## 调度目标
- 避免整点洪峰：引入抖动（jitter）与随机触发
- 控制并发：全局并发上限 + 按钱包并发上限（通常为 1）
- 可恢复：失败重试 + 退避 + 熔断
- 可解释：每次 run 的为什么此刻触发/为何重试/为何降级可记录

## 策略建议
- 定时触发：基础周期，例如每钱包每 X 分钟一次
- 抖动：在 `[0, JITTER_MAX_SECONDS]` 内随机延迟
- 随机触发：在低负载窗口额外补点（但仍受预算/并发限制）
- 并发上限：
  - global_max_concurrency：例如 5/10
  - per_wallet_max_concurrency：通常 1
- 失败重试：
  - max_attempts：例如 3
  - backoff：指数退避（如 2s/4s/8s）+ 随机扰动
- 熔断：
  - BlockRun 连续失败 N 次后熔断 T 秒
  - fallback 连续失败 N 次后同样熔断或暂停该类任务

## 风控与限速
- 每钱包 QPS 限制（例如 0.1~0.2）
- 全局 QPS 限制（避免触发上游风控）
- 任务类型分级：高风险/高成本任务更保守调度

## 记录字段（建议）
- schedule_type：cron / random / retry
- jitter_seconds：本次抖动值
- attempt：第几次尝试
- backoff_seconds：本次退避
- concurrency_snapshot：触发时并发占用
