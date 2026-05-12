# 架构

## 组件边界
- Orchestrator（常驻）
  - 加载账号配置（多账号共享同一套 Notion Runs 表，但用 account_id 区分）
  - 生成/拉取待执行任务（按钱包、按策略）
  - 并发控制（全局与按钱包）
  - 重试与退避、熔断、限速
  - 统一记录：Notion 写入与日志脱敏
- Task Runner / Executor（可选）
  - MVP 可与 Orchestrator 同进程实现（直接执行一次 run）
  - 若需要更强隔离，可演进为 worker_threads 或子进程 job
- Secrets Store（密钥存储）
  - 仅由 orchestrator 读取/解密或按需下发短期凭据
  - 文件系统权限/加密/轮换/备份策略
- Router（逻辑模块）
  - 统一决策：何时 BlockRun、何时 fallback、何时禁止
  - 统一记录字段：channel/model/cost/error
- Notion Recorder
  - Runs 表为事实来源
  - 幂等键：防止重试产生重复行
  - 最小写入：避免泄漏敏感数据

## 账号边界（多账号但共用 Notion Runs）
- 同一个 Orchestrator 进程可同时管理多个账号（account_id）
- 每个账号拥有独立的：
  - 钱包集合（manifest 或其他来源）
  - 调度状态（cooldown/失败计数/熔断）
  - 预算与阈值（每日预算、单次上限、重试策略）
- Notion 写入共享同一个 Runs 数据库，但必须写入 `account_id` 字段，保证可筛选/可统计

## 数据流（建议）
1. orchestrator 先确定 account_id，再按调度策略选择 wallet_id + 任务类型
2. orchestrator 执行一次 run（同进程/worker/job 均可），传入最小上下文（不直接传私钥明文）
3. Router 决策：blockrun / fallback / deny
4. 执行调用，收集成本/耗时/错误并脱敏
5. Notion Recorder 写 Runs（成功/失败均写；失败可进入 outbox 重试）
6. orchestrator 汇总成功率、错误分布、成本分布并告警（可选）

## 失败隔离
- 单钱包连续失败触发冷却（cooldown），不影响其他钱包
- 单通道（BlockRun 或 Kimi）故障触发熔断/降级
- Notion 写入失败：本地队列/重试（但保持幂等）
