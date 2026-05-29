import { APIError, BlockrunClient as GatewayClient, LLMClient, PaymentError, type ChatMessage } from "@blockrun/llm"
import type { ErrorType } from "../types.js"

export type BlockRunResponse = {
  ok: boolean
  status_code: number
  latency_ms: number
  json: unknown | null
  error_type: ErrorType | null
  error_code: string | null
  error_message: string | null
  request_id: string | null
  model: string | null
  total_cost: number | null
  input_tokens: number | null
  output_tokens: number | null
  gateway: string | null
  settlement_tx: string | null
}

export class BlockRunClient {
  private readonly gateway: string | null

  constructor(
    private readonly apiUrl: string,
    private readonly walletKey: string | null,
    private readonly timeoutSeconds: number
  ) {
    this.gateway = safeHostname(apiUrl)
  }

  async call(path: string, payload: Record<string, unknown>): Promise<BlockRunResponse> {
    if (path.includes("/v1/chat/completions")) return this.chat(payload)
    const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "GET"
    const apiPath = typeof payload.path === "string" ? payload.path : path
    const label = typeof payload.label === "string" ? payload.label : null
    if (method === "POST") return this.post(apiPath, payload.body as Record<string, unknown> | undefined, label)
    return this.get(apiPath, payload.params as Record<string, unknown> | undefined, label)
  }

