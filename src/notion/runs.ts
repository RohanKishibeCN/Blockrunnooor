import type { ExecutorOutput } from "../types.js"

function title(s: string): Record<string, unknown> {
  return { title: [{ type: "text", text: { content: s } }] }
}

function richText(s: string): Record<string, unknown> {
  return { rich_text: [{ type: "text", text: { content: s } }] }
}

function select(s: string): Record<string, unknown> {
  return { select: { name: s } }
}

function number(n: number): Record<string, unknown> {
  return { number: n }
}

function date(iso: string): Record<string, unknown> {
  return { date: { start: iso } }
}

export function buildRunProperties(out: ExecutorOutput, orchestratorVersion: string): Record<string, unknown> {
  const props: Record<string, unknown> = {
    run_id: title(out.run_id),
    created_at: date(new Date(out.created_at).toISOString()),
    account_id: richText(out.account_id),
    wallet_id: richText(out.wallet_id),
    task_type: select(out.task_type),
    schedule_type: select(out.schedule_type),
    attempt: number(out.attempt),
    decision: select(out.decision),
    channel: select(out.channel),
    status: select(out.status),
    latency_ms: number(out.latency_ms),
    orchestrator_version: richText(orchestratorVersion)
  }
  if (out.wallet_address) props.wallet_address = richText(out.wallet_address)
  if (out.gateway) props.gateway = richText(out.gateway)
  if (out.model) props.model = richText(out.model)
  if (out.total_cost !== null) props.total_cost = number(out.total_cost)
  if (out.input_tokens !== null) props.input_tokens = number(out.input_tokens)
  if (out.output_tokens !== null) props.output_tokens = number(out.output_tokens)
  if (out.settlement_tx) props.settlement_tx = richText(out.settlement_tx)
  if (out.error_type) props.error_type = select(out.error_type)
  if (out.error_code) props.error_code = richText(out.error_code)
  if (out.error_message) props.error_message = richText(out.error_message)
  if (out.request_id) props.request_id = richText(out.request_id)
  return props
}

export function buildCreatePayload(databaseId: string, out: ExecutorOutput, orchestratorVersion: string): Record<string, unknown> {
  return { parent: { database_id: databaseId }, properties: buildRunProperties(out, orchestratorVersion) }
}

export function buildUpdatePayload(out: ExecutorOutput, orchestratorVersion: string): Record<string, unknown> {
  const props = buildRunProperties(out, orchestratorVersion)
  delete (props as any).run_id
  delete (props as any).created_at
  delete (props as any).wallet_id
  delete (props as any).task_type
  delete (props as any).schedule_type
  delete (props as any).account_id
  return { properties: props }
}
