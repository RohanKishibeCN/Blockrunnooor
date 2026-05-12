import type { AccountConfig } from "../config/accounts"
import { defaultEnvValues, type Env } from "../config/env"
import { BlockRunClient } from "../clients/blockrun"
import { NotionClient, backoffSeconds } from "../clients/notion"
import { logEvent } from "../logging"
import { NotionRecorder } from "../notion/recorder"
import { loadPromptBank, pickRandomPrompt } from "../prompt-bank"
import { StateRepo } from "../state/repo"
import type { Decision, ExecutorOutput, ErrorType, ScheduleType } from "../types"
import { loadWalletManifest } from "../wallet-manifest"
import { decide } from "../router/decision"
import { Semaphore } from "../util/semaphore"
import { computeBackoff, makeRunId, nowEpoch, pickJitter, scheduledBucket } from "../util/time"
import { parseRef, resolveRef } from "../util/ref"

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

export class Orchestrator {
  private running = true

  private readonly globalSem: Semaphore
  private readonly accountSems = new Map<string, Semaphore>()
  private readonly walletSems = new Map<string, Semaphore>()
  private readonly walletFailures = new Map<string, number>()
  private readonly walletKeys = new Map<string, string>()

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

        for (const [walletId, rec] of walletManifest.entries()) {
          this.repo.ensureWallet(account.account_id, walletId, dailyBudget, maxCostPerRun, day)
          this.repo.updateWalletIdentity(account.account_id, walletId, rec.address, rec.secret_ref)
          if (rec.private_key) {
            this.walletKeys.set(`${account.account_id}:${walletId}`, rec.private_key)
          }

          if (!promptBank || !promptBank.length) continue

          const prompt = pickRandomPrompt(promptBank)
          const jitter = pickJitter(jitterMax)
          const scheduledAt = tickStart + jitter

          const spec: TaskSpec = {
            account_id: account.account_id,
            wallet_id: walletId,
            task_type: prompt.prompt_id,
            schedule_type: "cron",
            scheduled_at: scheduledAt,
            jitter_seconds: jitter,
            attempt: 1,
            backoff_seconds: 0
          }

          setTimeout(() => {
            void this.runOnce(spec, prompt.model, prompt)
          }, Math.max(0, (scheduledAt - nowEpoch()) * 1000))
        }
      }

      const elapsed = nowEpoch() - tickStart
      const sleepFor = Math.max(0, baseInterval - elapsed)
      await new Promise((r) => setTimeout(r, sleepFor * 1000))
    }
  }

  private async runOnce(spec: TaskSpec, blockrunModel: string, prompt: { messages: unknown[]; temperature?: number; max_tokens?: number }): Promise<void> {
    const bucketSeconds = this.env.BRNOO_BUCKET_SECONDS ?? defaultEnvValues.bucketSeconds
    const now = nowEpoch()
    const day = new Date(now * 1000).toISOString().slice(0, 10)

    const wallet = this.repo.refreshDailySpentIfNeeded(spec.account_id, spec.wallet_id, day)
    if (!wallet) return

    const circuit = this.repo.getCircuit(spec.account_id, "blockrun")
    const d = decide(wallet, circuit, now)

    const bucket = scheduledBucket(spec.scheduled_at, bucketSeconds)
    const runId = makeRunId(spec.account_id, spec.wallet_id, spec.task_type, bucket, this.env.BRNOO_RUN_ID_SALT)

    const idx = this.repo.getRunIndex(spec.account_id, spec.wallet_id, spec.task_type, bucket)
    const attempt = idx && spec.schedule_type === "retry" ? idx.attempt + 1 : spec.attempt

    if (d.decision === "deny") {
      const out = makeSkippedOutput(runId, spec, attempt, d.reason)
      this.repo.upsertRunIndex(runId, spec.account_id, spec.wallet_id, spec.task_type, bucket, attempt, idx?.notion_page_id ?? null, now)
      await this.recordAndUpdate(bucket, out, idx?.notion_page_id ?? null)
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

      const payload: Record<string, unknown> = {
        model: blockrunModel,
        messages: prompt.messages
      }
      if (typeof prompt.temperature === "number") payload.temperature = prompt.temperature
      if (typeof prompt.max_tokens === "number") payload.max_tokens = prompt.max_tokens

      const resp = await client.call(this.env.BLOCKRUN_CHAT_PATH, payload)
      const out = makeExecutorOutput(runId, spec, attempt, resp)

      await this.recordAndUpdate(bucket, out, idx?.notion_page_id ?? null)

      if (out.status === "success") {
        this.walletFailures.set(`${spec.account_id}:${spec.wallet_id}`, 0)
        if (out.total_cost !== null) this.repo.addSpent(spec.account_id, spec.wallet_id, out.total_cost, now)
        this.repo.upsertCircuit(spec.account_id, "blockrun", 0, 0)
        return
      }

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
        setTimeout(() => void this.runOnce(retrySpec, blockrunModel, prompt), bo * 1000)
      }
    } finally {
      releaseWallet()
      releaseAccount()
      releaseGlobal()
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
      const nextRetry = now + backoffSeconds(2, 1, 60)
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
          const nextRetry = now + backoffSeconds(2, item.attempt + 1, 300)
          this.repo.updateOutboxItem(item.id, nextRetry, item.attempt + 1, res.error)
        }
      }
      await new Promise((r) => setTimeout(r, poll * 1000))
    }
  }
}

function makeSkippedOutput(runId: string, spec: TaskSpec, attempt: number, reason: string): ExecutorOutput {
  const errorType: ErrorType | null = reason.includes("budget") ? "budget" : "unknown"
  return {
    run_id: runId,
    account_id: spec.account_id,
    wallet_id: spec.wallet_id,
    task_type: spec.task_type,
    schedule_type: spec.schedule_type,
    attempt,
    decision: "deny",
    channel: "blockrun",
    model: null,
    status: "skipped",
    latency_ms: 0,
    total_cost: null,
    input_tokens: null,
    output_tokens: null,
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
  }
): ExecutorOutput {
  const status = resp.ok ? "success" : "failed"
  const decision: Decision = "blockrun"
  return {
    run_id: runId,
    account_id: spec.account_id,
    wallet_id: spec.wallet_id,
    task_type: spec.task_type,
    schedule_type: spec.schedule_type,
    attempt,
    decision,
    channel: "blockrun",
    model: resp.model,
    status,
    latency_ms: resp.latency_ms,
    total_cost: resp.total_cost,
    input_tokens: resp.input_tokens,
    output_tokens: resp.output_tokens,
    request_id: resp.request_id,
    error_type: resp.ok ? null : resp.error_type ?? "unknown",
    error_code: resp.ok ? null : resp.error_code,
    error_message: resp.ok ? null : resp.error_message,
    jitter_seconds: spec.jitter_seconds,
    backoff_seconds: spec.backoff_seconds,
    created_at: new Date().toISOString()
  }
}
