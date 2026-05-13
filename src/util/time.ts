import crypto from "node:crypto"

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000)
}

export function scheduledBucket(epochSeconds: number, bucketSeconds: number): number {
  return Math.floor(epochSeconds / bucketSeconds) * bucketSeconds
}

export function stableJitter(key: string, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0
  const h = crypto.createHash("sha256")
  h.update(key)
  const hex = h.digest("hex").slice(0, 8)
  const n = Number.parseInt(hex, 16)
  return n % (maxSeconds + 1)
}

export function pickJitter(maxSeconds: number): number {
  if (maxSeconds <= 0) return 0
  return Math.floor(Math.random() * (maxSeconds + 1))
}

export function computeBackoff(baseSeconds: number, attempt: number, maxSeconds: number): number {
  const raw = attempt <= 1 ? baseSeconds : baseSeconds * 2 ** (attempt - 1)
  const jitter = Math.random()
  return Math.min(Math.floor(raw + jitter), maxSeconds)
}

export function makeRunId(accountId: string, walletId: string, taskType: string, bucket: number, salt: string): string {
  const h = crypto.createHash("sha256")
  h.update(`${accountId}|${walletId}|${taskType}|${bucket}|${salt}`)
  return h.digest("hex").slice(0, 32)
}
