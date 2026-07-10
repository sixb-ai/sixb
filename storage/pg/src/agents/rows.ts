import {
  type AgentMessagePart,
  type AgentMessageRecord,
  type AgentRunDiagnostic,
  type AgentRunRecord,
  type AgentRunUsage,
  type AgentThreadRecord,
  coerceAgentRunFinishReason,
  type Principal,
  SYSTEM_PRINCIPAL,
} from "@sixb/core"
import type { SQLClient, SqlParameter } from "../pg-client"

// ── row shapes (porsager returns timestamptz as Date, jsonb parsed, int as number — typed loosely
//    to tolerate the string forms some drivers/poolers surface) ──────────────────────────────────

export interface AgentThreadRow {
  project_id: string
  id: string
  agent_id: string
  owner_principal_type: Principal["type"]
  owner_principal_id: string
  title: string | null
  status: AgentThreadRecord["status"]
  active_run_id: string | null
  last_message_at: Date | string | null
  message_count: number | string
  created_at: Date | string
  updated_at: Date | string
}

export interface AgentRunRow {
  project_id: string
  id: string
  thread_id: string
  agent_id: string
  trigger_message_id: string
  requested_by_principal_type: Principal["type"] | null
  requested_by_principal_id: string | null
  execution_principal_type: "serviceAccount" | null
  execution_principal_id: string | null
  status: AgentRunRecord["status"]
  model_id: string | null
  finish_reason: string | null
  usage_input_tokens: number | string | null
  usage_output_tokens: number | string | null
  usage_total_tokens: number | string | null
  usage_reasoning_tokens: number | string | null
  usage_cached_input_tokens: number | string | null
  error: string | null
  diagnostics: AgentRunDiagnostic[] | string | null
  attempt: number | string
  lease_id: string | null
  lease_expires_at: Date | string | null
  created_at: Date | string
  started_at: Date | string | null
  completed_at: Date | string | null
}

export interface AgentMessageRow {
  project_id: string
  id: string
  thread_id: string
  run_id: string | null
  role: AgentMessageRecord["role"]
  author_principal_type: Principal["type"] | null
  author_principal_id: string | null
  seq: number | string
  parts: AgentMessagePart[] | string
  metadata: unknown
  content_version: number | string
  created_at: Date | string
  completed_at: Date | string | null
}

// ── row → record mappers ────────────────────────────────────────────────────────────────────────

export function rowToThreadRecord(row: AgentThreadRow): AgentThreadRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    ownerPrincipal: { type: row.owner_principal_type, id: row.owner_principal_id },
    title: row.title ?? undefined,
    status: row.status,
    activeRunId: row.active_run_id,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : undefined,
    messageCount: Number(row.message_count),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export function rowToRunRecord(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    triggerMessageId: row.trigger_message_id,
    requestedByPrincipal:
      principalFromColumns(row.requested_by_principal_type, row.requested_by_principal_id) ??
      SYSTEM_PRINCIPAL,
    executionPrincipal: serviceAccountPrincipalFromColumns(
      row.execution_principal_type,
      row.execution_principal_id
    ),
    status: row.status,
    modelId: row.model_id ?? undefined,
    finishReason: coerceAgentRunFinishReason(row.finish_reason),
    usage: rowToUsage(row),
    error: row.error ?? undefined,
    diagnostics: normalizeDiagnostics(row.diagnostics),
    attempt: Number(row.attempt),
    lease:
      row.lease_id && row.lease_expires_at
        ? { id: row.lease_id, expiresAt: new Date(row.lease_expires_at) }
        : undefined,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  }
}

export function rowToMessageRecord(row: AgentMessageRow): AgentMessageRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    runId: row.run_id,
    role: row.role,
    authorPrincipal: principalFromColumns(row.author_principal_type, row.author_principal_id),
    seq: Number(row.seq),
    parts:
      typeof row.parts === "string" ? (JSON.parse(row.parts) as AgentMessagePart[]) : row.parts,
    // A null/absent column and an explicit JSON `null` both mean "no metadata" — jsonb cannot tell
    // SQL NULL from a json null on read, so both backends normalise to `undefined` for parity.
    metadata: normalizeMetadata(row.metadata),
    contentVersion: Number(row.content_version),
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  }
}

function principalFromColumns(
  type: Principal["type"] | null | undefined,
  id: string | null | undefined
): Principal | undefined {
  return type && id ? { type, id } : undefined
}

function serviceAccountPrincipalFromColumns(
  type: "serviceAccount" | null | undefined,
  id: string | null | undefined
): Extract<Principal, { readonly type: "serviceAccount" }> | undefined {
  return type === "serviceAccount" && id ? { type, id } : undefined
}

function rowToUsage(row: AgentRunRow): AgentRunUsage | undefined {
  const usage: AgentRunUsage = {
    ...(row.usage_input_tokens === null ? {} : { inputTokens: Number(row.usage_input_tokens) }),
    ...(row.usage_output_tokens === null ? {} : { outputTokens: Number(row.usage_output_tokens) }),
    ...(row.usage_total_tokens === null ? {} : { totalTokens: Number(row.usage_total_tokens) }),
    ...(row.usage_reasoning_tokens === null
      ? {}
      : { reasoningTokens: Number(row.usage_reasoning_tokens) }),
    ...(row.usage_cached_input_tokens === null
      ? {}
      : { cachedInputTokens: Number(row.usage_cached_input_tokens) }),
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

function normalizeMetadata(value: unknown): AgentMessageRecord["metadata"] {
  if (value === null || value === undefined) {
    return undefined
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  return parsed === null ? undefined : (parsed as AgentMessageRecord["metadata"])
}

function normalizeDiagnostics(
  value: AgentRunRow["diagnostics"]
): readonly AgentRunDiagnostic[] | undefined {
  if (value === null) {
    return undefined
  }
  return typeof value === "string" ? (JSON.parse(value) as AgentRunDiagnostic[]) : value
}

// ── offset pagination (threads / messages order by their own column, not started_at) ─────────────

export async function queryAgentList<TRow>(input: {
  readonly sql: SQLClient
  readonly table: "agent_threads" | "agent_messages"
  readonly whereClauses: readonly string[]
  readonly params: readonly SqlParameter[]
  readonly nextIndex: number
  readonly orderBy: string
  readonly limit?: number
  readonly offset?: number
}): Promise<{ readonly rows: readonly TRow[]; readonly total: number; readonly hasMore: boolean }> {
  const where = `WHERE ${input.whereClauses.join(" AND ")}`
  const offset = input.offset ?? 0

  const [totalRow] = await input.sql.unsafe<{ count: string | number }[]>(
    `SELECT COUNT(*)::bigint AS count FROM ${input.table} ${where}`,
    [...input.params] as SqlParameter[]
  )

  const queryParams = [...input.params] as SqlParameter[]
  let query = `SELECT * FROM ${input.table} ${where} ORDER BY ${input.orderBy}`
  let nextIndex = input.nextIndex

  if (input.limit !== undefined) {
    query += ` LIMIT $${nextIndex++} OFFSET $${nextIndex++}`
    queryParams.push(input.limit, offset)
  } else if (offset > 0) {
    query += ` OFFSET $${nextIndex++}`
    queryParams.push(offset)
  }

  const rows = await input.sql.unsafe<TRow[]>(query, queryParams)
  const total = Number(totalRow?.count ?? 0)
  return { rows, total, hasMore: offset + rows.length < total }
}
