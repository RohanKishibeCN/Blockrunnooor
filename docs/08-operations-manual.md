# Blockrunnooor 操作手册（Node.js / TypeScript｜Prompt Bank｜pm2）

本手册目标：在一台 VPS 上用 `pm2` 运行 TypeScript 版本 orchestrator，自动调度多组钱包轮询执行 LLM Chat（Prompt Bank 随机抽题），并通过日志、SQLite、BlockRun 健康接口与 Notion（可选）完成可观测与故障排查。

本手册推荐模式：**1 个账号（account_id）+ N 个钱包（wallet）**。
- 账号用于分组/统计（写入 Notion Runs 的 `account_id` 字段）
- 钱包用于隔离密钥与支付（每个钱包可独立充值 USDC、独立支付 x402）

只有在你确实需要把钱包分成多个“业务分组/客户/资金池”并做独立统计与开关时，才需要多账号（多个 account_id）。

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

## 3. 账号（account_id）配置（推荐：1 账号 + 多钱包）

### 3.1 创建账号配置文件
账号配置目录为 `BRNOO_ACCOUNTS_DIR`（默认示例：`/etc/blockrunnooor/accounts`）。

推荐模式（1 账号 + 100 钱包）只需要创建 **1 个账号 JSON**，文件名不重要，以内容的 `account_id` 为准：

路径示例：`/etc/blockrunnooor/accounts/default.json`

```json
{
  "account_id": "default",
  "display_name": "default",
  "wallets_manifest_path": "/var/lib/blockrunnooor/wallets/manifest.default.jsonl",
  "prompts_file": "/etc/blockrunnooor/prompts.default.jsonl",
  "default_daily_budget_usd": 2.0,
  "default_max_cost_per_run_usd": 0.2,
  "status": "active"
}
```

创建命令示例：
```bash
cat >/etc/blockrunnooor/accounts/default.json <<'EOF'
{
  "account_id": "default",
  "display_name": "default",
  "wallets_manifest_path": "/var/lib/blockrunnooor/wallets/manifest.default.jsonl",
  "prompts_file": "/etc/blockrunnooor/prompts.default.jsonl",
  "default_daily_budget_usd": 2.0,
  "default_max_cost_per_run_usd": 0.2,
  "status": "paused"
}
EOF
chmod 600 /etc/blockrunnooor/accounts/default.json
```

说明：
- Notion 配置在全局环境变量中（同一个 token/database），Runs 表中用 `account_id` 字段区分
- `wallets_manifest_path`：该账号的钱包清单（推荐 100 钱包写在同一个 manifest 文件里）
- `prompts_file`：该账号的 Prompt Bank（通常一个账号共用一份 prompts 文件）
- `status`：建议部署阶段先设为 `paused`，确认无误后再改为 `active`

多账号（可选）：
- 若要创建多个账号，就在该目录下放多个 JSON 文件；文件名建议用 `acc-0001.json`、`acc-0002.json` 便于排序
- 多账号时，每个账号通常使用不同的 `wallets_manifest_path`（否则多个账号会共享同一批钱包）

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

导出地址列表（用于批量充值，可选）：
```bash
node -e 'const fs=require("fs");const p="/var/lib/blockrunnooor/wallets/manifest.default.jsonl";const out="/var/lib/blockrunnooor/wallets/addresses.default.txt";const lines=fs.readFileSync(p,"utf8").trim().split(/\r?\n/).filter(Boolean).map(l=>{const o=JSON.parse(l);return `${o.wallet_id}\t${o.address}`});fs.writeFileSync(out,lines.join("\n")+"\n",{mode:0o600});console.log(out);'
```

### 4.2 充值要求（Base 主网）
把 USDC 充值到 manifest 中的地址，网络为 Base 主网。

提示：
- 如果你只调用 NVIDIA 的免费模型，理论上可以不充值（但建议至少准备少量 USDC，避免偶发需要付费的请求失败）
- 若你会混用付费模型（例如 OpenAI/Anthropic），则必须充值 USDC 才能支付 x402

