import type { AccountConfig } from "../config/accounts.js"
import { defaultEnvValues, type Env } from "../config/env.js"
import { BlockRunClient } from "../clients/blockrun.js"
import { NotionClient, backoffSeconds } from "../clients/notion.js"
import { logEvent } from "../logging.js"
import { NotionRecorder } from "../notion/recorder.js"
import { loadPromptBank, pickWeightedPrompt } from "../prompt-bank.js"
import { StateRepo } from "../state/repo.js"
import { API_KINDS, type Decision, type ExecutorOutput, type ErrorType, type PromptItem, type PromptItemApi, type PromptItemChat, type ScheduleType, type TaskKind } from "../types.js"
import { loadWalletManifest } from "../wallet-manifest.js"
import { decide } from "../router/decision.js"
import { Semaphore } from "../util/semaphore.js"
import { computeBackoff, makeRunId, nowEpoch, scheduledBucket, stableJitter } from "../util/time.js"
import { parseRef, resolveRef } from "../util/ref.js"

type TaskSpec = {
  account_id: string
  wallet_id: string
  task_type: string
  schedule_type: ScheduleType
  scheduled_at: number
  jitter_seconds: number
  attempt: number
  backoff_seconds: number
}

type PlannedTask =
  | {
      kind: "chat"
      prompt_id: string
      model?: string
      messages: unknown[]
      temperature?: number
      max_tokens?: number
    }
  | {
      kind: Exclude<TaskKind, "chat">
      prompt_id: string
      method: "GET" | "POST"
      path: string
      params?: Record<string, unknown>
      body?: Record<string, unknown>
    }

const API_PREFIX = "/api"

function resolveApiPath(requestedPath: string): string {
  if (requestedPath.startsWith(`${API_PREFIX}/`)) return requestedPath
  if (requestedPath.startsWith("/")) return `${API_PREFIX}${requestedPath}`
  return `${API_PREFIX}/${requestedPath}`
}

export class Orchestrator {
  private running = true

  private readonly globalSem: Semaphore
  private readonly accountSems = new Map<string, Semaphore>()
  private readonly walletSems = new Map<string, Semaphore>()
  private readonly walletFailures = new Map<string, number>()
  private readonly walletKeys = new Map<string, string>()
  private readonly walletsRunning = new Set<string>()
  private inflight = 0

  private readonly notion: NotionRecorder | null

  constructor(
    private readonly env: Env,
    private readonly repo: StateRepo,
    private readonly accounts: AccountConfig[]
  ) {
    const globalMax = env.BRNOO_GLOBAL_MAX_CONCURRENCY ?? defaultEnvValues.globalMaxConcurrency
    this.globalSem = new Semaphore(globalMax)

    const token = env.NOTION_TOKEN
    const dbId = env.NOTION_RUNS_DATABASE_ID
    if (token && dbId) {
      const notionTimeout = env.NOTION_TIMEOUT_SECONDS ?? defaultEnvValues.notionTimeoutSeconds
      const client = new NotionClient(token, notionTimeout)
      const version = env.BRNOO_ORCHESTRATOR_VERSION ?? defaultEnvValues.orchestratorVersion
      this.notion = new NotionRecorder(client, dbId, version)
    } else {
      this.notion = null
    }
  }

  async runForever(): Promise<void> {
    logEvent("info", "orchestrator_start", {
      version: this.env.BRNOO_ORCHESTRATOR_VERSION ?? defaultEnvValues.orchestratorVersion,
      accounts: this.accounts.map((a) => a.account_id)
    })

    await Promise.all([this.scheduleLoop(), this.outboxLoop()])
  }

  stop(): void {
    this.running = false
  }

  private accountSem(accountId: string): Semaphore {
    const existing = this.accountSems.get(accountId)
    if (existing) return existing
    const cap = this.env.BRNOO_PER_ACCOUNT_MAX_CONCURRENCY ?? defaultEnvValues.perAccountMaxConcurrency
    const sem = new Semaphore(cap)
    this.accountSems.set(accountId, sem)
    return sem
  }

