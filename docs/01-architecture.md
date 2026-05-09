# 架构

## 组件边界
- Orchestrator（常驻）
  - 生成/拉取待执行任务（按钱包、按策略）
  - 并发控制（全局与按钱包）
  - 重试与退避、熔断、限速
  - 统一记录：Notion 写入与日志脱敏
- Task Runner / Executor（一次性 job）
  - 载入单钱包上下文（wallet_id、预算、密钥引用）
  - 调用路由决策（BlockRun 或 fallback）
  - 输出结构化结果（成功/失败、token/成本、耗时、错误）
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

## 数据流（建议）
1. orchestrator 按调度策略选择 wallet_id + 任务类型
2. orchestrator 创建 job（进程/容器），传入最小上下文（不直接传私钥明文）
3. executor 调用 Router 选择通道
4. executor 执行请求，收集成本/耗时/错误
5. Notion Recorder 写 Runs（成功/失败均写）
6. orchestrator 统计成功率、错误分布、成本分布并告警（可选）

## 失败隔离
- 单钱包连续失败触发冷却（cooldown），不影响其他钱包
- 单通道（BlockRun 或 Kimi）故障触发熔断/降级
- Notion 写入失败：本地队列/重试（但保持幂等）
