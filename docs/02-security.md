# 安全

## 核心原则
- 不在仓库中保存任何真实 token/私钥
- 最小权限：运行账户、文件权限、网络权限、Notion 权限均最小化
- 日志脱敏：任何可能重构密钥/签名/钱包私密信息的字段一律不落日志或做哈希化
- 小额专用钱包：资金隔离，单钱包预算与阈值强约束

## 私钥存储方案（示例，可选其一）

### A. 文件加密 + 主密钥（推荐起步）
- 目录：`/var/lib/blockrunnooor/secrets/`
- 单钱包文件：`wallet_<wallet_id>.json.enc`
- 加密：AES-GCM（或 age/sops）
- 解密：仅 orchestrator 在运行时解密到内存；executor 通过短期 IPC/pipe 获取最小必要信息，尽量避免落盘明文

### B. KMS/密钥环（更强）
- 由 KMS 持有主密钥
- orchestrator 每次启动/轮换时拉取短期凭据
- executor 仅拿到短期凭据或签名能力，不接触长期明文私钥

## 权限与隔离
- 建议专用用户：`blockrun`
- 目录权限：
  - secrets：`chmod 700`，文件 `chmod 600`，owner 为 `blockrun`
  - 日志：仅运维组可读（或通过 pm2 / systemd 日志访问控制）

## 多账号（共享 Notion Runs）
- 多账号模式下建议把 `account_id` 作为强制字段写入 Runs，并在运维侧以 Notion 视图/过滤器隔离不同账号
- 不要把 Notion token 写入 SQLite；建议仅通过环境变量或受控文件读取

## 备份与轮换
- 备份：仅备份加密后的 secrets；备份介质同样需要访问控制
- 轮换：
  - 钱包私钥轮换：创建新 wallet_id 或更新 wallet_version
  - Notion token 轮换：短周期更新并支持热加载或平滑重启

## 日志脱敏清单（必须）
- 禁止：私钥、助记词、原始签名串、完整请求体（若含敏感信息）
- 允许：wallet_id（推荐）、address（可选脱敏）、渠道、模型、耗时、错误码、成本
- 建议：对 address 做 `addr[:6] + "..." + addr[-4:]`

## 预算与阈值（建议口径）
- 单次上限：max_cost_per_run
- 日上限：max_cost_per_day
- 余额不足：标记 wallet 状态为 depleted 并冷却，等待充值/恢复