  async chat(payload: Record<string, unknown>): Promise<BlockRunResponse> {
    const start = Date.now()
    const gateway = this.gateway
    try {
      const client = new LLMClient({
        privateKey: this.walletKey ?? undefined,
        apiUrl: this.apiUrl,
        timeout: this.timeoutSeconds * 1000
      })

      const model = typeof payload.model === "string" ? payload.model : ""
      const messages = Array.isArray(payload.messages) ? (payload.messages as ChatMessage[]) : []
      const temperature = typeof payload.temperature === "number" ? payload.temperature : undefined
      const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : undefined

      const before = client.getSpending()
      const resp = await client.chatCompletion(model, messages, { temperature, maxTokens })
      const after = client.getSpending()

      const latencyMs = Date.now() - start
      const rawCost = after.totalUsd - before.totalUsd
      const costUsd = Number.isFinite(rawCost) ? Math.max(0, rawCost) : null

      const usage = resp.usage
      const inputTokens = usage?.prompt_tokens ?? null
      const outputTokens = usage?.completion_tokens ?? null

      const effectiveModel = resp.fallback?.model ?? resp.model
      const settlementTx = extractSettlementTx(resp)

      return {
        ok: true,
        status_code: 200,
        latency_ms: latencyMs,
        json: resp,
        error_type: null,
        error_code: null,
        error_message: null,
        request_id: resp.id ?? null,
        model: typeof effectiveModel === "string" ? effectiveModel : null,
        total_cost: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : null,
        input_tokens: typeof inputTokens === "number" && Number.isFinite(inputTokens) ? inputTokens : null,
        output_tokens: typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : null,
        gateway,
        settlement_tx: settlementTx
      }
    } catch (e) {
      const latencyMs = Date.now() - start
      if (e instanceof APIError) {
        const status = e.statusCode
        const errorType: ErrorType =
          status === 402
            ? "budget"
            : status === 429
              ? "rate_limit"
              : status >= 500
                ? "upstream"
                : status >= 400
                  ? "validation"
                  : "unknown"
        const msg = safeErrorMessage(e.response, e.message)
        return {
          ok: false,
          status_code: status,
          latency_ms: latencyMs,
          json: e.response ?? null,
          error_type: errorType,
          error_code: status === 402 ? "payment_required" : String(status),
          error_message: msg,
          request_id: null,
          model: null,
          total_cost: null,
          input_tokens: null,
          output_tokens: null,
          gateway,
          settlement_tx: null
        }
      }
      if (e instanceof PaymentError) {
        return {
          ok: false,
          status_code: 402,
          latency_ms: latencyMs,
          json: null,
          error_type: "budget",
          error_code: "payment_error",
          error_message: safeErrorMessage(null, e.message),
          request_id: null,
          model: null,
          total_cost: null,
          input_tokens: null,
          output_tokens: null,
          gateway,
          settlement_tx: null
        }
      }
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        status_code: 0,
        latency_ms: latencyMs,
        json: null,
        error_type: "network",
        error_code: "request_error",
        error_message: msg.slice(0, 200),
        request_id: null,
        model: null,
        total_cost: null,
        input_tokens: null,
        output_tokens: null,
        gateway,
        settlement_tx: null
      }
    }
  }

  async get(path: string, params?: Record<string, unknown>, label?: string | null): Promise<BlockRunResponse> {
    return this.callApi("GET", path, params, undefined, label)
  }

  async post(path: string, body?: Record<string, unknown>, label?: string | null): Promise<BlockRunResponse> {
    return this.callApi("POST", path, undefined, body, label)
  }

  private async callApi(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    label?: string | null
  ): Promise<BlockRunResponse> {
    const start = Date.now()
    const gateway = this.gateway
    try {
      const client = new GatewayClient({
        privateKey: this.walletKey ?? undefined,
        apiUrl: this.apiUrl,
        timeout: this.timeoutSeconds * 1000
      })

      const before = client.getSpending()
      const resp = method === "POST" ? await client.post(path, body) : await client.get(path, params as any)
      const after = client.getSpending()

      const latencyMs = Date.now() - start
      const rawCost = after.totalUsd - before.totalUsd
      const costUsd = Number.isFinite(rawCost) ? Math.max(0, rawCost) : null

      const settlementTx = extractSettlementTx(resp)

      return {
        ok: true,
        status_code: 200,
        latency_ms: latencyMs,
        json: resp,
        error_type: null,
        error_code: null,
        error_message: null,
        request_id: null,
        model: label ? label.slice(0, 200) : null,
        total_cost: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : null,
        input_tokens: null,
        output_tokens: null,
        gateway,
        settlement_tx: settlementTx
      }
    } catch (e) {
      const latencyMs = Date.now() - start
      if (e instanceof APIError) {
        const status = e.statusCode
        const errorType: ErrorType =
          status === 402
            ? "budget"
            : status === 429
              ? "rate_limit"
              : status >= 500
                ? "upstream"
                : status >= 400
                  ? "validation"
                  : "unknown"
        const msg = safeErrorMessage(e.response, e.message)
        return {
          ok: false,
          status_code: status,
          latency_ms: latencyMs,
          json: e.response ?? null,
          error_type: errorType,
          error_code: status === 402 ? "payment_required" : String(status),
          error_message: msg,
          request_id: null,
          model: label ? label.slice(0, 200) : null,
          total_cost: null,
          input_tokens: null,
          output_tokens: null,
          gateway,
          settlement_tx: null
        }
      }
      if (e instanceof PaymentError) {
        return {
          ok: false,
          status_code: 402,
          latency_ms: latencyMs,
          json: null,
          error_type: "budget",
          error_code: "payment_error",
          error_message: safeErrorMessage(null, e.message),
          request_id: null,
          model: label ? label.slice(0, 200) : null,
          total_cost: null,
          input_tokens: null,
          output_tokens: null,
          gateway,
          settlement_tx: null
        }
      }
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        status_code: 0,
        latency_ms: latencyMs,
        json: null,
        error_type: "network",
        error_code: "request_error",
        error_message: msg.slice(0, 200),
        request_id: null,
        model: label ? label.slice(0, 200) : null,
        total_cost: null,
        input_tokens: null,
        output_tokens: null,
        gateway,
        settlement_tx: null
      }
    }
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function safeErrorMessage(response: unknown, fallback: string): string {
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>
    const msg = r.error ?? r.message
    if (typeof msg === "string" && msg) return msg.slice(0, 200)
  }
  return (fallback || "error").slice(0, 200)
}

function extractSettlementTx(resp: unknown): string | null {
  if (!resp || typeof resp !== "object") return null
  const r = resp as Record<string, unknown>
  const candidates = [r.settlement_tx, r.payment_receipt, r.paymentReceipt, r.txHash, r.tx, r.receipt]
  for (const c of candidates) {
    if (typeof c === "string" && c) return c
  }
  return null
}
