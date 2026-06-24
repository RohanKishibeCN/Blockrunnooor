import { z } from "zod"
import type { PromptItem } from "./types.js"
import { readJsonlFile } from "./util/jsonl.js"

const chatSchema = z.object({
  kind: z.literal("chat").optional(),
  prompt_id: z.string().min(1),
  weight: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  messages: z.array(z.unknown()),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional()
})

const apiKindEnum = z.enum([
  "predexon",
  "search",
  "exa",
  "modal",
  "usstock",
  "stocks",
  "crypto",
  "fx",
  "commodity"
])

const apiSchema = z.object({
  kind: apiKindEnum,
  prompt_id: z.string().min(1),
  weight: z.number().int().positive().optional(),
  method: z.enum(["GET", "POST"]).optional(),
  path: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  body: z.record(z.unknown()).optional()
})

const promptSchema = z.preprocess((v) => {
  if (!v || typeof v !== "object") return v
  const r = v as Record<string, unknown>
  if (typeof r.kind === "string") return v
  return { ...r, kind: "chat" }
}, z.discriminatedUnion("kind", [chatSchema, apiSchema]))

export function loadPromptBank(filePath: string): PromptItem[] {
  return readJsonlFile(filePath, (obj) => promptSchema.parse(obj))
}

export function pickRandomPrompt(bank: PromptItem[]): PromptItem {
  if (!bank.length) throw new Error("empty prompt bank")
  const i = Math.floor(Math.random() * bank.length)
  return bank[i] as PromptItem
}

export function pickWeightedPrompt(bank: PromptItem[]): PromptItem {
  if (!bank.length) throw new Error("empty prompt bank")
  let total = 0
  for (const p of bank) total += typeof (p as any).weight === "number" ? (p as any).weight : 1
  let r = Math.random() * total
  for (const p of bank) {
    r -= typeof (p as any).weight === "number" ? (p as any).weight : 1
    if (r <= 0) return p
  }
  return bank[bank.length - 1] as PromptItem
}
