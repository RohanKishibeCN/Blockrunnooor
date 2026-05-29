import type { ErrorType } from "../types.js"

export type NotionUpsertResult =
  | { ok: true; page_id: string | null }
  | { ok: false; error: string; retryable: boolean; status_code: number }

export class NotionClient {
  private readonly baseUrl = "https://api.notion.com/v1"

  constructor(
    private readonly token: string,
    private readonly timeoutSeconds: number
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    }
  }

  async queryDatabase(databaseId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/databases/${databaseId}/query`
    return this.postJson(url, payload)
  }

  async createPage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/pages`
    return this.postJson(url, payload)
  }

  async updatePage(pageId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/pages/${pageId}`
    return this.patchJson(url, payload)
  }

  async findPageByRunId(databaseId: string, runId: string): Promise<string | null> {
    const q: Record<string, unknown> = {
      filter: {
        property: "run_id",
        title: { equals: runId }
      }
    }
    const data = await this.queryDatabase(databaseId, q)
    const results = data.results
    if (!Array.isArray(results) || !results.length) return null
    const page = results[0] as Record<string, unknown>
    const id = page.id
    return typeof id === "string" ? id : null
  }

  static canRetryHttp(status: number): boolean {
    return status === 408 || status === 409 || status === 429 || status >= 500
  }

  private async postJson(url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson("POST", url, payload)
  }

  private async patchJson(url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson("PATCH", url, payload)
  }

  private async requestJson(method: string, url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), this.timeoutSeconds * 1000)
    try {
      const resp = await fetch(url, { method, headers: this.headers(), body: JSON.stringify(payload), signal: ac.signal })
      const text = await resp.text()
      let parsed: unknown = {}
      if (text.trim()) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = { raw: text }
        }
      }
      if (!resp.ok) {
        const err = typeof (parsed as any)?.message === "string" ? (parsed as any).message : `http_${resp.status}`
        throw new NotionHttpError(resp.status, err)
      }
      return (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}) as Record<string, unknown>
    } finally {
      clearTimeout(t)
    }
  }
}

export class NotionHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

export function backoffSeconds(base: number, attempt: number, maxSeconds: number): number {
  const raw = attempt <= 1 ? base : base * 2 ** (attempt - 1)
  const jitter = Math.random()
  return Math.min(Math.floor(raw + jitter), maxSeconds)
}

export function safeErrorString(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  return s.length > 200 ? s.slice(0, 200) : s
}

export function toNotionErrorType(e: unknown): ErrorType {
  if (e instanceof NotionHttpError) {
    if (e.statusCode === 429) return "rate_limit"
    if (e.statusCode >= 500) return "upstream"
    if (e.statusCode >= 400) return "validation"
  }
  return "unknown"
}