## 5. Prompt Bank（随机抽题）

### 5.1 创建 prompts.jsonl
路径示例：`/etc/blockrunnooor/prompts.default.jsonl`

每行一个 JSON，字段：
- `prompt_id`：唯一 id，会作为 `task_type` 进入 Runs 记录
- `kind`：任务类型（可选，默认 `chat`）；支持的 kind 对应 BlockRun 官方 API 分类：
  - `chat` — AI Chat（OpenAI 兼容接口）
  - `predexon` — 预测市场（Predexon 透传，`/v1/pm/{path}`）
  - `search` — 网页搜索（Exa 搜索，`/v1/search`）
  - `exa` — Exa 原始透传（`/v1/exa/{path}`）
  - `modal` — 沙盒计算（`/v1/modal/sandbox/*`）
  - `usstock` — 美股行情（`/v1/usstock/*`）
  - `stocks` — 全球股票行情（`/v1/stocks/{market}/*`）
  - `crypto` — 加密货币行情（`/v1/crypto/*`）
  - `fx` — 外汇行情（`/v1/fx/*`）
  - `commodity` — 大宗商品行情（`/v1/commodity/*`）
- `messages`：OpenAI 兼容的 messages 数组（仅 `kind=chat` 使用）
- `model`：可选；仅 `kind=chat` 使用
  - 省略或写 `random`：按 env 的模型池与比例随机选择
  - 写具体模型 id：直接使用该模型（例如 `deepseek/deepseek-chat`）
- 可选：`temperature`、`max_tokens`（仅 `kind=chat` 使用）
- `method`：可选；非 chat 类使用（默认 `GET`）
- `path`：必填；非 chat 类使用，路径前缀不含 `/api`（因为 `BLOCKRUN_API_URL` 已包含）
- `params` / `body`：可选；非 chat 类使用

说明：
- `BRNOO_BLOCKRUN_MODEL` 作为兜底默认模型
- 当 `model=random` 时，会结合：
  - `BRNOO_BLOCKRUN_MODELS_FREE` / `BRNOO_BLOCKRUN_MODELS_PAID`
  - `BRNOO_BLOCKRUN_PAID_RATIO`
  自动选择免费/付费模型