  private walletSem(accountId: string, walletId: string): Semaphore {
    const key = `${accountId}:${walletId}`
    const existing = this.walletSems.get(key)
    if (existing) return existing
    const cap = this.env.BRNOO_PER_WALLET_MAX_CONCURRENCY ?? defaultEnvValues.perWalletMaxConcurrency
    const sem = new Semaphore(cap)
    this.walletSems.set(key, sem)
    return sem
  }

  private async scheduleLoop(): Promise<void> {
    const baseInterval = this.env.BRNOO_BASE_INTERVAL_SECONDS ?? defaultEnvValues.baseIntervalSeconds
    const jitterMax = this.env.BRNOO_JITTER_MAX_SECONDS ?? defaultEnvValues.jitterMaxSeconds
    const pollSeconds = this.env.BRNOO_SCHEDULER_POLL_SECONDS ?? defaultEnvValues.schedulerPollSeconds
    const walletOrder = this.env.BRNOO_WALLET_ORDER ?? defaultEnvValues.walletOrder
    const globalMax = this.env.BRNOO_GLOBAL_MAX_CONCURRENCY ?? defaultEnvValues.globalMaxConcurrency
    const maxQueue = Math.max(globalMax * 2, globalMax + 1)

    while (this.running) {
      const tickStart = nowEpoch()
      const day = new Date(tickStart * 1000).toISOString().slice(0, 10)

      for (const account of this.accounts) {
        const status = account.status ?? "active"
        this.repo.upsertAccount(account.account_id, status, account.display_name, tickStart)
        if (status !== "active") continue

        const walletManifest = loadWalletManifest(account.wallets_manifest_path)

        let promptBank: ReturnType<typeof loadPromptBank> | null = null
        if (account.prompts_file) promptBank = loadPromptBank(account.prompts_file)

        const dailyBudget = account.default_daily_budget_usd ?? 0
        const maxCostPerRun = account.default_max_cost_per_run_usd ?? 0

        const walletIds = Array.from(walletManifest.keys())
        if (walletOrder === "random") shuffleInPlace(walletIds)

        for (const walletId of walletIds) {
          const rec = walletManifest.get(walletId)
          if (!rec) continue

          this.repo.ensureWallet(account.account_id, walletId, dailyBudget, maxCostPerRun, day)
          this.repo.updateWalletIdentity(account.account_id, walletId, rec.address, rec.secret_ref)
          if (rec.private_key) {
            this.walletKeys.set(`${account.account_id}:${walletId}`, rec.private_key)
          }

          if (!promptBank || !promptBank.length) continue

          const walletKey = `${account.account_id}:${walletId}`
          if (this.walletsRunning.has(walletKey)) continue
          if (this.inflight >= maxQueue) break

          const wallet = this.repo.refreshDailySpentIfNeeded(account.account_id, walletId, day)
          if (!wallet) continue

          const earliest = wallet.last_run_at > 0
            ? wallet.last_run_at + baseInterval
            : tickStart - baseInterval
          const baseBucket = scheduledBucket(earliest, baseInterval)
          const jitter = stableJitter(`${account.account_id}|${walletId}|${baseBucket}`, jitterMax)
          const scheduledAt = earliest + jitter
          if (scheduledAt > tickStart) continue

          const task = planTask(promptBank, this.env)
          const spec: TaskSpec = {
            account_id: account.account_id,
            wallet_id: walletId,
            task_type: task.prompt_id,
            schedule_type: "cron",
            scheduled_at: scheduledAt,
            jitter_seconds: jitter,
            attempt: 1,
            backoff_seconds: 0
          }

          this.repo.touchWalletLastRun(account.account_id, walletId, tickStart)
          void this.runOnce(spec, task)
        }
      }

      const elapsed = nowEpoch() - tickStart
      const sleepFor = Math.max(1, pollSeconds - elapsed)
      await new Promise((r) => setTimeout(r, sleepFor * 1000))
    }
  }

