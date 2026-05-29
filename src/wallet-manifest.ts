import { z } from "zod"
import type { WalletManifestRecord } from "./types.js"
import { readJsonlFile } from "./util/jsonl.js"

const walletSchema = z.object({
  wallet_id: z.string().min(1),
  address: z.string().min(1).optional(),
  private_key: z.string().min(1).optional(),
  secret_ref: z.string().min(1).optional(),
  created_at: z.number().int().optional()
})

export function loadWalletManifest(filePath: string): Map<string, WalletManifestRecord> {
  const recs = readJsonlFile(filePath, (obj) => walletSchema.parse(obj))
  const m = new Map<string, WalletManifestRecord>()
  for (const r of recs) m.set(r.wallet_id, r)
  return m
}
