import type { ExecutorOutput } from "../types.js"
import { NotionClient, NotionHttpError, safeErrorString } from "../clients/notion.js"
import { buildCreatePayload, buildUpdatePayload } from "./runs.js"

export type UpsertResult = {
  ok: boolean
  page_id: string | null
  error: string | null
  retryable: boolean
  status_code: number
}

export class NotionRecorder {
  constructor(
    private readonly client: NotionClient,
    private readonly runsDatabaseId: string,
    private readonly orchestratorVersion: string
  ) {}

  async upsertRun(out: ExecutorOutput): Promise<UpsertResult> {
    try {
      const pageId = await this.client.findPageByRunId(this.runsDatabaseId, out.run_id)
      if (pageId) {
        await this.client.updatePage(pageId, buildUpdatePayload(out, this.orchestratorVersion))
        return { ok: true, page_id: pageId, error: null, retryable: false, status_code: 200 }
      }
      const created = await this.client.createPage(buildCreatePayload(this.runsDatabaseId, out, this.orchestratorVersion))
      const pid = typeof created.id === "string" ? (created.id as string) : null
      return { ok: true, page_id: pid, error: null, retryable: false, status_code: 200 }
    } catch (e) {
      if (e instanceof NotionHttpError) {
        return {
          ok: false,
          page_id: null,
          error: `http_${e.statusCode}`,
          retryable: NotionClient.canRetryHttp(e.statusCode),
          status_code: e.statusCode
        }
      }
      return { ok: false, page_id: null, error: safeErrorString(e), retryable: true, status_code: 0 }
    }
  }
}
