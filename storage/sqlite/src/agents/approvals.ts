import type { Database } from "bun:sqlite"
import type { Principal } from "@sixb/core"
import {
  agentApprovalCallKey,
  assertAgentApprovalCaller,
  assertRequestAgentApprovalInput,
  newAgentApprovalRecord,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AgentApprovalCall,
  type AgentApprovalCursor,
  type AgentApprovalMode,
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
  type StopAgentApprovalsInput,
  type StopAgentApprovalsResult,
} from "@sixb/core/storage"
import { runImmediateTransaction } from "../transactions"
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
  readonly call: string
  readonly status: AgentApprovalRecord["status"]
  readonly created_at: string
  readonly expires_at: string
  readonly decided_at: string | null
  readonly decided_by_type: Principal["type"] | null
  readonly decided_by_id: string | null
  readonly outcome: string | null
  readonly reported_in_message_id: string | null
  readonly raised_mode: AgentApprovalMode | null
  readonly turn_stopped_at: string | null
  readonly execution_claimed_at: string | null
}

const LIVE_CALL = `
  SELECT * FROM agent_approvals
  WHERE project_id = ? AND thread_id = ? AND call_key = ?
    AND status IN ('pending', 'approved', 'denied')
`

export class SqliteAgentApprovalStore implements AgentApprovalStore {
  constructor(private readonly db: Database) {}

