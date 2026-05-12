import { loadAccounts } from "./config/accounts"
import { loadEnv } from "./config/env"
import { logEvent } from "./logging"
import { Orchestrator } from "./orchestrator/orchestrator"
import { openDb } from "./state/db"
import { applyMigrations } from "./state/migrations"
import { StateRepo } from "./state/repo"
import { nowEpoch } from "./util/time"

async function main(): Promise<void> {
  const env = loadEnv()

  const db = openDb(env.BRNOO_STATE_DB_PATH)
  applyMigrations(db, nowEpoch())
  const repo = new StateRepo(db)

  const accounts = loadAccounts(env.BRNOO_ACCOUNTS_DIR)
  if (!accounts.length) {
    throw new Error("no accounts loaded")
  }

  const orch = new Orchestrator(env, repo, accounts)

  const shutdown = (sig: string) => {
    logEvent("info", "orchestrator_stop", { signal: sig })
    orch.stop()
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  await orch.runForever()
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e)
  logEvent("error", "fatal", { error: msg.slice(0, 200) })
  process.exitCode = 1
})