  private async runOnce(spec: TaskSpec, task: PlannedTask): Promise<void> {
    const runningKey = `${spec.account_id}:${spec.wallet_id}`
    if (this.walletsRunning.has(runningKey)) return
    this.walletsRunning.add(runningKey)
    this.inflight += 1

    const bucketSeconds = this.env.BRNOO_BUCKET_SECONDS ?? defaultEnvValues.bucketSeconds
    const now = nowEpoch()
    const day = new Date(now * 1000).toISOString().slice(0, 10)

    const wallet = this.repo.refreshDailySpentIfNeeded(spec.account_id, spec.wallet_id, day)
    if (!wallet) {
      this.walletsRunning.delete(runningKey)
      this.inflight -= 1
      return
    }

    const circuit = this.repo.getCircuit(spec.account_id, "blockrun")
    const d = decide(wallet, circuit, now)

    const bucket = scheduledBucket(spec.scheduled_at, bucketSeconds)
    const runId = makeRunId(spec.account_id, spec.wallet_id, spec.task_type, bucket, this.env.BRNOO_RUN_ID_SALT)

    const idx = this.repo.getRunIndex(spec.account_id, spec.wallet_id, spec.task_type, bucket)
    const attempt = idx && spec.schedule_type === "retry" ? idx.attempt + 1 : spec.attempt

    if (d.decision === "deny") {
      const out = makeSkippedOutput(runId, spec, attempt, d.reason, maskAddress(wallet.address), safeHostname(this.env.BLOCKRUN_API_URL))
      this.repo.upsertRunIndex(runId, spec.account_id, spec.wallet_id, spec.task_type, bucket, attempt, idx?.notion_page_id ?? null, now)
      await this.recordAndUpdate(bucket, out, idx?.notion_page_id ?? null)
      this.repo.touchWalletLastRun(spec.account_id, spec.wallet_id, now)
      this.walletsRunning.delete(runningKey)
      this.inflight -= 1
      return
    }

    const releaseGlobal = await this.globalSem.acquire()
    const releaseAccount = await this.accountSem(spec.account_id).acquire()
    const releaseWallet = await this.walletSem(spec.account_id, spec.wallet_id).acquire()

    try {
      this.repo.upsertRunIndex(runId, spec.account_id, spec.wallet_id, spec.task_type, bucket, attempt, idx?.notion_page_id ?? null, now)

      const walletKey = this.resolveWalletKey(spec.account_id, spec.wallet_id)
      const brTimeout = this.env.BLOCKRUN_TIMEOUT_SECONDS ?? defaultEnvValues.blockrunTimeoutSeconds
      const client = new BlockRunClient(this.env.BLOCKRUN_API_URL, walletKey, brTimeout)

      const payload: Record<string, unknown> = {}
      let path = this.env.BLOCKRUN_CHAT_PATH
      if (task.kind === "chat") {
        payload.model = resolveChatModel(task.model, runId, this.env)
        payload.messages = task.messages
        if (typeof task.temperature === "number") payload.temperature = task.temperature
        if (typeof task.max_tokens === "number") payload.max_tokens = task.max_tokens
      } else {
        path = resolveApiPath(task.path)
        payload.method = task.method
        payload.path = path
        payload.params = task.params
        payload.body = task.body
        payload.label = `${task.kind}:${task.path}`
      }

      const resp = await client.call(path, payload)
      if (!resp.ok) {
        logEvent("warn", "blockrun_call_failed", {
          run_id: runId,
          account_id: spec.account_id,
          wallet_id: spec.wallet_id,
          kind: task.kind,
          method: typeof payload.method === "string" ? payload.method : "GET",
          path,
          status_code: resp.status_code,
          error_type: resp.error_type,
          error_message: resp.error_message
        })
      }
      const out = makeExecutorOutput(runId, spec, attempt, resp, maskAddress(wallet.address))

      await this.recordAndUpdate(bucket, out, idx?.notion_page_id ?? null)

      if (out.status === "success") {
        this.walletFailures.set(`${spec.account_id}:${spec.wallet_id}`, 0)
        if (out.total_cost !== null) this.repo.addSpent(spec.account_id, spec.wallet_id, out.total_cost, now)
        else this.repo.touchWalletLastRun(spec.account_id, spec.wallet_id, now)
        this.repo.upsertCircuit(spec.account_id, "blockrun", 0, 0)
        return
      }
      this.repo.touchWalletLastRun(spec.account_id, spec.wallet_id, now)

      const failuresKey = `${spec.account_id}:${spec.wallet_id}`
      const failures = (this.walletFailures.get(failuresKey) ?? 0) + 1
      this.walletFailures.set(failuresKey, failures)

      const circuitState = this.repo.getCircuit(spec.account_id, "blockrun")
      this.repo.upsertCircuit(spec.account_id, "blockrun", circuitState.failure_count + 1, circuitState.open_until)

      const walletFailureThreshold = this.env.BRNOO_WALLET_FAILURE_THRESHOLD ?? defaultEnvValues.walletFailureThreshold
      const walletCooldownSeconds = this.env.BRNOO_WALLET_COOLDOWN_SECONDS ?? defaultEnvValues.walletCooldownSeconds
      if (failures >= walletFailureThreshold) {
        this.repo.setCooldown(spec.account_id, spec.wallet_id, now + walletCooldownSeconds)
      }

      const circuitThreshold = this.env.BRNOO_CIRCUIT_FAILURE_THRESHOLD ?? defaultEnvValues.circuitFailureThreshold
      const circuitOpenSeconds = this.env.BRNOO_CIRCUIT_OPEN_SECONDS ?? defaultEnvValues.circuitOpenSeconds
      if (circuitState.failure_count + 1 >= circuitThreshold) {
        this.repo.upsertCircuit(spec.account_id, "blockrun", 0, now + circuitOpenSeconds)
      }

      const maxAttempts = this.env.BRNOO_MAX_ATTEMPTS ?? defaultEnvValues.maxAttempts
      if (attempt < maxAttempts && out.error_type && (out.error_type === "network" || out.error_type === "upstream" || out.error_type === "rate_limit")) {
        const bo = computeBackoff(this.env.BRNOO_BACKOFF_BASE_SECONDS ?? defaultEnvValues.backoffBaseSeconds, attempt, this.env.BRNOO_BACKOFF_MAX_SECONDS ?? defaultEnvValues.backoffMaxSeconds)
        const retrySpec: TaskSpec = {
          ...spec,
          schedule_type: "retry",
          scheduled_at: now + bo,
          jitter_seconds: 0,
          attempt: attempt + 1,
          backoff_seconds: bo
        }
        setTimeout(() => void this.runOnce(retrySpec, task), bo * 1000)
      }
    } finally {
      releaseWallet()
      releaseAccount()
      releaseGlobal()
      this.walletsRunning.delete(runningKey)
      this.inflight -= 1
    }
  }

