import { z } from "zod"
import type { PromptItem } from "./types"
import { readJsonlFile } from "./util/jsonl"

const promptSchema = z.object({
  prompt_id: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(z.unknown()),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional()
})

export function loadPromptBank(filePath: string): PromptItem[] {
  return readJsonlFile(filePath, (obj) => promptSchema.parse(obj))
}

export function pickRandomPrompt(bank: PromptItem[]): PromptItem {
  if (!bank.length) throw new Error("empty prompt bank")
  const i = Math.floor(Math.random() * bank.length)
  return bank[i] as PromptItem
}

