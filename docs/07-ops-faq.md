# 运维与 FAQ

## 运维清单（建议）
- 每日检查：成功率、失败类型分布、渠道分布、成本是否超预算
- 每周检查：密钥轮换计划、Notion token 轮换、依赖版本升级
- 告警建议：
  - 连续失败 N 次
  - Notion 写入失败持续超过 T 分钟
  - 单钱包成本异常飙升
  - BlockRun 或 Kimi 进入长时间熔断

## 常见问题

### 为什么不为 100 个钱包起 100 个常驻服务？
资源浪费、升级困难、故障扩散面大；更好的方式是 1 个 orchestrator 做并发与隔离，job 一次性执行。

### 如何避免整点触发导致风控？
引入 jitter，随机触发，设置 global/per-wallet 并发上限与 QPS 限制。

### Notion 写入失败会怎样？
Runs 仍应保证幂等；建议本地队列/重试，或先落本地状态再补写。

### 如何防止日志泄漏密钥？
禁止输出私钥/助记词/签名原文；所有错误信息脱敏；通过 pm2 / systemd 做最小权限与日志访问控制；仓库忽略 .env 与 secrets。

### BlockRun 不可用时如何兜底？
Router 触发 fallback 到自有 Kimi K2.6，同时记录 decision/channel/model/cost/error，保证统计口径一致。
