# Blockrunnooor 操作手册（Node.js / TypeScript｜Prompt Bank｜pm2）

本手册目标：在一台 VPS 上用 `pm2` 运行 TypeScript 版本 orchestrator，自动调度多组钱包轮询执行 LLM Chat（Prompt Bank 随机抽题），并通过日志、SQLite、BlockRun 健康接口与 Notion（可选）完成可观测与故障排查。

本手册默认模式：多账号（account_id）共享同一个 Notion Runs 表，通过 `account_id` 字段区分账号/业务分组。

## 0. 重要说明（必须阅读）
- 不在仓库中保存任何真实 token/私钥；生产环境只通过环境变量或受控文件注入
- 如必须使用“私钥明文存储以便管理”，风险极高：文件被读走即资金不可逆损失。至少做到：文件权限 600、目录权限 700、仅运行用户可读、不要备份到不受控介质、不要在日志/截图/工单中传播
- BlockRun 官方提供 OpenAI 兼容接口与示例：
  - SDK Developers：https://blockrun.ai/docs/getting-started/sdk-developers
  - x402 Endpoints（含免费健康/余额接口）：https://blockrun.ai/docs/x402/endpoints

## 1. 系统准备（Ubuntu/Debian）

### 1.1 安装依赖
```bash
apt-get update
apt-get install -y git sqlite3 curl
npm i -g pm2
```

### 1.2 拉取项目到指定目录
```bash
git clone https://github.com/RohanKishibeCN/Blockrunnooor /opt/blockrunnooor
cd /opt/blockrunnooor
```

### 1.3 安装依赖与构建
```bash
npm ci
npm run build
```

## 2. 目录与权限（示例）
```bash
mkdir -p /var/lib/blockrunnooor/state
mkdir -p /var/lib/blockrunnooor/wallets
mkdir -p /var/lib/blockrunnooor/secrets
mkdir -p /etc/blockrunnooor/accounts
chmod 700 /var/lib/blockrunnooor /var/lib/blockrunnooor/state /var/lib/blockrunnooor/wallets /var/lib/blockrunnooor/secrets /etc/blockrunnooor /etc/blockrunnooor/accounts
```

## 3. 账号（account_id）配置（多账号共享 Notion Runs）

### 3.1 创建账号配置文件
每个账号一个 JSON 文件，文件名不重要，以内容的 `account_id` 为准：

路径示例：`/etc/blockrunnooor/accounts/default.json`

```json
{
  "account_id": "default",
  "display_name": "default",
  "wallets_manifest_path": "/var/lib/blockrunnooor/wallets/manifest.default.jsonl",
  "prompts_file": "/etc/blockrunnooor/prompts.default.jsonl",
  "default_daily_budget_usd": 2.0,
  "default_max_cost_per_run_usd": 0.2
}
```

说明：
- Notion 配置在全局环境变量中（同一个 token/database），Runs 表中用 `account_id` 字段区分
- `wallets_manifest_path` / `prompts_file` 可按账号独立，也可多个账号复用同一个文件

## 4. 钱包清单（manifest.jsonl）

### 4.1 生成钱包清单（项目工具）
建议通过项目内置脚本生成（以最终实现为准）：
```bash
npm run generate-wallets -- \
  --count 100 \
  --out /var/lib/blockrunnooor/wallets/manifest.default.jsonl \
  --prefix wallet_default_
```

检查文件权限：
```bash
ls -la /var/lib/blockrunnooor/wallets/manifest.default.jsonl
chmod 600 /var/lib/blockrunnooor/wallets/manifest.default.jsonl
```

### 4.2 充值要求（Base 主网）
把 USDC 充值到 manifest 中的地址，网络为 Base 主网。

## 5. Prompt Bank（随机抽题）

### 5.1 创建 prompts.jsonl
路径示例：`/etc/blockrunnooor/prompts.default.jsonl`

每行一个 JSON，字段：
- `prompt_id`：唯一 id，会作为 `task_type` 进入 Runs 记录
- `model`：BlockRun 模型 id，例如 `openai/gpt-5.4`
- `messages`：OpenAI 兼容的 messages 数组
- 可选：`temperature`、`max_tokens`

