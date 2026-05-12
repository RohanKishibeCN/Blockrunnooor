import fs from "node:fs"
import path from "node:path"
import { Wallet } from "ethers"

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a || !a.startsWith("--")) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (!v || v.startsWith("--")) continue
    out[k] = v
    i += 1
  }
  return out
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const count = Number(args.count ?? "0")
  const outPath = args.out
  const prefix = args.prefix ?? "wallet_"

  if (!Number.isInteger(count) || count <= 0) throw new Error("invalid --count")
  if (!outPath) throw new Error("missing --out")

  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const lines: string[] = []
  const now = Math.floor(Date.now() / 1000)
  for (let i = 0; i < count; i += 1) {
    const w = Wallet.createRandom()
    const walletId = `${prefix}${String(i + 1).padStart(4, "0")}`
    const rec = {
      wallet_id: walletId,
      address: w.address,
      private_key: w.privateKey,
      created_at: now
    }
    lines.push(JSON.stringify(rec))
  }
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 })
  process.stdout.write(`${outPath}\n`)
}

main()

