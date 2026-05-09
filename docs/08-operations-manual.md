# Blockrunnooor 操作手册（Base 主网｜Prompt Bank｜systemd root）

本手册目标：在一台 VPS 上用 `systemd` 以 `root` 用户运行 `/root/blockrunnooor`，自动调度 100 个钱包轮询执行 LLM Chat（Prompt Bank 随机抽题），并可通过日志、SQLite、BlockRun 健康接口与 Notion（可选）完成可观测与故障排查。

## 0. 重要说明（必须阅读）
- 本阶段你要求“100 钱包私钥明文存储以便管理”。这会显著提高风险：只要文件被读走，资金不可逆损失。请至少做到：文件权限 600、目录权限 700、仅 root 可读、不要备份到不受控介质、不要在日志/截图/工单中传播。
- BlockRun 官方提供 OpenAI 兼容接口与示例（模型调用、curl、OpenAI SDK 兼容）：
  - SDK Developers：https://blockrun.ai/docs/getting-started/sdk-developers
  - x402 Endpoints（含免费健康/余额接口）：https://blockrun.ai/docs/x402/endpoints

## 1. 系统准备（Ubuntu/Debian）

### 1.1 安装依赖
```bash
apt-get update
apt-get install -y git python3 python3-pip sqlite3 curl
python3 -m pip install -U pip
```

### 1.2 拉取项目到指定目录
```bash
git clone https://github.com/RohanKishibeCN/Blockrunnooor /root/blockrunnooor
cd /root/blockrunnooor
```

### 1.3 安装依赖（不使用 venv）
```bash
python3 -m pip install -e .
```

## 2. 目录与权限（私钥明文模式）
```bash
mkdir -p /var/lib/blockrunnooor/state
mkdir -p /var/lib/blockrunnooor/wallets
mkdir -p /var/lib/blockrunnooor/secrets
chmod 700 /var/lib/blockrunnooor /var/lib/blockrunnooor/state /var/lib/blockrunnooor/wallets /var/lib/blockrunnooor/secrets
```

## 3. 生成 100 个钱包（EOA + 私钥）并形成管理文件

### 3.1 生成钱包清单（manifest.jsonl）
生成文件包含：`wallet_id`、`address`、`private_key`、`created_at`（明文私钥）。

```bash
/root/blockrunnooor/bin/generate_wallets \
  --count 100 \
  --out /var/lib/blockrunnooor/wallets/manifest.jsonl \
  --prefix wallet_
```

检查文件权限：
```bash
ls -la /var/lib/blockrunnooor/wallets/manifest.jsonl
```

### 3.2 提取地址列表用于充值（可选）
```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path("/var/lib/blockrunnooor/wallets/manifest.jsonl")
out = Path("/var/lib/blockrunnooor/wallets/addresses.txt")
lines = []
for line in p.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    o = json.loads(line)
    lines.append(f"{o['wallet_id']}\t{o['address']}")
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(out)
PY
chmod 600 /var/lib/blockrunnooor/wallets/addresses.txt
```

### 3.3 充值要求（Base 主网）
把 USDC 充值到 `addresses.txt` 中的地址，网络为 Base 主网。

## 4. Prompt Bank（随机抽题）

### 4.1 创建 prompts.jsonl
路径固定为：`/etc/blockrunnooor/prompts.jsonl`（你也可以在 env 中改）。

每行一个 JSON，字段：
- `prompt_id`：唯一 id，会作为 `task_type` 进入 Runs 记录
- `model`：BlockRun 模型 id，例如 `openai/gpt-5.4`
- `messages`：OpenAI 兼容的 messages 数组
- 可选：`temperature`、`max_tokens`

```bash
mkdir -p /etc/blockrunnooor
cat >/etc/blockrunnooor/prompts.jsonl <<'EOF'
{"prompt_id":"p001","model":"openai/gpt-5.4","messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"用一句话解释 x402。"}],"temperature":0.2,"max_tokens":256}
{"prompt_id":"p002","model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"把下面这段话改写得更正式：Hello world"}],"temperature":0.7,"max_tokens":256}
EOF
chmod 600 /etc/blockrunnooor/prompts.jsonl
```

## 5. 环境变量配置（全部可调参入口）

### 5.1 创建 env 文件
```bash
mkdir -p /etc/blockrunnooor
cp /root/blockrunnooor/deploy/systemd/blockrunnooor.env.example /etc/blockrunnooor/blockrunnooor.env
chmod 600 /etc/blockrunnooor/blockrunnooor.env
```

