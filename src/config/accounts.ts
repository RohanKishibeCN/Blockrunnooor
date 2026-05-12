import fs from "node:fs"
import path from "node:path"
import { z } from "zod"

export const accountConfigSchema = z.object({
  account_id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  display_name: z.string().min(1).optional(),
  wallets_manifest_path: z.string().min(1),
  prompts_file: z.string().min(1).optional(),
  default_daily_budget_usd: z.number().positive().optional(),
  default_max_cost_per_run_usd: z.number().positive().optional(),
  status: z.enum(["active", "paused"]).optional(),
  tags: z.array(z.string().min(1)).optional()
})

export type AccountConfig = z.infer<typeof accountConfigSchema>

export function loadAccounts(accountsDir: string): AccountConfig[] {
  const items = fs.readdirSync(accountsDir, { withFileTypes: true })
  const cfgs: AccountConfig[] = []
  for (const it of items) {
    if (!it.isFile()) continue
    if (!it.name.endsWith(".json")) continue
    const p = path.join(accountsDir, it.name)
    const raw = fs.readFileSync(p, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    const cfg = accountConfigSchema.parse(parsed)
    cfgs.push(cfg)
  }
  cfgs.sort((a, b) => a.account_id.localeCompare(b.account_id))
  return cfgs
}

