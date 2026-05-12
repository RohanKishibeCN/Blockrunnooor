import fs from "node:fs"

export type Ref =
  | { kind: "env"; name: string }
  | { kind: "file"; path: string }

export function parseRef(s: string): Ref {
  if (s.startsWith("env:")) {
    const name = s.slice("env:".length)
    if (!name) throw new Error("invalid env ref")
    return { kind: "env", name }
  }
  if (s.startsWith("file:")) {
    const p = s.slice("file:".length)
    if (!p.startsWith("/")) throw new Error("file ref must be absolute path")
    return { kind: "file", path: p }
  }
  throw new Error("unsupported ref scheme")
}

export function resolveRef(ref: Ref): string {
  if (ref.kind === "env") {
    const v = process.env[ref.name]
    if (!v) throw new Error(`missing env ${ref.name}`)
    return v.trim()
  }
  return fs.readFileSync(ref.path, "utf-8").trim()
}

