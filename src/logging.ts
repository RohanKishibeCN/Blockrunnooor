import os from "node:os"

export type LogLevel = "debug" | "info" | "warn" | "error"

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    host: os.hostname(),
    ...fields
  }
  process.stdout.write(`${JSON.stringify(rec)}\n`)
}

