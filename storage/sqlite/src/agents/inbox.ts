import type { Database } from "bun:sqlite"
import type { AgentMessagePart, Principal } from "@sixb/core"
import {
  assertEnqueueAgentInboxItemInput,
  assertInboxRunOwnership,
  assertInboxThreadAcceptsItem,
  assertTakeAgentInboxSteersInput,
  assertUpdateAgentInboxItemInput,
  newAgentInboxItemRecord,
  updatedAgentInboxItemRecord,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AgentInboxItemRecord,
  type AgentInboxMode,
  type AgentInboxSpec,
  type AgentInboxStore,
  AgentStorageError,
  type AgentThreadRecord,
  type ConsumeClaimedAgentInboxInput,
  type EnqueueAgentInboxItemInput,
  type EnqueueAgentInboxItemResult,
  type ListAgentInboxItemsInput,
  type RemoveAgentInboxItemInput,
  type TakeAgentInboxSteersInput,
  type TakeNextQueuedAgentInboxInput,
  type UpdateAgentInboxItemInput,
} from "@sixb/core/storage"
import { isUniqueConstraintError } from "../storage-errors"
import { runImmediateTransaction } from "../transactions"
import { type AgentRunRow, rowToRunRecord } from "./rows"

interface AgentInboxRow {
  readonly project_id: string
  readonly id: string
  readonly thread_id: string
  readonly message_id: string
  readonly seq: number
  readonly author_principal_type: Principal["type"]
  readonly author_principal_id: string
  readonly mode: AgentInboxMode
  readonly parts: string
  readonly spec: string | null
  readonly time_zone: string | null
  readonly locale: string | null
  readonly immediate: number
  readonly claimed_by_run_id: string | null
  readonly claimed_by_token: string | null
  readonly claimed_by_step: number | null
  readonly claimed_after_answer: number | null
  readonly created_at: string
  readonly updated_at: string
}

interface ThreadSummaryRow {
  readonly id: string
  readonly kind: AgentThreadRecord["kind"]
  readonly status: AgentThreadRecord["status"]
  readonly active_run_id: string | null
}

export class SqliteAgentInboxStore implements AgentInboxStore {
  constructor(private readonly db: Database) {}

  async enqueue(input: EnqueueAgentInboxItemInput): Promise<EnqueueAgentInboxItemResult> {
    assertEnqueueAgentInboxItemInput(input, "SixbSqlite")

    return runImmediateTransaction(this.db, () => {
      const existing = this.row(input.projectId, input.id)
      if (existing) {
        if (existing.thread_id === input.threadId) {
          return { item: rowToInboxItem(existing), created: false }
        }
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbSqlite] Agent inbox item '${input.id}' already exists on another thread in project '${input.projectId}'.`
        )
      }

      const thread = this.threadSummary(input.projectId, input.threadId)
      const countRow = this.db
        .query(
          "SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS max_seq FROM agent_thread_inbox WHERE project_id = ? AND thread_id = ?"
        )
        .get(input.projectId, input.threadId) as { count: number; max_seq: number }

      assertInboxThreadAcceptsItem(
        thread,
        input.threadId,
        input.projectId,
        countRow.count,
        "SixbSqlite"
      )

      const existingMessage = this.db
        .query("SELECT 1 AS present FROM agent_messages WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.messageId)
      if (existingMessage) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbSqlite] Agent message '${input.messageId}' already exists for project '${input.projectId}'.`
        )
      }

      const record = newAgentInboxItemRecord(input, countRow.max_seq + 1)
      try {
        this.db
          .query(
            `INSERT INTO agent_thread_inbox (
               project_id, id, thread_id, message_id, seq,
               author_principal_type, author_principal_id, mode, parts, spec,
               time_zone, locale, immediate, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            record.projectId,
            record.id,
            record.threadId,
            record.messageId,
            record.seq,
            record.authorPrincipal.type,
            record.authorPrincipal.id,
            record.mode,
            JSON.stringify(record.parts),
            record.spec === undefined ? null : JSON.stringify(record.spec),
            record.timeZone ?? null,
            record.locale ?? null,
            record.immediate ? 1 : 0,
            record.createdAt.toISOString(),
            record.updatedAt.toISOString()
          )
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbSqlite] Agent message '${input.messageId}' already exists for project '${input.projectId}'.`
          )
        }
        throw error
      }

      return { item: record, created: true }
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentInboxItemRecord | null> {
    const row = this.row(params.projectId, params.id)
    return row ? rowToInboxItem(row) : null
  }