  private resolveWalletKey(accountId: string, walletId: string): string | null {
    const envKey = this.env.BLOCKRUN_WALLET_KEY
    if (envKey) return envKey

    const memKey = this.walletKeys.get(`${accountId}:${walletId}`)
    if (memKey) return memKey

    const wallet = this.repo.getWallet(accountId, walletId)
    if (!wallet) return null

    if (wallet.secret_ref) {
      try {
        return resolveRef(parseRef(wallet.secret_ref))
      } catch {
        return null
      }
    }

    return null
  }

  private async recordAndUpdate(bucket: number, out: ExecutorOutput, notionPageId: string | null): Promise<void> {
    if (!this.notion) {
      logEvent("info", "run_record", { run_id: out.run_id, account_id: out.account_id, wallet_id: out.wallet_id, status: out.status })
      return
    }

    const res = await this.notion.upsertRun(out)
    if (res.ok && res.page_id) {
      this.repo.upsertRunIndex(out.run_id, out.account_id, out.wallet_id, out.task_type, bucket, out.attempt, res.page_id, nowEpoch())
      logEvent("info", "notion_upsert_ok", { run_id: out.run_id, page_id: res.page_id })
      return
    }

    if (!res.ok && res.retryable) {
      const now = nowEpoch()
      const backoffBase = this.env.NOTION_RETRY_BACKOFF_BASE_SECONDS ?? defaultEnvValues.notionRetryBackoffBaseSeconds
      const backoffMax = this.env.NOTION_RETRY_BACKOFF_MAX_SECONDS ?? defaultEnvValues.notionRetryBackoffMaxSeconds
      const nextRetry = now + backoffSeconds(backoffBase, 1, Math.min(60, backoffMax))
      this.repo.enqueueOutbox(out.account_id, out.run_id, JSON.stringify(out), nextRetry, 1, res.error)
      logEvent("warn", "notion_upsert_failed", { run_id: out.run_id, error: res.error, retryable: true })
      return
    }

    logEvent("warn", "notion_upsert_failed", { run_id: out.run_id, error: res.error, retryable: false })
    void notionPageId
  }