编辑：
```bash
nano /etc/blockrunnooor/blockrunnooor.env
```

### 5.2 必填项（最小可跑）
- `BRNOO_RUN_ID_SALT`：随机字符串
- `BRNOO_STATE_DB_PATH=/var/lib/blockrunnooor/state/state.db`
- `BRNOO_WALLETS_MANIFEST_PATH=/var/lib/blockrunnooor/wallets/manifest.jsonl`
- `BRNOO_PROMPTS_FILE=/etc/blockrunnooor/prompts.jsonl`
- `BRNOO_PROMPT_SELECTION_STRATEGY=random`
- `BLOCKRUN_API_URL=https://blockrun.ai/api`
- `BLOCKRUN_TIMEOUT_SECONDS=30`
- `BLOCKRUN_CHAT_PATH=/v1/chat/completions`

### 5.3 可选项（建议按需配置）
- 调度：`BRNOO_BASE_INTERVAL_SECONDS`、`BRNOO_JITTER_MAX_SECONDS`、`BRNOO_GLOBAL_MAX_CONCURRENCY`、`BRNOO_PER_WALLET_MAX_CONCURRENCY`
- 幂等桶：`BRNOO_BUCKET_SECONDS`
- 重试：`BRNOO_MAX_ATTEMPTS`、`BRNOO_BACKOFF_BASE_SECONDS`、`BRNOO_BACKOFF_MAX_SECONDS`
- 冷却/熔断：`BRNOO_WALLET_FAILURE_THRESHOLD`、`BRNOO_WALLET_COOLDOWN_SECONDS`、`BRNOO_CIRCUIT_FAILURE_THRESHOLD`、`BRNOO_CIRCUIT_OPEN_SECONDS`
- outbox：`BRNOO_OUTBOX_POLL_SECONDS`
- Notion（可选）：`NOTION_TOKEN`、`NOTION_RUNS_DATABASE_ID`、`NOTION_TIMEOUT_SECONDS`

## 6. systemd 部署（root + /root/blockrunnooor）

### 6.1 安装 service
```bash
cp /root/blockrunnooor/deploy/systemd/blockrunnooor-root.service /etc/systemd/system/blockrunnooor.service
systemctl daemon-reload
systemctl enable --now blockrunnooor.service
```

### 6.2 查看状态
```bash
systemctl status blockrunnooor.service --no-pager
systemctl is-active blockrunnooor.service
```

### 6.3 查看实时日志
```bash
journalctl -u blockrunnooor.service -f
```

## 7. BlockRun 侧健康检查（免费接口）
x402 endpoints 文档列出以下 free endpoints，可用于探活与排障：
https://blockrun.ai/docs/x402/endpoints

```bash
curl -s https://blockrun.ai/api/v1/health/overview | head
curl -s https://blockrun.ai/api/v1/models | head
curl -s https://blockrun.ai/api/v1/balance | head
```

## 8. SQLite 运行状态检查（强烈建议日常使用）
状态库默认：`/var/lib/blockrunnooor/state/state.db`

```bash
sqlite3 /var/lib/blockrunnooor/state/state.db ".tables"
sqlite3 /var/lib/blockrunnooor/state/state.db "select wallet_id,status,spent_today_usd,daily_budget_usd,cooldown_until,last_run_at from wallets order by wallet_id limit 20;"
sqlite3 /var/lib/blockrunnooor/state/state.db "select channel,failure_count,open_until from circuits;"
sqlite3 /var/lib/blockrunnooor/state/state.db "select run_id,wallet_id,task_type,scheduled_bucket,attempt,notion_page_id,updated_at from runs_index order by updated_at desc limit 20;"
sqlite3 /var/lib/blockrunnooor/state/state.db "select count(*) as outbox_pending from notion_outbox;"
```

## 9. 常见问题排查

### 9.1 余额不足
- 先查余额：`GET https://blockrun.ai/api/v1/balance`（free endpoint）
- 确认充值网络为 Base 主网 USDC

### 9.2 429 / 5xx
- 查看日志中 `error_type=rate_limit/upstream` 以及重试退避是否生效
- 适当降低 `BRNOO_GLOBAL_MAX_CONCURRENCY` 或加大 `BRNOO_BASE_INTERVAL_SECONDS`

### 9.3 没有产出 runs
- 确认 `manifest.jsonl`、`prompts.jsonl` 路径与权限正确
- 确认 systemd 环境文件加载成功（`systemctl status` 看是否有 env 解析错误）