- 当前免费模型池（来源：`GET /api/v1/models`）：
  - `nvidia/deepseek-v4-flash`
  - `nvidia/qwen3-coder-480b`
  - `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
  - `nvidia/llama-4-maverick`
  - `nvidia/qwen3-next-80b-a3b-thinking`
  - `nvidia/mistral-small-4-119b`
- 非 chat 类调用通过 BlockRun 的 x402 Gateway 透传到对应服务，自动完成 x402 支付

```bash
mkdir -p /etc/blockrunnooor
cat >/etc/blockrunnooor/prompts.default.jsonl <<'EOF'
{"prompt_id":"p001","kind":"chat","model":"random","messages":[{"role":"user","content":"用一句话解释 x402。"}],"temperature":0.2,"max_tokens":128}
{"prompt_id":"p002","kind":"chat","model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"把下面这段话改写得更正式：Hello world"}],"temperature":0.7,"max_tokens":256}
{"prompt_id":"pm_001","kind":"predexon","method":"GET","path":"/v1/pm/polymarket/markets"}
{"prompt_id":"pm_002","kind":"predexon","method":"GET","path":"/v1/pm/polymarket/events/trump-inauguration"}
{"prompt_id":"us_001","kind":"usstock","method":"GET","path":"/v1/usstock/price/AAPL"}
{"prompt_id":"us_002","kind":"usstock","method":"GET","path":"/v1/usstock/history/AAPL"}
{"prompt_id":"crypto_001","kind":"crypto","method":"GET","path":"/v1/crypto/price/BTC"}
{"prompt_id":"fx_001","kind":"fx","method":"GET","path":"/v1/fx/price/EURUSD"}
{"prompt_id":"cmdt_001","kind":"commodity","method":"GET","path":"/v1/commodity/price/GOLD"}
{"prompt_id":"search_001","kind":"search","method":"POST","path":"/v1/search","body":{"query":"latest AI news"}}
EOF
chmod 600 /etc/blockrunnooor/prompts.default.jsonl
```

建议把 Prompt Bank 扩充到 100 条以减少重复与风控相关性，并覆盖不同输出形态（短答/长文/结构化 JSON）。推荐配比：
- 50：chat 类（摘要/改写/翻译/分类/推理/代码）
- 10：predexon（预测市场数据）
- 10：search / exa（搜索）
- 15：金融行情（usstock/crypto/fx/commodity，免费 list + 付费 price/history）
- 15：其他（modal 沙盒等）

## 6. 环境变量配置（全部可调参入口）

### 6.1 创建 env 文件（推荐：统一写到一个文件）
```bash
mkdir -p /etc/blockrunnooor
cp /opt/blockrunnooor/.env.example /etc/blockrunnooor/blockrunnooor.env
chmod 600 /etc/blockrunnooor/blockrunnooor.env
```

编辑：
```bash
nano /etc/blockrunnooor/blockrunnooor.env
```

说明：
- orchestrator 启动时会自动读取 `.env`（工作目录下）或 `BRNOO_ENV_FILE` 指向的 env 文件
- 推荐用 pm2 在 `ecosystem.config.cjs` 里只配置 `BRNOO_ENV_FILE=/etc/blockrunnooor/blockrunnooor.env`，其余参数都写在这个 env 文件中

### 6.2 参数清单与说明（全部在 env 文件中配置）

核心：
- `BRNOO_RUN_ID_SALT`：必填，run_id 计算盐；改动会导致 run_id 全部变化
- `BRNOO_STATE_DB_PATH`：必填，SQLite 文件路径
- `BRNOO_ACCOUNTS_DIR`：账号配置目录（与 `BRNOO_ACCOUNTS_JSON` 二选一）
- `BRNOO_ACCOUNTS_JSON`：账号配置 JSON 数组字符串（与 `BRNOO_ACCOUNTS_DIR` 二选一）

BlockRun：
- `BRNOO_BLOCKRUN_MODEL`：必填，全局兜底默认模型 id（例如 `nvidia/deepseek-v4-flash` / `deepseek/deepseek-chat`）
- `BRNOO_BLOCKRUN_MODELS_FREE`：可选，免费模型池，逗号分隔（例如 `nvidia/deepseek-v4-flash,nvidia/qwen3-coder-480b,nvidia/mistral-small-4-119b`）
  - 建议通过 `curl https://blockrun.ai/api/v1/models | jq '.data[] | select(.billing_mode=="free") | .id'` 获取当前免费模型列表
- `BRNOO_BLOCKRUN_MODELS_PAID`：可选，付费模型池，逗号分隔（例如 `deepseek/deepseek-chat,openai/gpt-5.4-nano,google/gemini-2.5-flash-lite`）
- `BRNOO_BLOCKRUN_PAID_RATIO`：可选，付费池选中概率 0~1（默认 0.3）
- `BRNOO_TASK_KIND_WEIGHTS`：可选，任务类型权重（例如 `chat=60,predexon=10,search=10,crypto=10,fx=5,commodity=5`）
- `BLOCKRUN_API_URL`：必填，例如 `https://blockrun.ai/api`
- `BLOCKRUN_CHAT_PATH`：必填，例如 `/v1/chat/completions`
- `BLOCKRUN_TIMEOUT_SECONDS`：可选，默认 30
- `BLOCKRUN_WALLET_KEY`：可选，全局 wallet key（不推荐用于多钱包；多钱包建议在 manifest 写 `private_key` 或 `secret_ref`）
说明：
- `BLOCKRUN_CHAT_PATH` 为兼容保留：接入 BlockRun 官方 TypeScript SDK 后不再依赖该字段，但当前仍建议保留配置以便回滚
- 免费模型清单会随 BlockRun 更新而变化，请定期通过 `/api/v1/models` 接口核实

调度：
- `BRNOO_BASE_INTERVAL_SECONDS`：可选，每轮调度间隔（默认 60）
- `BRNOO_JITTER_MAX_SECONDS`：可选，每轮触发抖动（默认 10）
- `BRNOO_BUCKET_SECONDS`：可选，幂等桶大小（默认 60）；同一 bucket 重试复用同一 run_id
- `BRNOO_SCHEDULER_POLL_SECONDS`：可选，调度轮询间隔（默认 5）；值越小越“准时”，但更耗资源
- `BRNOO_WALLET_ORDER`：可选，钱包触发顺序（`sequential` / `random`；默认 sequential）

并发：
- `BRNOO_GLOBAL_MAX_CONCURRENCY`：可选，全局并发上限
- `BRNOO_PER_ACCOUNT_MAX_CONCURRENCY`：可选，单账号并发上限
- `BRNOO_PER_WALLET_MAX_CONCURRENCY`：可选，单钱包并发上限（通常 1）

重试：
- `BRNOO_MAX_ATTEMPTS`：可选，最大尝试次数（默认 3）
- `BRNOO_BACKOFF_BASE_SECONDS`：可选，退避基数（默认 2）
- `BRNOO_BACKOFF_MAX_SECONDS`：可选，退避最大值（默认 30）

冷却/熔断：
- `BRNOO_WALLET_FAILURE_THRESHOLD`：可选，单钱包连续失败阈值（默认 3）
- `BRNOO_WALLET_COOLDOWN_SECONDS`：可选，钱包冷却时长（默认 300）
- `BRNOO_CIRCUIT_FAILURE_THRESHOLD`：可选，通道连续失败阈值（默认 10）
- `BRNOO_CIRCUIT_OPEN_SECONDS`：可选，通道熔断时长（默认 60）

Notion（可选）：
- `NOTION_TOKEN`：Notion token
- `NOTION_RUNS_DATABASE_ID`：Runs 数据库 id
- `NOTION_TIMEOUT_SECONDS`：可选，默认 15
- `NOTION_RETRY_BACKOFF_BASE_SECONDS`：Notion 写入失败的重试退避基数（默认 2）
- `NOTION_RETRY_BACKOFF_MAX_SECONDS`：Notion 写入失败的重试退避最大秒数（默认 300）

日志：
- `BRNOO_LOG_LEVEL`：可选，debug/info/warn/error（默认 info）

账号配置（B 模式：共享 Notion Runs）：
- `BRNOO_ACCOUNTS_JSON` 示例（单行）：
  - `[{"account_id":"default","wallets_manifest_path":"/var/lib/blockrunnooor/wallets/manifest.default.jsonl","prompts_file":"/etc/blockrunnooor/prompts.default.jsonl","default_daily_budget_usd":2.0,"default_max_cost_per_run_usd":0.2,"status":"active"}]`
  - 推荐模式（1 账号 + 100 钱包）同样可以用 `BRNOO_ACCOUNTS_DIR`，但只放 1 个 `default.json` 即可
  - 只有在你要拆成多个业务分组时，才需要在 `BRNOO_ACCOUNTS_DIR` 下放多个账号 JSON 文件

## 7. pm2 部署
参考：`docs/06-deployment-pm2.md`

最小步骤（推荐）：
```bash
cp /opt/blockrunnooor/ecosystem.config.cjs /etc/blockrunnooor/ecosystem.config.cjs
pm2 start /etc/blockrunnooor/ecosystem.config.cjs
pm2 status
pm2 logs blockrunnooor --lines 200
```

把账号从 `paused` 改为 `active` 后重启使其生效：
```bash
nano /etc/blockrunnooor/accounts/default.json
pm2 restart blockrunnooor
```

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