  private async outboxLoop(): Promise<void> {
    const poll = this.env.BRNOO_OUTBOX_POLL_SECONDS ?? defaultEnvValues.outboxPollSeconds
    if (!this.notion) {
      while (this.running) await new Promise((r) => setTimeout(r, 60_000))
      return
    }

    while (this.running) {
      const now = nowEpoch()
      for (const account of this.accounts) {
        const items = this.repo.popDueOutbox(account.account_id, now, 20)
        if (!items.length) continue
        for (const item of items) {
          let out: ExecutorOutput
          try {
            out = JSON.parse(item.payload_json) as ExecutorOutput
          } catch {
            this.repo.deleteOutboxItem(item.id)
            continue
          }
          const res = await this.notion.upsertRun(out)
          if (res.ok) {
            this.repo.deleteOutboxItem(item.id)
            continue
          }
          const backoffBase = this.env.NOTION_RETRY_BACKOFF_BASE_SECONDS ?? defaultEnvValues.notionRetryBackoffBaseSeconds
          const backoffMax = this.env.NOTION_RETRY_BACKOFF_MAX_SECONDS ?? defaultEnvValues.notionRetryBackoffMaxSeconds
          const nextRetry = now + backoffSeconds(backoffBase, item.attempt + 1, backoffMax)
          this.repo.updateOutboxItem(item.id, nextRetry, item.attempt + 1, res.error)
        }
      }
      await new Promise((r) => setTimeout(r, poll * 1000))
    }
  }
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = arr[i]
    arr[i] = arr[j] as T
    arr[j] = a as T
  }
}

function makeSkippedOutput(
  runId: string,
  spec: TaskSpec,
  attempt: number,
  reason: string,
  walletAddress: string | null,
  gateway: string | null
): ExecutorOutput {
  const errorType: ErrorType | null = reason.includes("budget") ? "budget" : "unknown"
  return {
    run_id: runId,
    account_id: spec.account_id,
    wallet_id: spec.wallet_id,
    wallet_address: walletAddress,
    task_type: spec.task_type,
    schedule_type: spec.schedule_type,
    attempt,
    decision: "deny",
    channel: "blockrun",
    gateway,
    model: null,
    status: "skipped",
    latency_ms: 0,
    total_cost: null,
    input_tokens: null,
    output_tokens: null,
    settlement_tx: null,
    request_id: null,
    error_type: errorType,
    error_code: reason,
    error_message: reason,
    jitter_seconds: spec.jitter_seconds,
    backoff_seconds: spec.backoff_seconds,
    created_at: new Date().toISOString()
  }
}

function makeExecutorOutput(
  runId: string,
  spec: TaskSpec,
  attempt: number,
  resp: {
    ok: boolean
    latency_ms: number
    model: string | null
    total_cost: number | null
    input_tokens: number | null
    output_tokens: number | null
    request_id: string | null
    error_type: ErrorType | null
    error_code: string | null
    error_message: string | null
    gateway: string | null
    settlement_tx: string | null
  },
  walletAddress: string | null
): ExecutorOutput {
  const status = resp.ok ? "success" : "failed"
  const decision: Decision = "blockrun"
  return {
    run_id: runId,
    account_id: spec.account_id,
    wallet_id: spec.wallet_id,
    wallet_address: walletAddress,
    task_type: spec.task_type,
    schedule_type: spec.schedule_type,
    attempt,
    decision,
    channel: "blockrun",
    gateway: resp.gateway,
    model: resp.model,
    status,
    latency_ms: resp.latency_ms,
    total_cost: resp.total_cost,
    input_tokens: resp.input_tokens,
    output_tokens: resp.output_tokens,
    settlement_tx: resp.settlement_tx,
    request_id: resp.request_id,
    error_type: resp.ok ? null : resp.error_type ?? "unknown",
    error_code: resp.ok ? null : resp.error_code,
    error_message: resp.ok ? null : resp.error_message,
    jitter_seconds: spec.jitter_seconds,
    backoff_seconds: spec.backoff_seconds,
    created_at: new Date().toISOString()
  }
}

