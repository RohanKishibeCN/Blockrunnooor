# Blockrunnooor

面向 VPS 的"常驻编排器（orchestrator）+ 可触发任务（runs）"方案：用于在同一台机器上以 1 个常驻服务管理多组钱包的任务执行，并将每次运行（run）的结果与成本写入同一个 Notion Runs 表（通过 account_id 区分账号/业务分组）。

重要澄清：BlockRun 是"网关 + x402 支付协议"相关能力；本仓库讨论的是本地编排器/客户端如何调用 BlockRun，并不自建 BlockRun 后端。

## 支持的任务类别（对应 BlockRun 官方 API）

| kind | 描述 | BlockRun API |
|------|------|-------------|
| `chat` | AI Chat（50+ 模型） | POST `/api/v1/chat/completions` |
| `predexon` | 预测市场数据 | GET/POST `/api/v1/pm/{path}` |
| `search` | 网页搜索 | POST `/api/v1/search` |
| `exa` | Exa 原始搜索 | GET/POST `/api/v1/exa/{path}` |
| `modal` | 沙盒计算 | POST `/api/v1/modal/sandbox/*` |
| `usstock` | 美股行情 | GET `/api/v1/usstock/*` |
| `stocks` | 全球股票行情 | GET `/api/v1/stocks/{market}/*` |
| `crypto` | 加密货币行情 | GET `/api/v1/crypto/*` |
| `fx` | 外汇行情 | GET `/api/v1/fx/*` |
| `commodity` | 大宗商品行情 | GET `/api/v1/commodity/*` |

## 快速开始（文档优先）
1. 先阅读概览：docs/00-overview.md
2. 按安全策略准备密钥与权限：docs/02-security.md
3. 按调度策略设置并发/抖动/重试：docs/03-scheduling.md
4. 按路由策略接入 BlockRun + 自有 Kimi K2.6 兜底：docs/04-routing.md
5. 配置 Notion 表并实现幂等写入：docs/05-notion-schema.md
6. 用 pm2 部署为常驻服务：docs/06-deployment-pm2.md

## 文档导航
- 概览：docs/00-overview.md
- 架构：docs/01-architecture.md
- 安全：docs/02-security.md
- 调度：docs/03-scheduling.md
- 路由（BlockRun + 自有 Kimi 兜底）：docs/04-routing.md
- Notion 表结构：docs/05-notion-schema.md
- 多账号（共享 Notion Runs）：docs/09-multi-account.md
- 配置参考：docs/10-config-reference.md
- SQLite 迁移：docs/11-sqlite-migrations.md
- 部署（pm2）：docs/06-deployment-pm2.md
- 部署（systemd，可选）：docs/06-deployment-systemd.md
- 运维与 FAQ：docs/07-ops-faq.md
- 操作手册（含 Prompt Bank 配置）：docs/08-operations-manual.md

## 配置示例
- 环境变量示例：.env.example
- 建议：本地实际 .env 不提交；密钥目录不提交；日志脱敏
