import type { ErrorType } from "../types"

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
}

export class BlockRunClient {
  constructor(
    private readonly apiUrl: string,
    private readonly walletKey: string | null,
    private readonly timeoutSeconds: number
  ) {}

  async call(path: string, payload: Record<string, unknown>): Promise<BlockRunResponse> {
    const url = `${this.apiUrl.replace(/\/+$/, "")}${path}`
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.walletKey) headers.Authorization = `Bearer ${this.walletKey}`

    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), this.timeoutSeconds * 1000)
    const start = Date.now()

    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ac.signal })
      const latencyMs = Date.now() - start
      const requestId = resp.headers.get("x-request-id") || resp.headers.get("request-id")

      let parsed: unknown | null = null
      const text = await resp.text()
      if (text.trim()) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }

      if (resp.ok) {
        const { model, totalCost, inTokens, outTokens, reqId } = extractSuccessFields(parsed)
        return {
          ok: true,
          status_code: resp.status,
          latency_ms: latencyMs,
          json: parsed,
          error_type: null,
          error_code: null,
          error_message: null,
          request_id: reqId ?? requestId,
          model,
          total_cost: totalCost,
          input_tokens: inTokens,
          output_tokens: outTokens
        }
      }

      const errorType: ErrorType =
        resp.status === 429 ? "rate_limit" : resp.status >= 500 ? "upstream" : resp.status >= 400 ? "validation" : "unknown"
      const msg = extractErrorMessage(parsed, text).slice(0, 200)
      return {
        ok: false,
        status_code: resp.status,
        latency_ms: latencyMs,
        json: parsed,
        error_type: errorType,
        error_code: String(resp.status),
        error_message: msg,
        request_id: requestId,
        model: null,
        total_cost: null,
        input_tokens: null,
        output_tokens: null
      }
    } catch (e) {
      const latencyMs = Date.now() - start
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        status_code: 0,
        latency_ms: latencyMs,
        json: null,
        error_type: "network",
        error_code: msg.includes("abort") ? "timeout" : "request_error",
        error_message: msg.slice(0, 200),
        request_id: null,
        model: null,
        total_cost: null,
        input_tokens: null,
        output_tokens: null
      }
    } finally {
      clearTimeout(t)
    }
  }
}

function extractSuccessFields(parsed: unknown): {
  model: string | null
  totalCost: number | null
  inTokens: number | null
  outTokens: number | null
  reqId: string | null
} {
  if (!parsed || typeof parsed !== "object") {
    return { model: null, totalCost: null, inTokens: null, outTokens: null, reqId: null }
  }
  const p = parsed as Record<string, unknown>
  const modelRaw = p.model ?? p.channel_model
  const model = typeof modelRaw === "string" ? modelRaw : null
  const reqIdRaw = p.request_id ?? p.id
  const reqId = typeof reqIdRaw === "string" ? reqIdRaw : null

  let totalCost: number | null = null
  let inTokens: number | null = null
  let outTokens: number | null = null

  const usage = p.usage
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>
    const inRaw = u.input_tokens ?? u.prompt_tokens
    const outRaw = u.output_tokens ?? u.completion_tokens
    const costRaw = u.total_cost ?? u.cost
    if (typeof inRaw === "number" && Number.isFinite(inRaw)) inTokens = inRaw
    if (typeof outRaw === "number" && Number.isFinite(outRaw)) outTokens = outRaw
    if (typeof costRaw === "number" && Number.isFinite(costRaw)) totalCost = costRaw
  }
  const totalCostRaw = p.total_cost
  if (typeof totalCostRaw === "number" && Number.isFinite(totalCostRaw)) totalCost = totalCostRaw

  return { model, totalCost, inTokens, outTokens, reqId }
}

function extractErrorMessage(parsed: unknown, fallbackText: string): string {
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>
    const msg = p.error ?? p.message
    if (typeof msg === "string" && msg) return msg
  }
  return fallbackText || "error"
}

