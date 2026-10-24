import type { Principal } from "@sixb/core"
import {
  agentApprovalCallKey,
  assertAgentApprovalCaller,
  assertRequestAgentApprovalInput,
  newAgentApprovalRecord,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AgentApprovalCall,
  type AgentApprovalOutcome,
  type AgentApprovalRecord,
  type AgentApprovalStore,
  AgentStorageError,
  type DecideAgentApprovalInput,
  type DecideAgentApprovalResult,
  type ListAgentApprovalsInput,
  type ListAgentApprovalsResult,
  type MarkAgentApprovalsReportedInput,
  type RequestAgentApprovalInput,
  type RequestAgentApprovalResult,
  type SettleAgentApprovalsInput,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import { type AgentRunRow, rowToRunRecord } from "./rows"

interface AgentApprovalRow {
  readonly project_id: string
  readonly id: string
  readonly thread_id: string
  readonly run_id: string
  readonly caller_run_id: string
  readonly requested_by_type: Principal["type"]
  readonly requested_by_id: string
  readonly mode: AgentApprovalRecord["mode"]
  readonly call_key: string
  readonly call: AgentApprovalCall | string
  readonly status: AgentApprovalRecord["status"]
  readonly created_at: Date | string
  readonly expires_at: Date | string
  readonly decided_at: Date | string | null
  readonly decided_by_type: Principal["type"] | null
  readonly decided_by_id: string | null
  readonly outcome: AgentApprovalOutcome | string | null
  readonly reported_in_message_id: string | null
}

export class PgAgentApprovalStore implements AgentApprovalStore {
  constructor(private readonly sql: PgStoreClient) {}

  async request(input: RequestAgentApprovalInput): Promise<RequestAgentApprovalResult> {
    assertRequestAgentApprovalInput(input, "SixbPg")

    return runPgTransaction(this.sql, async (tx) => {
      // The caller's row lock serializes its requests with its `finish`, which cancels them.
      const turn = await lockRun(tx, input.projectId, input.runId)
      const caller =
        input.callerRunId === input.runId
          ? turn
          : await lockRun(tx, input.projectId, input.callerRunId)
      const threadId = assertAgentApprovalCaller({ request: input, turn, caller, prefix: "SixbPg" })

      const live = await selectLive(tx, input.projectId, threadId, agentApprovalCallKey(input.call))
      if (live) return { approval: rowToApproval(live), created: false }

      const approval = newAgentApprovalRecord(input, threadId)
      const [inserted] = await tx<AgentApprovalRow[]>`
        INSERT INTO agent_approvals (
          project_id, id, thread_id, run_id, caller_run_id, requested_by_type, requested_by_id,
          mode, call_key, call, status, created_at, expires_at
        ) VALUES (
          ${approval.projectId}, ${approval.id}, ${approval.threadId}, ${approval.runId},
          ${approval.callerRunId}, ${approval.requestedBy.type}, ${approval.requestedBy.id},
          ${approval.mode}, ${approval.callKey}, ${JSON.stringify(approval.call)}::text::jsonb,
          'pending', ${approval.createdAt}, ${approval.expiresAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `
      if (inserted) return { approval: rowToApproval(inserted), created: true }

      // Another caller of the same turn held the call first.
      const raced = await selectLive(tx, input.projectId, threadId, approval.callKey)
      if (raced) return { approval: rowToApproval(raced), created: false }
      throw new AgentStorageError(
        "duplicate_id",
        `[SixbPg] Agent approval '${input.id}' already exists for project '${input.projectId}'.`
      )
    })
  }

  async decide(input: DecideAgentApprovalInput): Promise<DecideAgentApprovalResult | null> {
    const decidedAt = input.decidedAt ?? new Date()
    const [row] = await this.sql<AgentApprovalRow[]>`
      UPDATE agent_approvals
      SET
        status = CASE WHEN expires_at <= ${decidedAt} THEN 'expired' ELSE ${input.decision} END,
        decided_at = CASE WHEN expires_at <= ${decidedAt} THEN NULL ELSE ${decidedAt}::timestamptz END,
        decided_by_type = CASE WHEN expires_at <= ${decidedAt} THEN NULL ELSE ${input.decidedBy.type} END,
        decided_by_id = CASE WHEN expires_at <= ${decidedAt} THEN NULL ELSE ${input.decidedBy.id} END
      WHERE project_id = ${input.projectId} AND id = ${input.id} AND status = 'pending'
      RETURNING *
    `
    if (row) {
      const approval = rowToApproval(row)
      return { approval, decided: approval.status === input.decision }
    }

    const current = await this.getById(input)
    return current ? { approval: current, decided: false } : null
  }

  async recordOutcome(input: {
    readonly projectId: string
    readonly id: string
    readonly outcome: AgentApprovalOutcome
  }): Promise<AgentApprovalRecord> {
    const [row] = await this.sql<AgentApprovalRow[]>`
      UPDATE agent_approvals
      SET outcome = ${JSON.stringify(input.outcome)}::text::jsonb
      WHERE project_id = ${input.projectId} AND id = ${input.id}
        AND status = 'approved' AND outcome IS NULL
      RETURNING *
    `
    if (row) return rowToApproval(row)

    const current = await this.getById(input)
    if (current?.status === "approved") return current
    throw new AgentStorageError(
      "invalid_state",
      current
        ? `[SixbPg] Agent approval '${input.id}' is not approved (status '${current.status}').`
        : `[SixbPg] Agent approval '${input.id}' not found for project '${input.projectId}'.`
    )
  }

  async settle(input: SettleAgentApprovalsInput): Promise<readonly AgentApprovalRecord[]> {
    const rows = await this.sql<AgentApprovalRow[]>`
      UPDATE agent_approvals SET status = ${input.status}
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        AND status = 'pending'
      RETURNING *
    `
    return rows.map(rowToApproval).sort(compareApprovals)
  }

  async markReported(input: MarkAgentApprovalsReportedInput): Promise<readonly string[]> {
    const ids = [...new Set(input.ids)]
    if (ids.length === 0) return []

    const rows = await this.sql<{ id: string }[]>`
      UPDATE agent_approvals SET reported_in_message_id = ${input.messageId}
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        AND id = ANY(${this.sql.array(ids)}::text[]) AND reported_in_message_id IS NULL
      RETURNING id
    `
    const marked = new Set(rows.map((row) => row.id))
    return ids.filter((id) => marked.has(id))
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<AgentApprovalRecord | null> {
    const [row] = await this.sql<AgentApprovalRow[]>`
      SELECT * FROM agent_approvals WHERE project_id = ${params.projectId} AND id = ${params.id}
    `
    return row ? rowToApproval(row) : null
  }

  async list(input: ListAgentApprovalsInput): Promise<ListAgentApprovalsResult> {
    if (input.statuses?.length === 0) return { approvals: [], hasMore: false, total: 0 }

    const offset = input.offset ?? 0
    return runPgTransaction(
      this.sql,
      async (tx) => {
        const [counted] = await tx<{ total: number }[]>`
          SELECT COUNT(*)::int AS total FROM agent_approvals WHERE ${listFilter(tx, input)}
        `
        const rows = await tx<AgentApprovalRow[]>`
          SELECT * FROM agent_approvals WHERE ${listFilter(tx, input)}
          ORDER BY created_at, id
          LIMIT ${input.limit ?? null} OFFSET ${offset}
        `
        const total = counted?.total ?? 0
        return { approvals: rows.map(rowToApproval), hasMore: offset + rows.length < total, total }
      },
      { isolation: "repeatableRead" }
    )
  }
}

/** The `list` predicate, as the in-memory store's `agentApprovalMatches` reads it. */
function listFilter(sql: SQLClient, input: ListAgentApprovalsInput) {
  const threadId = input.threadId ?? null
  const runId = input.runId ?? null
  const requesterType = input.requestedBy?.type ?? null
  const requesterId = input.requestedBy?.id ?? null
  const reported = input.reported ?? null
  const statuses = input.statuses ?? null

  return sql`
    project_id = ${input.projectId}
    AND (${threadId}::text IS NULL OR thread_id = ${threadId})
    AND (${runId}::text IS NULL OR run_id = ${runId})
    AND (${requesterType}::text IS NULL
      OR (requested_by_type = ${requesterType} AND requested_by_id = ${requesterId}))
    AND (${statuses === null}::boolean OR status = ANY(${sql.array([...(statuses ?? [])])}::text[]))
    AND (${reported}::boolean IS NULL OR (reported_in_message_id IS NOT NULL) = ${reported})
  `
}

async function lockRun(sql: SQLClient, projectId: string, id: string) {
  const [row] = await sql<AgentRunRow[]>`
    SELECT * FROM agent_runs WHERE project_id = ${projectId} AND id = ${id} FOR UPDATE
  `
  return row ? rowToRunRecord(row) : null
}

function selectLive(
  sql: SQLClient,
  projectId: string,
  threadId: string,
  callKey: string
): Promise<AgentApprovalRow | undefined> {
  return sql<AgentApprovalRow[]>`
    SELECT * FROM agent_approvals
    WHERE project_id = ${projectId} AND thread_id = ${threadId} AND call_key = ${callKey}
      AND status IN ('pending', 'approved', 'denied')
  `.then((rows) => rows[0])
}

function rowToApproval(row: AgentApprovalRow): AgentApprovalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    runId: row.run_id,
    callerRunId: row.caller_run_id,
    requestedBy: { type: row.requested_by_type, id: row.requested_by_id },
    mode: row.mode,
    callKey: row.call_key,
    call: parseJson<AgentApprovalCall>(row.call),
    status: row.status,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    ...(row.decided_at === null ? {} : { decidedAt: new Date(row.decided_at) }),
    ...(row.decided_by_type === null || row.decided_by_id === null
      ? {}
      : { decidedBy: { type: row.decided_by_type, id: row.decided_by_id } }),
    ...(row.outcome === null ? {} : { outcome: parseJson<AgentApprovalOutcome>(row.outcome) }),
    ...(row.reported_in_message_id === null
      ? {}
      : { reportedInMessageId: row.reported_in_message_id }),
  }
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value
}

function compareApprovals(left: AgentApprovalRecord, right: AgentApprovalRecord): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
}