function maskAddress(addr: string | null): string | null {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function planTask(bank: PromptItem[], env: Env): PlannedTask {
  const kind = pickTaskKind(bank, env)
  const candidates = bank.filter((p) => promptKind(p) === kind)
  const picked = pickWeightedPrompt(candidates.length ? candidates : bank) as PromptItem
  const pKind = promptKind(picked)
  if (pKind === "chat") {
    const chat = picked as PromptItemChat
    return {
      kind: "chat",
      prompt_id: chat.prompt_id,
      model: chat.model,
      messages: chat.messages,
      temperature: chat.temperature,
      max_tokens: chat.max_tokens
    }
  }
  const api = picked as PromptItemApi
  return {
    kind: api.kind,
    prompt_id: api.prompt_id,
    method: (api.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
    path: api.path,
    params: api.params,
    body: api.body
  }
}

function promptKind(p: PromptItem): TaskKind {
  if ((p as PromptItemChat).kind === undefined || (p as PromptItemChat).kind === "chat") return "chat"
  return (p as PromptItemApi).kind
}

function resolveChatModel(requestedModel: string | undefined, runId: string, env: Env): string {
  const m = typeof requestedModel === "string" ? requestedModel : ""
  if (m && m !== "random") return m

  const free = splitCsv(env.BRNOO_BLOCKRUN_MODELS_FREE)
  const paid = splitCsv(env.BRNOO_BLOCKRUN_MODELS_PAID)
  const ratio = env.BRNOO_BLOCKRUN_PAID_RATIO ?? defaultEnvValues.blockrunPaidRatio
  const paidThreshold = Math.max(0, Math.min(1, ratio))
  const wantsPaid = stableJitter(`${runId}|paid`, 9999) < Math.floor(paidThreshold * 10000)

  if (wantsPaid && paid.length) return pickStable(`${runId}|paidModel`, paid)
  if (!wantsPaid && free.length) return pickStable(`${runId}|freeModel`, free)
  if (paid.length) return pickStable(`${runId}|paidFallback`, paid)
  if (free.length) return pickStable(`${runId}|freeFallback`, free)
  return env.BRNOO_BLOCKRUN_MODEL
}

function pickTaskKind(bank: PromptItem[], env: Env): TaskKind {
  const available = new Set<TaskKind>()
  for (const p of bank) available.add(promptKind(p))

  const raw = env.BRNOO_TASK_KIND_WEIGHTS ?? defaultEnvValues.taskKindWeights
  const weights = parseWeights(raw)
  const items: Array<{ k: TaskKind; w: number }> = []

  const allKinds: TaskKind[] = ["chat" as const, ...API_KINDS]
  for (const k of allKinds) {
    if (!available.has(k)) continue
    const w = weights[k] ?? 0
    if (w > 0) items.push({ k, w })
  }
  if (!items.length) return "chat"
  return pickWeightedKey(items)
}

function splitCsv(s?: string): string[] {
  if (!s) return []
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

function parseWeights(s: string): Partial<Record<TaskKind, number>> {
  const validKinds = new Set<string>(["chat", ...API_KINDS])
  const out: Partial<Record<TaskKind, number>> = {}
  for (const part of s.split(",")) {
    const [k0, v0] = part.split("=").map((x) => x.trim())
    const k = k0 as TaskKind
    if (!k0 || !validKinds.has(k0)) continue
    const n = Number(v0)
    if (!Number.isFinite(n) || n <= 0) continue
    out[k] = Math.floor(n)
  }
  return out
}

function pickWeightedKey(items: Array<{ k: TaskKind; w: number }>): TaskKind {
  let total = 0
  for (const it of items) total += it.w
  let r = Math.random() * total
  for (const it of items) {
    r -= it.w
    if (r <= 0) return it.k
  }
  return items[items.length - 1]?.k ?? "chat"
}

function pickStable(key: string, arr: string[]): string {
  if (!arr.length) return ""
  const i = stableJitter(key, Math.max(0, arr.length - 1))
  return arr[i] as string
}