  async list(input: ListAgentInboxItemsInput): Promise<readonly AgentInboxItemRecord[]> {
    const includeClaimed = input.includeClaimed ?? true
    const rows = this.db
      .query(
        includeClaimed
          ? "SELECT * FROM agent_thread_inbox WHERE project_id = ? AND thread_id = ? ORDER BY seq ASC"
          : "SELECT * FROM agent_thread_inbox WHERE project_id = ? AND thread_id = ? AND claimed_by_run_id IS NULL ORDER BY seq ASC"
      )
      .all(input.projectId, input.threadId) as AgentInboxRow[]
    return rows.map(rowToInboxItem)
  }

  async update(input: UpdateAgentInboxItemInput): Promise<AgentInboxItemRecord | null> {
    assertUpdateAgentInboxItemInput(input, "SixbSqlite")

    return runImmediateTransaction(this.db, () => {
      const current = this.row(input.projectId, input.id)
      if (!current || current.thread_id !== input.threadId) return null

      const next = updatedAgentInboxItemRecord(rowToInboxItem(current), input)
      this.db
        .query(
          `UPDATE agent_thread_inbox
           SET mode = ?, parts = ?, spec = ?, immediate = ?, updated_at = ?
           WHERE project_id = ? AND id = ?`
        )
        .run(
          next.mode,
          JSON.stringify(next.parts),
          next.spec === undefined ? null : JSON.stringify(next.spec),
          next.immediate ? 1 : 0,
          next.updatedAt.toISOString(),
          next.projectId,
          next.id
        )
      return next
    })
  }

  async remove(input: RemoveAgentInboxItemInput): Promise<AgentInboxItemRecord | null> {
    return runImmediateTransaction(this.db, () => {
      const current = this.row(input.projectId, input.id)
      if (!current || current.thread_id !== input.threadId) return null
      if (current.claimed_by_run_id !== null) {
        throw new AgentStorageError(
          "invalid_state",
          `[SixbSqlite] Agent inbox item '${current.id}' was already claimed by run '${current.claimed_by_run_id}'.`
        )
      }
      this.db
        .query("DELETE FROM agent_thread_inbox WHERE project_id = ? AND id = ?")
        .run(input.projectId, input.id)
      return rowToInboxItem(current)
    })
  }

  async takeSteers(input: TakeAgentInboxSteersInput): Promise<readonly AgentInboxItemRecord[]> {
    assertTakeAgentInboxSteersInput(input, "SixbSqlite")

    return runImmediateTransaction(this.db, () => {
      assertInboxRunOwnership(this.run(input.projectId, input.runId), input, "SixbSqlite")

      const unclaimed = this.db
        .query(
          `SELECT * FROM agent_thread_inbox
           WHERE project_id = ? AND thread_id = ?
             AND mode = 'steer' AND immediate = 0
             AND author_principal_type = ? AND author_principal_id = ?
             AND (claimed_by_run_id IS NULL OR claimed_by_run_id <> ? OR claimed_by_token <> ?)
           ORDER BY seq ASC`
        )
        .all(
          input.projectId,
          input.threadId,
          input.authorPrincipal.type,
          input.authorPrincipal.id,
          input.runId,
          input.executionToken
        ) as AgentInboxRow[]
      if (unclaimed.length === 0) return []

      const updatedAt = new Date().toISOString()
      const updateStmt = this.db.query(
        `UPDATE agent_thread_inbox
         SET claimed_by_run_id = ?, claimed_by_token = ?, claimed_by_step = ?,
             claimed_after_answer = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`
      )
      for (const row of unclaimed) {
        updateStmt.run(
          input.runId,
          input.executionToken,
          input.stepIndex,
          input.afterAnswer ? 1 : null,
          updatedAt,
          row.project_id,
          row.id
        )
      }

      const claimed = this.db
        .query(
          `SELECT * FROM agent_thread_inbox
           WHERE project_id = ? AND thread_id = ?
             AND claimed_by_run_id = ? AND claimed_by_token = ? AND claimed_by_step = ?
           ORDER BY seq ASC`
        )
        .all(
          input.projectId,
          input.threadId,
          input.runId,
          input.executionToken,
          input.stepIndex
        ) as AgentInboxRow[]
      const claimedIds = new Set(unclaimed.map((row) => row.id))
      return claimed.filter((row) => claimedIds.has(row.id)).map(rowToInboxItem)
    })
  }