```bash
mkdir -p /etc/blockrunnooor
cat >/etc/blockrunnooor/prompts.default.jsonl <<'EOF'
{"prompt_id":"p001","model":"openai/gpt-5.4","messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"用一句话解释 x402。"}],"temperature":0.2,"max_tokens":256}
{"prompt_id":"p002","model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"把下面这段话改写得更正式：Hello world"}],"temperature":0.7,"max_tokens":256}
EOF
chmod 600 /etc/blockrunnooor/prompts.default.jsonl
```

## 6. 环境变量配置（全部可调参入口）

### 6.1 全局必填项（最小可跑）
- `BRNOO_RUN_ID_SALT`：随机字符串
- `BRNOO_STATE_DB_PATH=/var/lib/blockrunnooor/state/state.db`
- `BRNOO_ACCOUNTS_DIR=/etc/blockrunnooor/accounts`
- `BLOCKRUN_API_URL=https://blockrun.ai/api`
- `BLOCKRUN_TIMEOUT_SECONDS=30`
- `BLOCKRUN_CHAT_PATH=/v1/chat/completions`

### 6.2 全局可选项（建议按需配置）
- 调度：`BRNOO_BASE_INTERVAL_SECONDS`、`BRNOO_JITTER_MAX_SECONDS`
- 并发：`BRNOO_GLOBAL_MAX_CONCURRENCY`、`BRNOO_PER_ACCOUNT_MAX_CONCURRENCY`、`BRNOO_PER_WALLET_MAX_CONCURRENCY`
- 幂等桶：`BRNOO_BUCKET_SECONDS`
- 重试：`BRNOO_MAX_ATTEMPTS`、`BRNOO_BACKOFF_BASE_SECONDS`、`BRNOO_BACKOFF_MAX_SECONDS`
- 冷却/熔断：`BRNOO_WALLET_FAILURE_THRESHOLD`、`BRNOO_WALLET_COOLDOWN_SECONDS`、`BRNOO_CIRCUIT_FAILURE_THRESHOLD`、`BRNOO_CIRCUIT_OPEN_SECONDS`
- outbox：`BRNOO_OUTBOX_POLL_SECONDS`
- Notion（可选）：`NOTION_TOKEN`、`NOTION_RUNS_DATABASE_ID`、`NOTION_TIMEOUT_SECONDS`

## 7. pm2 部署
参考：`docs/06-deployment-pm2.md`

## 8. BlockRun 侧健康检查（免费接口）
```bash
curl -s https://blockrun.ai/api/v1/health/overview | head
curl -s https://blockrun.ai/api/v1/models | head
curl -s https://blockrun.ai/api/v1/balance | head
```

## 9. SQLite 运行状态检查（强烈建议日常使用）
状态库默认：`/var/lib/blockrunnooor/state/state.db`

```bash
sqlite3 /var/lib/blockrunnooor/state/state.db ".tables"
sqlite3 /var/lib/blockrunnooor/state/state.db "select account_id,wallet_id,status,spent_today_usd,daily_budget_usd,cooldown_until,last_run_at from wallets order by account_id,wallet_id limit 50;"
sqlite3 /var/lib/blockrunnooor/state/state.db "select account_id,channel,failure_count,open_until from circuits order by account_id,channel;"
sqlite3 /var/lib/blockrunnooor/state/state.db "select run_id,account_id,wallet_id,task_type,scheduled_bucket,attempt,notion_page_id,updated_at from runs_index order by updated_at desc limit 50;"
sqlite3 /var/lib/blockrunnooor/state/state.db "select account_id,count(*) as outbox_pending from notion_outbox group by account_id order by outbox_pending desc;"
```

## 10. 常见问题排查

### 10.1 余额不足
- 先查余额：`GET https://blockrun.ai/api/v1/balance`（free endpoint）
- 确认充值网络为 Base 主网 USDC

### 10.2 429 / 5xx
- 查看日志中 `error_type=rate_limit/upstream` 以及重试退避是否生效
- 适当降低 `BRNOO_GLOBAL_MAX_CONCURRENCY` 或加大 `BRNOO_BASE_INTERVAL_SECONDS`

### 10.3 没有产出 runs
- 确认 accounts 目录加载成功、manifest/prompts 路径与权限正确
- 确认 pm2 环境变量注入成功（`pm2 env <id>` 或查看启动日志）
