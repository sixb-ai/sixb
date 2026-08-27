import type { Database } from "bun:sqlite"
import type { AgentMessagePart, Principal } from "@sixb/core"
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
import type { SqliteValue } from "../run-list-query"

// ── row shapes (snake_case, as stored) ──────────────────────────────────────────────────────────

export interface AgentThreadRow {
  project_id: string
  id: string
  agent_id: string
  owner_principal_type: Principal["type"]
  owner_principal_id: string
  title: string | null
  status: AgentThreadRecord["status"]
  active_run_id: string | null
  last_message_at: string | null
  message_count: number
  created_at: string
  updated_at: string
}

export interface AgentRunRow {
  project_id: string
  id: string
  execution_id: string
  thread_id: string
  agent_id: string
  trigger_message_id: string
  requester_group_ids: string
  status: AgentRunRecord["status"]
  model_id: string | null
  finish_reason: string | null
  error: string | null
  diagnostics: string | null
  attempt: number
  execution_token: string | null
  execution_queue_lease_expires_at: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface AgentMessageRow {
  project_id: string
  id: string
  thread_id: string
  run_id: string | null
  role: AgentMessageRecord["role"]
  author_principal_type: Principal["type"] | null
  author_principal_id: string | null
  seq: number
  parts: string
  metadata: string | null
  content_version: number
  created_at: string
  completed_at: string | null
}

export interface AgentContextCheckpointRow {
  project_id: string
  id: string
  thread_id: string
  created_by_run_id: string
  previous_checkpoint_id: string | null
  reason: AgentContextCheckpointRecord["reason"]
  summary: string
  summary_format_version: number
  summarized_through_seq: number
  observed_head_seq: number
  estimated_input_tokens_before: number
  estimated_input_tokens_after: number
  summary_model_id: string
  created_at: string
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
    messageCount: row.message_count,
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
    requesterGroupIds: JSON.parse(row.requester_group_ids) as string[],
    status: row.status,
    modelId: row.model_id ?? undefined,
    finishReason: coerceAgentRunFinishReason(row.finish_reason),
    error: row.error === null ? undefined : parseSixbFailure(row.error, AGENT_RUN_FAILURE_CODES),
    diagnostics:
      row.diagnostics === null ? undefined : (JSON.parse(row.diagnostics) as AgentRunDiagnostic[]),
    attempt: row.attempt,
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
    seq: row.seq,
    parts: JSON.parse(row.parts) as AgentMessagePart[],
    // A null/absent column and an explicit JSON `null` both mean "no metadata" (jsonb cannot tell
    // SQL NULL from a json null on read, so both backends normalise to `undefined` for parity).
    metadata: row.metadata === null ? undefined : (JSON.parse(row.metadata) ?? undefined),
    contentVersion: row.content_version,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  }
}

export function rowToContextCheckpointRecord(
  row: AgentContextCheckpointRow
): AgentContextCheckpointRecord {
  if (row.summary_format_version !== 1) {
    throw new Error(
      `[SixbSqlite] Unsupported agent context checkpoint summary format version '${row.summary_format_version}'.`
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
    summarizedThroughSeq: row.summarized_through_seq,
    observedHeadSeq: row.observed_head_seq,
    estimatedInputTokensBefore: row.estimated_input_tokens_before,
    estimatedInputTokensAfter: row.estimated_input_tokens_after,
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

// ── offset pagination (threads / messages order by their own column, not started_at) ─────────────

export function queryAgentList<TRow>(input: {
  readonly db: Database
  readonly table: "agent_threads" | "agent_messages"
  readonly whereClauses: readonly string[]
  readonly args: readonly SqliteValue[]
  readonly orderBy: string
  readonly limit?: number
  readonly offset?: number
}): { readonly rows: readonly TRow[]; readonly total: number; readonly hasMore: boolean } {
  const where = `WHERE ${input.whereClauses.join(" AND ")}`
  const offset = input.offset ?? 0

  const totalRow = input.db
    .query(`SELECT COUNT(*) AS count FROM ${input.table} ${where}`)
    .get(...input.args) as { count: number }

  let query = `SELECT * FROM ${input.table} ${where} ORDER BY ${input.orderBy}`
  const queryArgs = [...input.args]

  if (input.limit !== undefined) {
    query += " LIMIT ? OFFSET ?"
    queryArgs.push(input.limit, offset)
  } else if (offset > 0) {
    query += " LIMIT -1 OFFSET ?"
    queryArgs.push(offset)
  }

  const rows = input.db.query(query).all(...queryArgs) as TRow[]
  const total = totalRow.count
  return { rows, total, hasMore: offset + rows.length < total }
}