  async consumeClaimed(
    input: ConsumeClaimedAgentInboxInput
  ): Promise<readonly AgentInboxItemRecord[]> {
    return runImmediateTransaction(this.db, () => {
      assertInboxRunOwnership(this.run(input.projectId, input.runId), input, "SixbSqlite")

      const claimed = this.db
        .query(
          `SELECT * FROM agent_thread_inbox
           WHERE project_id = ? AND thread_id = ?
             AND claimed_by_run_id = ? AND claimed_by_token = ?
           ORDER BY seq ASC`
        )
        .all(input.projectId, input.threadId, input.runId, input.executionToken) as AgentInboxRow[]
      if (claimed.length === 0) return []

      const persisted = new Set(input.messageIds)
      const updatedAt = new Date().toISOString()
      const consumed: AgentInboxItemRecord[] = []
      const deleteStmt = this.db.query(
        "DELETE FROM agent_thread_inbox WHERE project_id = ? AND id = ?"
      )
      const releaseStmt = this.db.query(
        `UPDATE agent_thread_inbox
         SET claimed_by_run_id = NULL, claimed_by_token = NULL,
             claimed_by_step = NULL, claimed_after_answer = NULL, updated_at = ?
         WHERE project_id = ? AND id = ?`
      )
      for (const row of claimed) {
        if (persisted.has(row.message_id)) {
          deleteStmt.run(row.project_id, row.id)
          consumed.push(rowToInboxItem(row))
        } else {
          releaseStmt.run(updatedAt, row.project_id, row.id)
        }
      }
      return consumed
    })
  }

  async releaseClaimed(input: { projectId: string; runId: string }): Promise<number> {
    return runImmediateTransaction(this.db, () => {
      const updatedAt = new Date().toISOString()
      const result = this.db
        .query(
          `UPDATE agent_thread_inbox
           SET claimed_by_run_id = NULL, claimed_by_token = NULL,
               claimed_by_step = NULL, claimed_after_answer = NULL, updated_at = ?
           WHERE project_id = ? AND claimed_by_run_id = ?`
        )
        .run(updatedAt, input.projectId, input.runId)
      return result.changes
    })
  }

  async takeNextQueued(input: TakeNextQueuedAgentInboxInput): Promise<AgentInboxItemRecord | null> {
    return runImmediateTransaction(this.db, () => {
      const thread = this.threadSummary(input.projectId, input.threadId)
      if (!thread || thread.status !== "active" || thread.active_run_id !== null) return null

      const winner = this.db
        .query(
          `SELECT * FROM agent_thread_inbox
           WHERE project_id = ? AND thread_id = ?
             AND claimed_by_run_id IS NULL
             AND (? = 0 OR immediate = 1)
             AND (? IS NULL OR (author_principal_type = ? AND author_principal_id = ?))
           ORDER BY
             CASE WHEN immediate = 1 THEN 0 WHEN mode = 'steer' THEN 1 ELSE 2 END ASC,
             seq ASC
           LIMIT 1`
        )
        .get(
          input.projectId,
          input.threadId,
          input.onlyImmediate ? 1 : 0,
          input.authorPrincipal?.type ?? null,
          input.authorPrincipal?.type ?? null,
          input.authorPrincipal?.id ?? null
        ) as AgentInboxRow | null
      if (!winner) return null

      this.db
        .query("DELETE FROM agent_thread_inbox WHERE project_id = ? AND id = ?")
        .run(winner.project_id, winner.id)
      return rowToInboxItem(winner)
    })
  }

  private row(projectId: string, id: string): AgentInboxRow | null {
    return this.db
      .query("SELECT * FROM agent_thread_inbox WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentInboxRow | null
  }

  private threadSummary(projectId: string, threadId: string): ThreadSummaryRow | null {
    return this.db
      .query(
        "SELECT id, kind, status, active_run_id FROM agent_threads WHERE project_id = ? AND id = ?"
      )
      .get(projectId, threadId) as ThreadSummaryRow | null
  }

  private run(projectId: string, id: string) {
    const row = this.db
      .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentRunRow | null
    return row ? rowToRunRecord(row) : null
  }
}

function rowToInboxItem(row: AgentInboxRow): AgentInboxItemRecord {
  const spec = row.spec === null ? undefined : (JSON.parse(row.spec) as AgentInboxSpec)
  const claimedBy =
    row.claimed_by_run_id !== null && row.claimed_by_token !== null && row.claimed_by_step !== null
      ? {
          runId: row.claimed_by_run_id,
          executionToken: row.claimed_by_token,
          stepIndex: row.claimed_by_step,
          ...(row.claimed_after_answer === 1 ? { afterAnswer: true } : {}),
        }
      : undefined
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    seq: row.seq,
    authorPrincipal: {
      type: row.author_principal_type,
      id: row.author_principal_id,
    },
    mode: row.mode,
    parts: JSON.parse(row.parts) as readonly AgentMessagePart[],
    ...(spec ? { spec } : {}),
    ...(row.time_zone ? { timeZone: row.time_zone } : {}),
    ...(row.locale ? { locale: row.locale } : {}),
    ...(row.immediate === 1 ? { immediate: true } : {}),
    ...(claimedBy ? { claimedBy } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}
