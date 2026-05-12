import fs from "node:fs"

export function readJsonlFile<T>(filePath: string, parseLine: (obj: unknown, lineNo: number) => T): T[] {
  const raw = fs.readFileSync(filePath, "utf-8")
  const out: T[] = []
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      throw new Error(`invalid jsonl at ${filePath}:${i + 1}`)
    }
    out.push(parseLine(obj, i + 1))
  }
  return out
}

