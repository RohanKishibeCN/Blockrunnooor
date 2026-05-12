export type ErrorType = "network" | "upstream" | "validation" | "budget" | "rate_limit" | "unknown"
export type Decision = "blockrun" | "fallback" | "deny"
export type RunStatus = "success" | "failed" | "skipped"
export type ScheduleType = "cron" | "random" | "retry"

export type ExecutorOutput = {
  run_id: string
  account_id: string
  wallet_id: string
  task_type: string
  schedule_type: ScheduleType
  attempt: number
  decision: Decision
  channel: string
  model: string | null
  status: RunStatus
  latency_ms: number
  total_cost: number | null
  input_tokens: number | null
  output_tokens: number | null
  request_id: string | null
  error_type: ErrorType | null
  error_code: string | null
  error_message: string | null
  jitter_seconds: number
  backoff_seconds: number
  created_at: string
}

export type PromptItem = {
  prompt_id: string
  model: string
  messages: unknown[]
  temperature?: number
  max_tokens?: number
}

export type WalletManifestRecord = {
  wallet_id: string
  address?: string
  private_key?: string
  secret_ref?: string
  created_at?: number
}
