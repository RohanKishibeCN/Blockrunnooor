import { z } from "zod"

const envSchema = z.object({
  BRNOO_ENV_FILE: z.string().min(1).optional(),

  BRNOO_STATE_DB_PATH: z.string().min(1),
  BRNOO_ACCOUNTS_DIR: z.string().min(1).optional(),
  BRNOO_ACCOUNTS_JSON: z.string().min(1).optional(),
  BRNOO_RUN_ID_SALT: z.string().min(1),

  BRNOO_ORCHESTRATOR_VERSION: z.string().min(1).optional(),

  BRNOO_BASE_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  BRNOO_JITTER_MAX_SECONDS: z.coerce.number().int().nonnegative().optional(),
  BRNOO_BUCKET_SECONDS: z.coerce.number().int().positive().optional(),
  BRNOO_SCHEDULER_POLL_SECONDS: z.coerce.number().int().positive().optional(),
  BRNOO_WALLET_ORDER: z.enum(["sequential", "random"]).optional(),

  BRNOO_GLOBAL_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),
  BRNOO_PER_ACCOUNT_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),
  BRNOO_PER_WALLET_MAX_CONCURRENCY: z.coerce.number().int().positive().optional(),

  BRNOO_MAX_ATTEMPTS: z.coerce.number().int().positive().optional(),
  BRNOO_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().optional(),
  BRNOO_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().optional(),

  BRNOO_WALLET_FAILURE_THRESHOLD: z.coerce.number().int().positive().optional(),
  BRNOO_WALLET_COOLDOWN_SECONDS: z.coerce.number().int().positive().optional(),
  BRNOO_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().optional(),
  BRNOO_CIRCUIT_OPEN_SECONDS: z.coerce.number().int().positive().optional(),

  BRNOO_OUTBOX_POLL_SECONDS: z.coerce.number().int().positive().optional(),

  BLOCKRUN_API_URL: z.string().min(1),
  BLOCKRUN_CHAT_PATH: z.string().min(1),
  BLOCKRUN_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),
  BLOCKRUN_WALLET_KEY: z.string().min(1).optional(),

  NOTION_TOKEN: z.string().min(1).optional(),
  NOTION_RUNS_DATABASE_ID: z.string().min(1).optional(),
  NOTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),

  BRNOO_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional()
}).superRefine((v, ctx) => {
  if (!v.BRNOO_ACCOUNTS_DIR && !v.BRNOO_ACCOUNTS_JSON) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BRNOO_ACCOUNTS_DIR or BRNOO_ACCOUNTS_JSON is required"
    })
  }
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(): Env {
  return envSchema.parse(process.env)
}

export const defaultEnvValues = {
  orchestratorVersion: "0.2.0",
  baseIntervalSeconds: 60,
  jitterMaxSeconds: 10,
  bucketSeconds: 60,
  schedulerPollSeconds: 5,
  walletOrder: "sequential" as const,
  globalMaxConcurrency: 10,
  perAccountMaxConcurrency: 5,
  perWalletMaxConcurrency: 1,
  maxAttempts: 3,
  backoffBaseSeconds: 2,
  backoffMaxSeconds: 30,
  walletFailureThreshold: 3,
  walletCooldownSeconds: 300,
  circuitFailureThreshold: 10,
  circuitOpenSeconds: 60,
  outboxPollSeconds: 10,
  blockrunTimeoutSeconds: 30,
  notionTimeoutSeconds: 15,
  logLevel: "info" as const
}
