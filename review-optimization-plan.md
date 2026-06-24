# Blockrunnooor 代码评审与优化方案

> 生成时间：2026-06-24 | 版本：基于 `v0.2.0` (commit: latest) | 含已实施改动

---

## 目录

1. [总体评价](#1-总体评价)
2. [严重问题 / Bug（高优先级）](#2-严重问题--bug高优先级)
3. [架构与设计问题（中优先级）](#3-架构与设计问题中优先级)
4. [可靠性 & 容错（中优先级）](#4-可靠性--容错中优先级)
5. [安全性](#5-安全性)
6. [代码质量 & 可维护性](#6-代码质量--可维护性)
7. [可观测性 & 运维](#7-可观测性--运维)
8. [性能优化建议](#8-性能优化建议)
9. [文档与代码不一致](#9-文档与代码不一致)
10. [总结与优先级行动清单](#10-总结与优先级行动清单)
11. [已实施的改动（2026-06-24 会话）](#11-已实施的改动2026-06-24-会话)

---

## 1. 总体评价

项目整体架构清晰，核心的分层设计（Orchestrator / Router / Notion Recorder / StateRepo）合理，模块边界明确。代码风格统一，TypeScript 严格模式开启，使用 Zod 做输入校验。SQLite 的 WAL 模式 + 幂等迁移策略是成熟的做法。

但在实际运行细节上存在若干可改进点，以下是逐项分析。

---

## 2. 严重问题 / Bug（高优先级）

### 2.1 🔴 Wallets 表主键设计缺陷，多账号场景下钱包冲突

**位置：** [src/state/migrations.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/state/migrations.ts#L25-L37)

**问题描述：**
`wallets` 表的 DDL 将 `wallet_id` 作为单列主键：

```sql
CREATE TABLE IF NOT EXISTS wallets (
  wallet_id TEXT PRIMARY KEY,  -- ← 全局唯一，而非 per-account
  account_id TEXT NOT NULL,
  ...
);
```

而所有查询都带 `WHERE account_id=? AND wallet_id=?`，暗示期望 per-account 隔离。`ensureWallet` 使用 `ON CONFLICT(wallet_id) DO NOTHING`，意味着如果两个不同账号有相同 `wallet_id`，后者的钱包不会被创建。

虽然当前运维文档推荐使用带前缀的 `wallet_id`（如 `wallet_default_0001`），但这是一个数据完整性的隐患。

**修复建议：**
将主键改为复合键 `PRIMARY KEY (account_id, wallet_id)`，或在 `wallet_id` 上使用单独的全局唯一 ID（UUID），用 `(account_id, wallet_id)` 建唯一索引。推荐前者，改动更小：

```sql
CREATE TABLE IF NOT EXISTS wallets (
  account_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  status TEXT NOT NULL,
  ...
  PRIMARY KEY (account_id, wallet_id)
);
```

同时修改 [StateRepo.ensureWallet](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/state/repo.ts#L74-L84) 的 `ON CONFLICT` 子句：

```sql
ON CONFLICT(account_id, wallet_id) DO NOTHING
```

**影响范围：** `StateRepo` 所有对 wallets 的读写操作、索引 `idx_wallets_account`。

---

### 2.2 🔴 `max_cost_per_run_usd` 从未被实际校验

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts) `runOnce()` 方法

**问题描述：**
账号配置和钱包状态中都存储了 `max_cost_per_run_usd`，用于限制单次 API 调用的最大费用。但在 `runOnce()` 的执行路径中：

1. `decide()` 只检查 `daily_budget_usd`，不检查 `max_cost_per_run_usd`
2. `BlockRunClient` 调用前也没有预检

这意味着如果一个 prompt 意外产生高额费用，没有任何防护。

**修复建议：**
在 `decide()` 或 `runOnce()` 中增加预检逻辑。对于 `kind=chat` 可以估算 token 上限对应的成本（如超则拒绝）。对于 API 类调用（surf/predexon/markets）难以预判，可改为事后校验：费用超过上限后标记 wallet 为 `depleted` 并进入冷却。

```typescript
// 在 decide() 或 runOnce() 调用前增加：
if (wallet.max_cost_per_run_usd > 0) {
  // 对 chat 类做保守预估（如按 max_tokens 估算）
  // 对 API 类可做事后校验
}
```

---

### 2.3 🔴 Notion Outbox 无限重试，无最大次数限制

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L352-L385) `outboxLoop()`

**问题描述：**
`notion_outbox` 表中的记录会持续重试，没有最大重试次数限制。如果 Notion API 持续返回非可重试的错误（如 schema 不匹配），这些记录会永远留在 outbox 中持续重试并消耗资源。

**修复建议：**
在 `updateOutboxItem` 中增加最大重试次数判断（如 30 次），超限后标记为 dead letter 或直接删除并记录错误日志：

```typescript
const MAX_OUTBOX_ATTEMPTS = 30
if (item.attempt + 1 >= MAX_OUTBOX_ATTEMPTS) {
  this.repo.deleteOutboxItem(item.id)
  logEvent("error", "outbox_dropped", { 
    run_id: item.run_id, 
    attempts: item.attempt + 1, 
    error: res.error 
  })
  continue
}
```

---

### 2.4 🔴 `last_run_at` 被乐观更新，可能导致调度错位

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L176)

**问题描述：**
在 `scheduleLoop()` 中，`touchWalletLastRun` 在 `runOnce` 被调用之前执行（第176行）。这意味着：

- 即使 run 因为并发限制被跳过（`walletsRunning` 检查），`last_run_at` 已经被更新
- 即使 runOnce 内部因为 `decide() === "deny"` 而立即返回，`last_run_at` 也被更新了
- `scheduleLoop` 中更新一次，`runOnce` 失败路径中又更新一次 — 存在冗余更新

**修复建议：**
将 `touchWalletLastRun` 移到 `runOnce` 内部，在 run 实际执行后才更新：

```typescript
// 在 scheduleLoop 中删除：
// this.repo.touchWalletLastRun(account.account_id, walletId, tickStart)

// 在 runOnce 中，各种 exit path 统一调用
```

---

## 3. 架构与设计问题（中优先级）

### 3.1 🟡 Kimi K2.6 兜底通道未实现

**问题描述：**
[文档](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/04-routing.md) 详细描述了 "BlockRun 优先 + 自有 Kimi K2.6 兜底" 的路由策略，但代码中：

- `decision` 永远是硬编码的 `"blockrun"`（[orchestrator.ts:L455](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L455)）
- 没有 fallback client 实现
- 没有 fallback 路由分支

虽然文档注明"当前 TypeScript 版本实现以 BlockRun 为唯一执行通道"，但这意味着项目中一段关键的业务连续性能力缺失。

**修复建议：**
1. 新建 `src/clients/kimi.ts`，实现 Kimi API 调用
2. 在 `blockrun.ts` 和新的 `kimi.ts` 之上抽象统一的 `ModelClient` 接口
3. 在 `runOnce` 中实现 fallback 逻辑：BlockRun 失败 → 尝试 Kimi → 都失败则记录失败

---

### 3.2 🟡 无优雅关闭机制

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L87-L89) `stop()`

**问题描述：**
`stop()` 仅设置 `this.running = false`，没有：
- 等待正在进行中的 run 完成
- 等待 outbox 写入完成
- 关闭数据库连接

当 pm2 或 systemd 发送 SIGTERM 时，进行中的请求会被立即中断，可能导致：
- Notion 写入丢失（已执行但未记录）
- SQLite 事务未提交

**修复建议：**

```typescript
async stop(): Promise<void> {
  this.running = false
  // 等待 inflight 降为 0，最多等 30 秒
  const deadline = Date.now() + 30_000
  while (this.inflight > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
  }
  // 执行最后一次 outbox 刷新
  await this.outboxLoop()  // 单次执行
  // 关闭数据库
  this.repo.close()
}
```

同时在 `index.ts` 中将 shutdown 改为 async 并 await：

```typescript
process.on("SIGTERM", async () => {
  await shutdown("SIGTERM")
  process.exit(0)
})
```

---

### 3.3 🟡 调度循环无异常保护，单个钱包错误可导致整轮调度中断

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L122-L178) `scheduleLoop()`

**问题描述：**
`loadWalletManifest` 和 `loadPromptBank` 在循环内调用，如果某个账号的钱包文件损坏或 prompt 文件格式错误，会抛出异常，导致整个调度循环崩溃，进程重启。

**修复建议：**
对每个 account 添加 try-catch：

```typescript
for (const account of this.accounts) {
  try {
    // ... existing logic
  } catch (e) {
    logEvent("error", "schedule_loop_account_error", {
      account_id: account.account_id,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 200)
    })
  }
}
```

---

### 3.4 🟡 熔断器实现不够成熟

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L267-L280)

**问题描述：**
当前的熔断器实现混合了两种粒度：
1. **钱包级冷却**（wallet cooldown）：基于内存中的 `walletFailures` Map
2. **通道级熔断**（circuit breaker）：基于 DB 中的 `circuits` 表

问题：
- `walletFailures` 是纯内存的，重启后丢失，导致钱包冷却状态不持久（虽然 DB 中 `cooldown_until` 会被设置，但连续失败计数丢失了）
- 通道熔断的 `failure_count` 在 circuit 打开时被重置为 0（[orchestrator.ts:L279](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L279)），这是 circuit breaker 模式的标准做法（进入 open 状态时重置计数器），但缺少 half-open 状态
- 没有 half-open 探针机制：circuit 打开后直接等到 `open_until` 到期，没有逐步恢复试探

**修复建议：**
1. 将钱包失败计数也持久化到 DB（或在 DB 中新增 `consecutive_failures` 字段）
2. 实现标准的 circuit breaker 三态：CLOSED → OPEN → HALF_OPEN → CLOSED
3. 在 HALF_OPEN 状态下仅允许少量试探请求

---

## 4. 可靠性 & 容错（中优先级）

### 4.1 🟡 Outbox 重试退避算法问题

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L379)

**问题描述：**
`outboxLoop` 中使用的退避计算：
```typescript
backoffSeconds(backoffBase, item.attempt + 1, backoffMax)
```
但 `backoffSeconds` 的实现（[notion.ts:L99-L103](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/clients/notion.ts#L99-L103)）使用 `Math.random()` 产生 0~1 之间的抖动（不是秒级）。这意味着抖动最大只增加不到 1 秒，对于 level 很高的重试（如 backoff 已达到 300s），这个抖动几乎可以忽略。

**修复建议：**
改为基于百分比的抖动或更大的随机范围：

```typescript
export function backoffSeconds(base: number, attempt: number, maxSeconds: number): number {
  const raw = attempt <= 1 ? base : base * 2 ** (attempt - 1)
  const jitter = Math.random() * raw * 0.3  // 30% 抖动
  return Math.min(Math.floor(raw + jitter), maxSeconds)
}
```

---

### 4.2 🟡 `BlockRunClient` 中 `chat()` 和 `callApi()` 大量重复代码

**位置：** [src/clients/blockrun.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/clients/blockrun.ts)

**问题描述：**
`chat()` (L41-L157) 和 `callApi()` (L167-L279) 两个方法的错误处理代码几乎完全重复：
- `APIError` 处理
- `PaymentError` 处理
- 通用错误处理
- `error_type` 分类逻辑
- `extractSettlementTx` / `extractRequestId` 调用

这增加了维护成本，修改错误处理逻辑时需要同步两个地方。

**修复建议：**
提取公共的错误映射函数：

```typescript
function mapBlockRunError(e: unknown, start: number, gateway: string | null, label?: string | null): BlockRunResponse {
  const latencyMs = Date.now() - start
  // ... 统一错误处理逻辑
}
```

---

### 4.3 🟡 `Semaphore` 实现在极端场景下可能产生负容量

**位置：** [src/util/semaphore.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/util/semaphore.ts)

**问题描述：**
当前实现在常规单线程 Node.js 环境下工作正常，但 `acquire` 方法中 `await` 之后的 `this.available -= 1` 没有防御性检查。如果未来引入 worker_threads 或由于某种原因 release 被多次调用（比如同一个 release 回调被调用两次），available 可能变为负数。

**修复建议：**
添加断言或防御性检查：

```typescript
async acquire(): Promise<() => void> {
  if (this.available > 0) {
    this.available -= 1
    return () => this.release()
  }
  await new Promise<void>((resolve) => {
    this.waiters.push(resolve)
  })
  // 防御性检查
  if (this.available <= 0) throw new Error("semaphore invariant violation")
  this.available -= 1
  let released = false
  return () => {
    if (released) return
    released = true
    this.release()
  }
}
```

---

### 4.4 🟡 Notion 写入产生竞态：outbox 和实时写入可能并发操作同一 run_id

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L325-L350) `recordAndUpdate()`

**问题描述：**
`recordAndUpdate` 在 Notion 写入失败时会将记录放入 outbox。同时，如果该 run 之后重试（`retry` schedule），会产生新的 Notion 写入。这可能导致：
- outbox 中的旧版本覆盖新版本
- 两个并发写入对同一 Notion page 产生冲突

**修复建议：**
在 outbox 处理时增加 "version" 或 "attempt" 比较，确保不会用旧的 attempt 覆盖新的：

```typescript
// outbox 中存储 attempt 信息
const out = JSON.parse(item.payload_json) as ExecutorOutput
const existing = this.repo.getRunIndex(out.account_id, out.wallet_id, out.task_type, bucket)
if (existing && existing.attempt > out.attempt) {
  // 新版本已写入，跳过旧版本
  this.repo.deleteOutboxItem(item.id)
  continue
}
```

---

## 5. 安全性

### 5.1 🟡 `generate-wallets.ts` 明文输出私钥

**位置：** [src/tools/generate-wallets.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/tools/generate-wallets.ts#L32-L43)

**问题描述：**
钱包生成工具直接将 `private_key` 写入 JSONL 文件：
```typescript
const rec = {
  wallet_id: walletId,
  address: w.address,
  private_key: w.privateKey,  // ← 明文
  created_at: now
}
```

虽然文件权限设为 600，且 文档建议使用加密存储，但工具本身的输出就是明文。如果运维人员忘记后续加密处理，私钥会以明文形式存在于文件系统中。

**修复建议：**
1. 增加 `--secret-ref-prefix` 参数，生成时用 `secret_ref` 引用代替明文
2. 增加 `--encrypt` 选项支持直接输出加密文件
3. 在工具输出的 stderr 上打印警告

---

### 5.2 🟡 `secret_ref` 使用 `file:` 协议读取明文文件

**位置：** [src/util/ref.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/util/ref.ts#L21-L28)

**问题描述：**
`resolveRef` 的 `file:` 方案直接从文件系统读取明文密钥，没有解密步骤。虽然文档提到了 AES-GCM 加密方案，但代码未实现。如果文件权限被错误配置，私钥可能被读取。

**修复建议：**
这是文档中提到的 "B 方案"（KMS/密钥环）和 "A 方案"（文件加密）的中间状态。建议：
1. 至少实现 AES-GCM 解密支持，在 `resolveRef` 中自动检测加密文件
2. 或明确文档化当前安全级别，并提供迁移到加密存储的路径

---

### 5.3 🟢 `BRNOO_LOG_LEVEL` 声明但未使用

**位置：** [src/logging.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/logging.ts)

**问题描述：**
`BRNOO_LOG_LEVEL` 环境变量在 `env.ts` 中被解析和校验，但 `logEvent()` 函数完全不检查 level，所有日志都输出。debug 级别的日志可能会在生产环境中泄露敏感信息。

**修复建议：**

```typescript
let currentLogLevel: LogLevel = "info"

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLogLevel]) return
  // ... existing logic
}
```

在 `index.ts` 启动时调用 `setLogLevel(env.BRNOO_LOG_LEVEL ?? "info")`。

---

## 6. 代码质量 & 可维护性

### 6.1 🟡 `planTask` 中 `pickWeightedPrompt` 未考虑 kind 权重

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L497-L522) `planTask()`

**问题描述：**
`planTask` 的逻辑是：
1. 按 `BRNOO_TASK_KIND_WEIGHTS` 权重随机选 kind
2. 从 bank 中过滤出该 kind 的 prompt
3. 用 `pickWeightedPrompt` 按权重选中一个 prompt

但 `pickWeightedPrompt` 对未设置 `weight` 的 prompt 使用默认值 1，且不会因为 kind 过滤而重新归一化。这在小样本下可能导致分布偏差。

**修复建议：**
当前实现在小样本下足够使用，不需要紧急修复。但可以增加单元测试验证分布均匀性。

---

### 6.2 🟡 `toNotionErrorType` 未使用

**位置：** [src/clients/notion.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/clients/notion.ts#L110-L117)

**问题描述：**
`toNotionErrorType` 函数被导出但从未被调用过。这是一个死代码。

**修复建议：**
删除或在合适的位置使用它（如在 `NotionRecorder.upsertRun` 的错误分类中）。

---

### 6.3 🟡 `ecosystem.config.cjs` 使用 `__dirname` 导致部署路径耦合

**位置：** [ecosystem.config.cjs](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/ecosystem.config.cjs#L6)

**问题描述：**
```javascript
cwd: __dirname,
```

文档说把 `ecosystem.config.cjs` 复制到 `/etc/blockrunnooor/` 再启动。但 `__dirname` 会指向 `/etc/blockrunnooor/` 而非 `/opt/blockrunnooor/`（代码安装目录）。pm2 的 `cwd` 会和 `script` 路径不一致。

**修复建议：**
硬编码为安装目录，或使用 `path.resolve(__dirname, '../../opt/blockrunnooor')` 等更明确的方式。最简单的方式：

```javascript
cwd: "/opt/blockrunnooor",
```

---

### 6.4 � `planTask` / `pickTaskKind` 中大量 `as any` 绕开类型系统 ✅ 已修复

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts)

**原问题：**
- `prompt-bank.ts` 中使用了 `(p as any).weight`（L45-L48），绕过了类型系统
- `orchestrator.ts` 中使用 `(p as any).kind`（L499, L543）
- `notion/runs.ts` 中使用 `delete (props as any).run_id`（L58）
- `parseWeights()` 中硬编码 `["chat", "surf", "predexon", "markets"]` 并与 TaskKind 解耦

**已实施的修复：**
- 新增 `promptKind()` 辅助函数替代所有 `(p as any).kind` 调用
- `parseWeights()` 改为用 `Set(["chat", ...API_KINDS])` 动态校验，不再硬编码旧枚举值
- `pickTaskKind()` 改用 `["chat", ...API_KINDS]` 遍历，自动适配任务类型变更

---

### 6.5 🟢 缺少单元测试和集成测试

**问题描述：**
项目没有任何测试文件。对于一个涉及资金操作、多钱包调度、Notion 写入的生产项目，缺乏测试覆盖是高风险状态。

**修复建议（按优先级）：**
1. 为 `StateRepo` 添加 SQLite 集成测试（最关键的逻辑层）
2. 为 `decide()` 函数添加单元测试（纯函数，容易测试）
3. 为 `makeRunId`、`scheduledBucket`、`stableJitter` 等纯函数添加单元测试
4. 为 `NotionClient` 和 `BlockRunClient` 添加 mock 测试
5. Mock 整个 Orchestrator 流程的集成测试

建议使用 `vitest` 或 `node:test`（Node.js 20+ 内置）。

---

## 7. 可观测性 & 运维

### 7.1 🟡 缺少健康检查端点

**问题描述：**
常驻进程没有暴露任何健康检查端口，无法被外部监控系统（如 Uptime Kuma、Prometheus Blackbox）探测。

**修复建议：**
添加一个可选的 HTTP 健康检查端点：

```typescript
// 在 Orchestrator 中:
import http from "node:http"

private startHealthServer(port: number): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        status: this.running ? "ok" : "stopping",
        inflight: this.inflight,
        uptime: process.uptime()
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port)
}
```

新增环境变量 `BRNOO_HEALTH_PORT`（可选，默认不启动）。

---

### 7.2 🟡 监控指标缺乏汇聚

**问题描述：**
日志以 JSON 行输出，但没有结构化的指标汇聚（如 Prometheus metrics）。当前需要手动从 SQLite 查询统计信息。

**修复建议：**
1. 在日志中补充周期性的聚合事件（如每 5 分钟输出一次 `stats_summary`，包含成功率、成本、延迟 p50/p95）
2. 或使用 `prom-client` 库暴露 `/metrics` 端点

---

### 7.3 � `notion/runs.ts` 中 `executor_host` 字段缺失 ✅ 已修复

**位置：** [src/notion/runs.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/notion/runs.ts)

**原问题：**
Notion Schema 文档（[05-notion-schema.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/05-notion-schema.md)）明确要求 `executor_host` 字段（机器名），但 `buildRunProperties()` 从未写入这个属性。`buildUpdatePayload` 中也存在 `as any` + delete 的硬编码字段排除方式。

**已实施的修复：**
- `runs.ts` 新增 `executor_host: richText(getHostname())`，主机名缓存避免重复调用 `os.hostname()`
- Schema 文档补上 `request_id` 字段说明

---

## 8. 性能优化建议

### 8.1 🟢 `scheduleLoop` 中每次都加载 wallet manifest 和 prompt bank

**位置：** [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L127-L130)

**问题描述：**
每个 tick（默认 5 秒）都会重新调用 `loadWalletManifest` 和 `loadPromptBank` 读取文件。当有 100 个钱包时，每 5 秒读取一次文件是不必要的。

**修复建议：**
添加缓存机制，基于文件 mtime 判断是否需要重新加载：

```typescript
private manifestCache = new Map<string, { mtime: number; data: Map<string, WalletManifestRecord> }>()
private promptBankCache = new Map<string, { mtime: number; data: PromptItem[] }>()

private getWalletManifest(path: string): Map<string, WalletManifestRecord> {
  const stat = fs.statSync(path)
  const cached = this.manifestCache.get(path)
  if (cached && cached.mtime === stat.mtimeMs) return cached.data
  const data = loadWalletManifest(path)
  this.manifestCache.set(path, { mtime: stat.mtimeMs, data })
  return data
}
```

---

### 8.2 🟢 NotionClient 每次请求都新建 AbortController

**位置：** [src/clients/notion.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/clients/notion.ts#L66-L67)

这本身不是问题（AbortController 开销很小），但如果 API 调用频率非常高，可以考虑复用。当前规模不需要优化。

---

### 8.3 🟢 SQLite 查询未使用预编译语句缓存

**位置：** [src/state/repo.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/state/repo.ts)

**问题描述：**
每次调用 `this.db.prepare(...)` 都会重新编译 SQL 语句。`better-sqlite3` 默认不缓存预编译语句，对于高频操作的 `getWallet`、`upsertRunIndex` 等方法，可以预先在构造函数中编译。

**修复建议：**
将高频语句提升为实例属性：

```typescript
export class StateRepo {
  private readonly stmtGetWallet: Database.Statement
  // ...

  constructor(private readonly db: DB) {
    this.stmtGetWallet = db.prepare("SELECT * FROM wallets WHERE account_id=? AND wallet_id=?")
    this.stmtUpsertRunIndex = db.prepare(`INSERT INTO runs_index(...) VALUES(...) ON CONFLICT(run_id) DO UPDATE ...`)
    // ...
  }

  getWallet(accountId: string, walletId: string): WalletRow | null {
    const row = this.stmtGetWallet.get(accountId, walletId) as WalletRow | undefined
    return row ?? null
  }
}
```

---

## 9. 文档与代码不一致

| 文档描述 | 代码实际 | 状态 |
|---------|---------|------|
| Kimi K2.6 fallback 路由 | 未实现，decision 硬编码 `"blockrun"` | 待实施 |
| `BRNOO_BLOCKRUN_PAID_RATIO` 默认 0.5 | 代码和 `.env.example` 一致，但 `defaultEnvValues.blockrunPaidRatio` 也是 0.5 | 一致 |
| `BRNOO_OUTBOX_POLL_SECONDS` 默认 10 秒 | `.env.example` 写的是 5 | ✅ 已统一为 10 |
| `BRNOO_BASE_INTERVAL_SECONDS` 默认 60 | `.env.example` 写的是 300 | 保留差异（代码默认 60 是安全保守值，示例 300 适用于生产） |
| systemd `ExecStart` 指向 `/opt/blockrunnooor/bin/orchestrator` | 实际入口是 `dist/index.js` | 待更新 |
| Notion Runs 的 `wallet_address` 脱敏 | 代码在 `maskAddress()` 中实现了脱敏 | 一致 |
| 私钥加密存储（AES-GCM） | `resolveRef` 只支持明文读取 | 文档超前于代码 |
| 模型池引用过时模型（`nvidia/gpt-oss-120b`、`nvidia/mistral-small-4-119b` 等） | 部分模型已下线/变化 | ✅ 已对齐 `/api/v1/models` 实时数据 |
| TaskKind 枚举（`surf`/`markets`）与实际 API 不符 | BlockRun 官方无 `surf`/`markets` 这两个独立分类 | ✅ 已对齐官方 API 分类 |
| `executor_host` 字段 | Schema 文档有但代码未写入 | ✅ 已修复 |
| `request_id` 字段 | 代码有但 Schema 文档未列出 | ✅ 已补入文档 |

---

## 10. 总结与优先级行动清单

### 🔴 高优先级（建议近期修复）

| # | 问题 | 影响 | 工作量 | 状态 |
|---|------|------|--------|------|
| 1 | Wallets 表主键改为 `(account_id, wallet_id)` | 多账号数据隔离 | 中等（需迁移脚本） | 待实施 |
| 2 | `max_cost_per_run_usd` 未校验 | 资金安全 | 小 | 待实施 |
| 3 | Notion Outbox 无限重试 | 资源泄露 | 小 | 待实施 |
| 4 | `last_run_at` 乐观更新 | 调度不准 | 小 | 待实施 |
| 5 | 调度循环无异常保护 | 稳定性 | 小 | 待实施 |
| 6 | `BRNOO_LOG_LEVEL` 未生效 | 安全和磁盘 | 小 | 待实施 |

### 🟡 中优先级（建议纳入下个迭代）

| # | 问题 | 影响 | 工作量 | 状态 |
|---|------|------|--------|------|
| 7 | Kimi K2.6 fallback 实现 | 业务连续性 | 大 | 待实施 |
| 8 | 优雅关闭（graceful shutdown） | 数据完整性 | 中等 | 待实施 |
| 9 | 熔断器完善（half-open 状态） | 恢复速度 | 中等 | 待实施 |
| 10 | `BlockRunClient` 重复代码消除 | 维护性 | 小 | 待实施 |
| 11 | Manifest/Prompt Bank 文件缓存 | 性能 | 小 | 待实施 |
| 12 | SQLite 预编译语句缓存 | 性能 | 小 | 待实施 |
| 13 | 健康检查端点 | 可观测性 | 小 | 待实施 |
| 14 | `ecosystem.config.cjs` cwd 修正 | 部署可靠性 | 小 | 待实施 |

### 🟢 低优先级（改进建议）

| # | 问题 | 影响 | 工作量 | 状态 |
|---|------|------|--------|------|
| 15 | 添加单元测试和集成测试 | 质量保障 | 大 | 待实施 |
| 16 | Notion outbox 版本/attempt 比较 | 数据一致性 | 小 | 待实施 |
| 17 | 周期性聚合指标日志 | 运维效率 | 小 | 待实施 |
| 18 | 消除 `as any` 类型断言 | 类型安全 | 小 | ✅ 已实施 |
| 19 | `notion/runs.ts` executor_host 缺失 | 数据完整性 | 小 | ✅ 已实施 |
| 20 | `generate-wallets.ts` 安全增强 | 安全 | 小 | 待实施 |
| 21 | TaskKind 对齐 BlockRun 官方 API 分类 | 业务准确性 | 中等 | ✅ 已实施 |
| 22 | `safeErrorMessage` 丢失嵌套错误详情 | 排障能力 | 小 | ✅ 已实施 |
| 23 | BlockRun API 调用失败时无请求日志 | 排障能力 | 小 | ✅ 已实施 |
| 24 | Prompt Bank / 配置文档过时（旧 kind、旧模型名） | 运维准确性 | 小 | ✅ 已实施 |

---

## 附录：模块依赖图

```
index.ts
├── config/env.ts          (环境变量校验, Zod schema)
├── config/accounts.ts     (账号配置加载)
├── state/db.ts            (SQLite 连接, WAL 模式)
├── state/migrations.ts    (Schema 迁移, 幂等执行)
├── state/repo.ts          (数据访问层, CRUD)
├── orchestrator/orchestrator.ts  (核心调度器)
│   ├── clients/blockrun.ts       (BlockRun SDK 封装)
│   ├── clients/notion.ts         (Notion API 封装)
│   ├── notion/recorder.ts        (Notion 写入编排)
│   │   └── notion/runs.ts        (Notion 属性构建)
│   ├── router/decision.ts        (路由决策逻辑)
│   ├── prompt-bank.ts            (Prompt 加载与抽取)
│   ├── wallet-manifest.ts        (钱包清单加载)
│   ├── util/semaphore.ts         (并发控制)
│   ├── util/time.ts              (时间工具)
│   ├── util/ref.ts               (密钥引用解析)
│   └── util/jsonl.ts             (JSONL 文件读取)
├── logging.ts              (结构化日志)
├── types.ts                (全局类型定义)
└── tools/generate-wallets.ts (钱包生成CLI)
```

---

*本文档基于对全部源代码文件和文档的完整阅读生成，覆盖了 `src/` 下的所有 17 个 TypeScript 文件和 `docs/` 下的全部 12 个文档文件。*

---

## 11. 已实施的改动（2026-06-24 会话）

### A. pm_002 / pm_008 422 错误排查与修复

**根因分析：** BlockRun API 返回 422 时响应体为 `{ error: { code: "...", message: "具体错误" } }`，`safeErrorMessage()` 只检查 `r.error` 是否为 string（实际是 object），导致 TypeScript 错误详情被丢弃，Notion 中只显示 "Bad Request"。

**已修改文件：**
- [src/clients/blockrun.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/clients/blockrun.ts#L290-L306) — `safeErrorMessage()` 支持嵌套错误对象，按序提取 `message` / `detail` / `error` / `code` / `reason`，找不到时兜底 `JSON.stringify`
- [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts#L251-L263) — BlockRun API 调用失败时新增结构化日志（`blockrun_call_failed` 事件），输出 `kind`、`method`、`path`、`status_code`、`error_type`、`error_message`

---

### B. TaskKind 对齐 BlockRun 官方 API 分类

**根因分析：** 旧的 `TaskKind` 只有 4 种（`chat` / `surf` / `predexon` / `markets`），其中 `surf` 和 `markets` 不在 BlockRun 官方 API 分类中。官方支持的 API 路径矩阵包括：AI Chat、Predexon、Search、Exa、Modal、US Stock、Global Stocks、Crypto、FX、Commodity。

**已修改文件：**
- [src/types.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/types.ts) — `TaskKind` 扩展为 10 种；新增 `TASK_KIND_LABELS` 映射和 `API_KINDS` 常量数组
- [src/prompt-bank.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/prompt-bank.ts) — Zod schema 的 `apiKindEnum` 从 `["surf","predexon","markets"]` 更新为 9 种新 API 类型
- [src/orchestrator/orchestrator.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/orchestrator/orchestrator.ts) — 新增 `promptKind()` 辅助函数消除 `as any`；`pickTaskKind()` 和 `parseWeights()` 改用 `["chat", ...API_KINDS]` 动态遍历

**破坏性变更：**
- 旧的 prompts.jsonl 中 `kind: "surf"` → 需改为 `kind: "search"` 或 `kind: "exa"`
- 旧的 `kind: "markets"` → 需按路径改为 `usstock` / `stocks` / `crypto` / `fx` / `commodity`

---

### C. 模型池更新（对齐 `/api/v1/models` 实时数据）

**根因分析：** `.env.example` 中引用的 `nvidia/gpt-oss-120b` 已下线，当前 BlockRun 提供的免费模型为 `nvidia/deepseek-v4-flash`、`nvidia/qwen3-coder-480b`、`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`、`nvidia/llama-4-maverick`、`nvidia/qwen3-next-80b-a3b-thinking`、`nvidia/mistral-small-4-119b`。

**已修改文件：**
- [.env.example](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/.env.example) — 免费/付费模型池全部替换为在线模型；`BRNOO_OUTBOX_POLL_SECONDS` 统一为 10；`BRNOO_BLOCKRUN_PAID_RATIO` 调整为 0.3；`BRNOO_TASK_KIND_WEIGHTS` 更新为新 kind

---

### D. Notion 写入字段对齐

**根因分析：** Schema 文档要求 `executor_host` 但代码未写入；代码写了 `request_id` 但文档未列出。逐字段比对确认其余 22 个字段全部匹配（包括类型 — 4 个 `richText`、5 个 `select`、7 个取值域 5 个 `number` 等）。

**已修改文件：**
- [src/notion/runs.ts](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/src/notion/runs.ts) — 新增 `executor_host: richText(getHostname())`，主机名缓存避免重复调用 `os.hostname()`
- [docs/05-notion-schema.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/05-notion-schema.md#L29-L30) — 补上 `request_id` 字段说明

---

### E. 文档全面更新

**已修改文件：**

| 文件 | 改动概要 |
|------|---------|
| [README.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/README.md) | 新增"支持的任务类别"表格（10 种 kind × BlockRun API 路径）；补充操作手册文档链接 |
| [docs/00-overview.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/00-overview.md) | 关键能力中补充"多任务类型"条目 |
| [docs/03-scheduling.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/03-scheduling.md) | 风控分级描述更新为具体任务类型示例（predexon tier2、modal、免费 list 类） |
| [docs/05-notion-schema.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/05-notion-schema.md) | 补上 `request_id` 字段；`executor_host` 标为必填 |
| [docs/08-operations-manual.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/08-operations-manual.md) | Prompt Bank 示例全部替换为真实有效路径；环境变量说明补充模型池和任务权重；kind 枚举更新为 10 种并标注对应 API |
| [docs/10-config-reference.md](file:///Users/lei/VibeCoding/TRAE-SOLO/Blockrunnooor/docs/10-config-reference.md) | 模型名称、任务权重示例全部更新；新增免费模型获取方法说明 |

---

### F. 修改文件的完整清单

```
代码文件 (8 个):
  src/types.ts                    ← TaskKind 扩展, API_KINDS/TASK_KIND_LABELS 新增
  src/prompt-bank.ts              ← Zod schema kind 枚举更新
  src/orchestrator/orchestrator.ts ← promptKind/pickTaskKind/parseWeights 重构
                                     blockrun_call_failed 日志
  src/clients/blockrun.ts         ← safeErrorMessage 嵌套错误对象提取
  src/notion/runs.ts              ← executor_host 写入 + 缓存
  src/config/env.ts               ← 无改动（仅确认 defaultEnvValues 一致性）
  .env.example                    ← 模型池、权重、超时值全面更新

文档文件 (7 个):
  README.md                       ← 任务类别表格
  docs/00-overview.md             ← 多任务类型
  docs/03-scheduling.md           ← 风控分级
  docs/05-notion-schema.md        ← request_id 补入
  docs/08-operations-manual.md    ← Prompt Bank 示例 + 参数说明
  docs/10-config-reference.md     ← 模型名称 + 权重示例
  review-optimization-plan.md     ← 本文件
```