  async request(input: RequestAgentApprovalInput): Promise<RequestAgentApprovalResult> {
    assertRequestAgentApprovalInput(input, "SixbSqlite")

    return runImmediateTransaction(this.db, () => {
      const threadId = assertAgentApprovalCaller({
        request: input,
        turn: this.run(input.projectId, input.runId),
        caller: this.run(input.projectId, input.callerRunId),
        prefix: "SixbSqlite",
      })
      const callKey = agentApprovalCallKey(input.call)
      const live = this.db
        .query(LIVE_CALL)
        .get(input.projectId, threadId, callKey) as AgentApprovalRow | null
      if (live) return { approval: rowToApproval(live), created: false }

      if (this.row(input.projectId, input.id)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbSqlite] Agent approval '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
      const approval = newAgentApprovalRecord(input, threadId)
      this.db
        .query(
          `INSERT INTO agent_approvals (
             project_id, id, thread_id, run_id, caller_run_id, requested_by_type, requested_by_id,
             mode, call_key, call, status, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          approval.projectId,
          approval.id,
          approval.threadId,
          approval.runId,
          approval.callerRunId,
          approval.requestedBy.type,
          approval.requestedBy.id,
          approval.mode,
          approval.callKey,
          JSON.stringify(approval.call),
          approval.createdAt.toISOString(),
          approval.expiresAt.toISOString()
        )
      return { approval, created: true }
    })
  }

  async decide(input: DecideAgentApprovalInput): Promise<DecideAgentApprovalResult | null> {
    const decidedAt = (input.decidedAt ?? new Date()).toISOString()

    return runImmediateTransaction(this.db, () => {
      const current = this.row(input.projectId, input.id)
      if (!current) return null
      if (current.status !== "pending") return { approval: rowToApproval(current), decided: false }

      if (current.expires_at <= decidedAt) {
        this.db
          .query("UPDATE agent_approvals SET status = 'expired' WHERE project_id = ? AND id = ?")
          .run(input.projectId, input.id)
      } else {
        this.db
          .query(
            `UPDATE agent_approvals
             SET status = ?, decided_at = ?, decided_by_type = ?, decided_by_id = ?, raised_mode = ?
             WHERE project_id = ? AND id = ?`
          )
          .run(
            input.decision,
            decidedAt,
            input.decidedBy.type,
            input.decidedBy.id,
            input.decision === "approved" ? (input.raisedMode ?? null) : null,
            input.projectId,
            input.id
          )
      }
      const approval = this.require(input.projectId, input.id)
      return { approval, decided: approval.status === input.decision }
    })
  }

  async recordOutcome(input: {
    readonly projectId: string
    readonly id: string
    readonly outcome: AgentApprovalOutcome
  }): Promise<AgentApprovalRecord> {
    return runImmediateTransaction(this.db, () => {
      const current = this.row(input.projectId, input.id)
      if (current?.status !== "approved") {
        throw new AgentStorageError(
          "invalid_state",
          current
            ? `[SixbSqlite] Agent approval '${input.id}' is not approved (status '${current.status}').`
            : `[SixbSqlite] Agent approval '${input.id}' not found for project '${input.projectId}'.`
        )
      }
      if (current.outcome !== null) return rowToApproval(current)

      this.db
        .query("UPDATE agent_approvals SET outcome = ? WHERE project_id = ? AND id = ?")
        .run(JSON.stringify(input.outcome), input.projectId, input.id)
      return this.require(input.projectId, input.id)
    })
  }

  async settle(input: SettleAgentApprovalsInput): Promise<readonly AgentApprovalRecord[]> {
    const rows = this.db
      .query(
        `UPDATE agent_approvals SET status = ?
         WHERE project_id = ? AND thread_id = ? AND status = 'pending'
         RETURNING *`
      )
      .all(input.status, input.projectId, input.threadId) as AgentApprovalRow[]
    return rows.map(rowToApproval).sort(compareApprovals)
  }

  async stop(input: StopAgentApprovalsInput): Promise<StopAgentApprovalsResult> {
    const stoppedAt = (input.stoppedAt ?? new Date()).toISOString()
    const clauses = [
      "project_id = ?",
      "thread_id = ?",
      "reported_in_message_id IS NULL",
      "(status = 'pending' OR turn_stopped_at IS NULL)",
    ]
    const params: string[] = [input.projectId, input.threadId]
    if (input.runId !== undefined) {
      clauses.push("run_id = ?")
      params.push(input.runId)
    }
    if (input.requestedBy !== undefined) {
      clauses.push("requested_by_type = ? AND requested_by_id = ?")
      params.push(input.requestedBy.type, input.requestedBy.id)
    }

    return runImmediateTransaction(this.db, () => {
      const matched = this.db
        .query(`SELECT * FROM agent_approvals WHERE ${clauses.join(" AND ")}`)
        .all(...params) as AgentApprovalRow[]
      const update = this.db.query(
        `UPDATE agent_approvals
         SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
           turn_stopped_at = COALESCE(turn_stopped_at, ?)
         WHERE project_id = ? AND id = ?`
      )
      for (const row of matched) update.run(stoppedAt, input.projectId, row.id)

      const cancelled = matched
        .filter((row) => row.status === "pending")
        .map((row) => this.require(input.projectId, row.id))
      const stopped = matched.filter((row) => row.turn_stopped_at === null).length
      return { cancelled: cancelled.sort(compareApprovals), stopped }
    })
  }

  async holdsRun(input: { readonly projectId: string; readonly runId: string }): Promise<boolean> {
    return sqliteHoldsRun(this.db, input.projectId, input.runId)
  }

  async claimExecution(input: {
    readonly projectId: string
    readonly id: string
    readonly claimedAt: Date
    readonly staleBefore: Date
  }): Promise<AgentApprovalRecord | null> {
    const row = this.db
      .query(
        `UPDATE agent_approvals SET execution_claimed_at = ?
         WHERE project_id = ? AND id = ? AND status = 'approved' AND outcome IS NULL
           AND COALESCE(execution_claimed_at, decided_at) <= ?
         RETURNING *`
      )
      .get(
        input.claimedAt.toISOString(),
        input.projectId,
        input.id,
        input.staleBefore.toISOString()
      ) as AgentApprovalRow | null
    return row ? rowToApproval(row) : null
  }

  async listRepairable(input: {
    readonly projectId: string
    readonly claimableBefore: Date
    readonly after?: AgentApprovalCursor
    readonly limit: number
  }): Promise<readonly AgentApprovalRecord[]> {
    const afterAt = input.after?.createdAt.toISOString() ?? null
    const afterId = input.after?.id ?? ""
    // Each half of the OR matches one partial index.
    const rows = this.db
      .query(
        `SELECT * FROM agent_approvals
         WHERE project_id = ?
           AND (
             (status = 'approved' AND outcome IS NULL
               AND COALESCE(execution_claimed_at, decided_at) <= ?)
             OR (status IN ('approved', 'denied') AND reported_in_message_id IS NULL
               AND turn_stopped_at IS NULL)
           )
           AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at, id
         LIMIT ?`
      )
      .all(
        input.projectId,
        input.claimableBefore.toISOString(),
        afterAt,
        afterAt,
        afterAt,
        afterId,
        input.limit
      ) as AgentApprovalRow[]
    return rows.map(rowToApproval)
  }

  async expireDue(input: {
    readonly projectId: string
    readonly now: Date
    readonly limit?: number
  }): Promise<readonly AgentApprovalRecord[]> {
    const rows = this.db
      .query(
        `UPDATE agent_approvals SET status = 'expired'
         WHERE project_id = ? AND id IN (
           SELECT id FROM agent_approvals
           WHERE project_id = ? AND status = 'pending' AND expires_at <= ?
           ORDER BY created_at, id
           LIMIT ?
         )
         RETURNING *`
      )
      .all(
        input.projectId,
        input.projectId,
        input.now.toISOString(),
        input.limit ?? -1
      ) as AgentApprovalRow[]
    return rows.map(rowToApproval).sort(compareApprovals)
  }

  async markReported(input: MarkAgentApprovalsReportedInput): Promise<readonly string[]> {
    const ids = [...new Set(input.ids)]
    if (ids.length === 0) return []

    const rows = this.db
      .query(
        `UPDATE agent_approvals SET reported_in_message_id = ?
         WHERE project_id = ? AND thread_id = ? AND reported_in_message_id IS NULL
           AND (? = 0 OR turn_stopped_at IS NULL)
           AND id IN (${ids.map(() => "?").join(", ")})
         RETURNING id`
      )
      .all(
        input.messageId,
        input.projectId,
        input.threadId,
        input.resuming === true ? 1 : 0,
        ...ids
      ) as { id: string }[]
    const marked = new Set(rows.map((row) => row.id))
    return ids.filter((id) => marked.has(id))
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<AgentApprovalRecord | null> {
    const row = this.row(params.projectId, params.id)
    return row ? rowToApproval(row) : null
  }

  async list(input: ListAgentApprovalsInput): Promise<ListAgentApprovalsResult> {
    if (input.statuses?.length === 0) return { approvals: [], hasMore: false, total: 0 }

    const { where, params } = listFilter(input)
    const offset = input.offset ?? 0
    return this.db.transaction(() => {
      const counted = this.db
        .query(`SELECT COUNT(*) AS total FROM agent_approvals WHERE ${where}`)
        .get(...params) as { total: number }
      const rows = this.db
        .query(
          `SELECT * FROM agent_approvals WHERE ${where}
           ORDER BY created_at, id LIMIT ? OFFSET ?`
        )
        .all(...params, input.limit ?? -1, offset) as AgentApprovalRow[]
      return {
        approvals: rows.map(rowToApproval),
        hasMore: offset + rows.length < counted.total,
        total: counted.total,
      }
    })()
  }

  private run(projectId: string, id: string) {
    const row = this.db
      .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentRunRow | null
    return row ? rowToRunRecord(row) : null
  }

  private row(projectId: string, id: string): AgentApprovalRow | null {
    return this.db
      .query("SELECT * FROM agent_approvals WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentApprovalRow | null
  }

  private require(projectId: string, id: string): AgentApprovalRecord {
    const row = this.row(projectId, id)
    if (!row) throw new Error(`[SixbSqlite] Agent approval '${id}' disappeared.`)
    return rowToApproval(row)
  }
}

/** The `list` predicate, as the in-memory store's `agentApprovalMatches` reads it. */
function listFilter(input: ListAgentApprovalsInput): {
  readonly where: string
  readonly params: readonly (string | number)[]
} {
  const clauses = ["project_id = ?"]
  const params: (string | number)[] = [input.projectId]
  if (input.threadId !== undefined) {
    clauses.push("thread_id = ?")
    params.push(input.threadId)
  }
  if (input.runId !== undefined) {
    clauses.push("run_id = ?")
    params.push(input.runId)
  }
  if (input.requestedBy !== undefined) {
    clauses.push("requested_by_type = ? AND requested_by_id = ?")
    params.push(input.requestedBy.type, input.requestedBy.id)
  }
  if (input.statuses !== undefined) {
    clauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
    params.push(...input.statuses)
  }
  if (input.reported !== undefined) {
    clauses.push(`reported_in_message_id IS ${input.reported ? "NOT NULL" : "NULL"}`)
  }
  return { where: clauses.join(" AND "), params }
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
    call: JSON.parse(row.call) as AgentApprovalCall,
    status: row.status,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    ...(row.decided_at === null ? {} : { decidedAt: new Date(row.decided_at) }),
    ...(row.decided_by_type === null || row.decided_by_id === null
      ? {}
      : { decidedBy: { type: row.decided_by_type, id: row.decided_by_id } }),
    ...(row.outcome === null ? {} : { outcome: JSON.parse(row.outcome) as AgentApprovalOutcome }),
    ...(row.reported_in_message_id === null
      ? {}
      : { reportedInMessageId: row.reported_in_message_id }),
    ...(row.raised_mode === null ? {} : { raisedMode: row.raised_mode }),
    ...(row.turn_stopped_at === null ? {} : { turnStoppedAt: new Date(row.turn_stopped_at) }),
    ...(row.execution_claimed_at === null
      ? {}
      : { executionClaimedAt: new Date(row.execution_claimed_at) }),
  }
}

/**
 * Whether a run holds a call: an approval of its, or one it made for its turn, pending or decided
 * and not reported yet. `holdsRun` and the paused finish of `runs.finish` both ask this.
 */
export function sqliteHoldsRun(db: Database, projectId: string, runId: string): boolean {
  const held = db
    .query(
      `SELECT id FROM agent_approvals
       WHERE project_id = ? AND (run_id = ? OR caller_run_id = ?)
         AND status IN ('pending', 'approved', 'denied') AND reported_in_message_id IS NULL
       LIMIT 1`
    )
    .get(projectId, runId, runId)
  return held !== null
}

function compareApprovals(left: AgentApprovalRecord, right: AgentApprovalRecord): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
}
