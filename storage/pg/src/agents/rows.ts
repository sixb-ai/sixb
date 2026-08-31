import type { AgentMessagePart, JsonValue, Principal } from "@sixb/core"
import { parseSixbFailure } from "@sixb/core/internal/errors"
import {
  AGENT_RUN_FAILURE_CODES,
  type AgentContextCheckpointRecord,
  type AgentMessageRecord,
  type AgentRunDiagnostic,
  type AgentRunRecord,
  type AgentThreadRecord,
  coerceAgentRunFinishReason,
} from "@sixb/core/storage"
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
  execution_id: string
  thread_id: string
  agent_id: string
  trigger_message_id: string
  requester_group_ids: string[] | string
  status: AgentRunRecord["status"]
  model_id: string | null
  finish_reason: string | null
  error: JsonValue | null
  diagnostics: AgentRunDiagnostic[] | string | null
  attempt: number | string
  execution_token: string | null
  execution_queue_lease_expires_at: Date | string | null
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

export interface AgentContextCheckpointRow {
  project_id: string
  id: string
  thread_id: string
  created_by_run_id: string
  previous_checkpoint_id: string | null
  reason: AgentContextCheckpointRecord["reason"]
  summary: string
  summary_format_version: number | string
  summarized_through_seq: number | string
  observed_head_seq: number | string
  estimated_input_tokens_before: number | string
  estimated_input_tokens_after: number | string
  summary_model_id: string
  created_at: Date | string
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
    executionId: row.execution_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    triggerMessageId: row.trigger_message_id,
    requesterGroupIds:
      typeof row.requester_group_ids === "string"
        ? (JSON.parse(row.requester_group_ids) as string[])
        : row.requester_group_ids,
    status: row.status,
    modelId: row.model_id ?? undefined,
    finishReason: coerceAgentRunFinishReason(row.finish_reason),
    error: row.error === null ? undefined : parseSixbFailure(row.error, AGENT_RUN_FAILURE_CODES),
    diagnostics: normalizeDiagnostics(row.diagnostics),
    attempt: Number(row.attempt),
    execution:
      row.execution_token && row.execution_queue_lease_expires_at
        ? {
            token: row.execution_token,
            queueLeaseExpiresAt: new Date(row.execution_queue_lease_expires_at),
          }
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

export function rowToContextCheckpointRecord(
  row: AgentContextCheckpointRow
): AgentContextCheckpointRecord {
  const summaryFormatVersion = Number(row.summary_format_version)
  if (summaryFormatVersion !== 1) {
    throw new Error(
      `[SixbPg] Unsupported agent context checkpoint summary format version '${summaryFormatVersion}'.`
    )
  }
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    createdByRunId: row.created_by_run_id,
    previousCheckpointId: row.previous_checkpoint_id ?? undefined,
    reason: row.reason,
    summary: row.summary,
    summaryFormatVersion: 1,
    summarizedThroughSeq: Number(row.summarized_through_seq),
    observedHeadSeq: Number(row.observed_head_seq),
    estimatedInputTokensBefore: Number(row.estimated_input_tokens_before),
    estimatedInputTokensAfter: Number(row.estimated_input_tokens_after),
    summaryModelId: row.summary_model_id,
    createdAt: new Date(row.created_at),
  }
}

function principalFromColumns(
  type: Principal["type"] | null | undefined,
  id: string | null | undefined
): Principal | undefined {
  return type && id ? { type, id } : undefined
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
