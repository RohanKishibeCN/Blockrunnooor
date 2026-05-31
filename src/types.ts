export type ErrorType = "network" | "upstream" | "validation" | "budget" | "rate_limit" | "unknown"
export type Decision = "blockrun" | "fallback" | "deny"
export type RunStatus = "success" | "failed" | "skipped"
export type ScheduleType = "cron" | "random" | "retry"
export type TaskKind = "chat" | "surf" | "predexon" | "markets"

export type ExecutorOutput = {
  run_id: string
  account_id: string
  wallet_id: string
  wallet_address: string | null
  task_type: string
  schedule_type: ScheduleType
  attempt: number
  decision: Decision
  channel: string
  gateway: string | null
  model: string | null
  status: RunStatus
  latency_ms: number
  total_cost: number | null
  input_tokens: number | null
  output_tokens: number | null
  settlement_tx: string | null
  request_id: string | null
  error_type: ErrorType | null
  error_code: string | null
  error_message: string | null
  jitter_seconds: number
  backoff_seconds: number
  created_at: string
}

export type PromptItemChat = {
  prompt_id: string
  kind?: "chat"
  weight?: number
  model?: string
  messages: unknown[]
  temperature?: number
  max_tokens?: number
}

export type PromptItemApi = {
  prompt_id: string
  kind: Exclude<TaskKind, "chat">
  weight?: number
  method?: "GET" | "POST"
  path: string
  params?: Record<string, unknown>
  body?: Record<string, unknown>
}

export type PromptItem = PromptItemChat | PromptItemApi

export type WalletManifestRecord = {
  wallet_id: string
  address?: string
  private_key?: string
  secret_ref?: string
  created_at?: number
}
