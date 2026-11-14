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
import type { SQLClient } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import { type AgentRunRow, rowToRunRecord } from "./rows"

interface AgentInboxRow {
  readonly project_id: string
  readonly id: string
  readonly thread_id: string
  readonly message_id: string
  readonly seq: number | string
  readonly author_principal_type: Principal["type"]
  readonly author_principal_id: string
  readonly mode: AgentInboxMode
  readonly parts: readonly AgentMessagePart[] | string
  readonly spec: AgentInboxSpec | string | null
  readonly time_zone: string | null
  readonly locale: string | null
  readonly immediate: boolean
  readonly claimed_by_run_id: string | null
  readonly claimed_by_token: string | null
  readonly claimed_by_step: number | string | null
  readonly claimed_after_answer: boolean | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
}

interface ThreadSummaryRow {
  readonly id: string
  readonly kind: AgentThreadRecord["kind"]
  readonly status: AgentThreadRecord["status"]
  readonly active_run_id: string | null
}

export class PgAgentInboxStore implements AgentInboxStore {
  constructor(private readonly sql: PgStoreClient) {}

  async enqueue(input: EnqueueAgentInboxItemInput): Promise<EnqueueAgentInboxItemResult> {
    assertEnqueueAgentInboxItemInput(input, "SixbPg")

    try {
      return await runPgTransaction(this.sql, async (tx) => {
        const [existing] = await tx<AgentInboxRow[]>`
          SELECT * FROM agent_thread_inbox
          WHERE project_id = ${input.projectId} AND id = ${input.id}
          FOR UPDATE
        `
        if (existing) {
          if (existing.thread_id === input.threadId) {
            return { item: rowToInboxItem(existing), created: false }
          }
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbPg] Agent inbox item '${input.id}' already exists on another thread in project '${input.projectId}'.`
          )
        }

        const [thread] = await tx<ThreadSummaryRow[]>`
          SELECT id, kind, status, active_run_id FROM agent_threads
          WHERE project_id = ${input.projectId} AND id = ${input.threadId}
          FOR UPDATE
        `
        const [counts] = await tx<{ count: number | string; max_seq: number | string }[]>`
          SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS max_seq
          FROM agent_thread_inbox
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        `
        assertInboxThreadAcceptsItem(
          thread ?? null,
          input.threadId,
          input.projectId,
          Number(counts?.count ?? 0),
          "SixbPg"
        )

        const [existingMessage] = await tx<{ id: string }[]>`
          SELECT id FROM agent_messages
          WHERE project_id = ${input.projectId} AND id = ${input.messageId}
        `
        if (existingMessage) {
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbPg] Agent message '${input.messageId}' already exists for project '${input.projectId}'.`
          )
        }

        const record = newAgentInboxItemRecord(input, Number(counts?.max_seq ?? 0) + 1)
        const [inserted] = await tx<AgentInboxRow[]>`
          INSERT INTO agent_thread_inbox (
            project_id, id, thread_id, message_id, seq,
            author_principal_type, author_principal_id, mode, parts, spec,
            time_zone, locale, immediate, created_at, updated_at
          ) VALUES (
            ${record.projectId},
            ${record.id},
            ${record.threadId},
            ${record.messageId},
            ${record.seq},
            ${record.authorPrincipal.type},
            ${record.authorPrincipal.id},
            ${record.mode},
            ${JSON.stringify(record.parts)}::text::jsonb,
            ${record.spec === undefined ? null : JSON.stringify(record.spec)}::text::jsonb,
            ${record.timeZone ?? null},
            ${record.locale ?? null},
            ${Boolean(record.immediate)},
            ${record.createdAt},
            ${record.updatedAt}
          )
          RETURNING *
        `
        return { item: rowToInboxItem(inserted!), created: true }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Agent inbox item or message id already exists for project '${input.projectId}'.`
        )
      }
      throw error
    }
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentInboxItemRecord | null> {
    const [row] = await this.sql<AgentInboxRow[]>`
      SELECT * FROM agent_thread_inbox
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `
    return row ? rowToInboxItem(row) : null
  }

  async list(input: ListAgentInboxItemsInput): Promise<readonly AgentInboxItemRecord[]> {
    const includeClaimed = input.includeClaimed ?? true
    const rows = includeClaimed
      ? await this.sql<AgentInboxRow[]>`
          SELECT * FROM agent_thread_inbox
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
          ORDER BY seq ASC
        `
      : await this.sql<AgentInboxRow[]>`
          SELECT * FROM agent_thread_inbox
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
            AND claimed_by_run_id IS NULL
          ORDER BY seq ASC
        `
    return rows.map(rowToInboxItem)
  }

  async update(input: UpdateAgentInboxItemInput): Promise<AgentInboxItemRecord | null> {
    assertUpdateAgentInboxItemInput(input, "SixbPg")

    return runPgTransaction(this.sql, async (tx) => {
      const [current] = await tx<AgentInboxRow[]>`
        SELECT * FROM agent_thread_inbox
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (!current || current.thread_id !== input.threadId) return null

      const next = updatedAgentInboxItemRecord(rowToInboxItem(current), input)
      const [updated] = await tx<AgentInboxRow[]>`
        UPDATE agent_thread_inbox
        SET
          mode = ${next.mode},
          parts = ${JSON.stringify(next.parts)}::text::jsonb,
          spec = ${next.spec === undefined ? null : JSON.stringify(next.spec)}::text::jsonb,
          immediate = ${Boolean(next.immediate)},
          updated_at = ${next.updatedAt}
        WHERE project_id = ${next.projectId} AND id = ${next.id}
        RETURNING *
      `
      return updated ? rowToInboxItem(updated) : null
    })
  }

  async remove(input: RemoveAgentInboxItemInput): Promise<AgentInboxItemRecord | null> {
    return runPgTransaction(this.sql, async (tx) => {
      const [current] = await tx<AgentInboxRow[]>`
        SELECT * FROM agent_thread_inbox
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (!current || current.thread_id !== input.threadId) return null
      if (current.claimed_by_run_id !== null) {
        throw new AgentStorageError(
          "invalid_state",
          `[SixbPg] Agent inbox item '${current.id}' was already claimed by run '${current.claimed_by_run_id}'.`
        )
      }
      await tx`
        DELETE FROM agent_thread_inbox
        WHERE project_id = ${input.projectId} AND id = ${input.id}
      `
      return rowToInboxItem(current)
    })
  }

  async takeSteers(input: TakeAgentInboxSteersInput): Promise<readonly AgentInboxItemRecord[]> {
    assertTakeAgentInboxSteersInput(input, "SixbPg")

    return runPgTransaction(this.sql, async (tx) => {
      const run = await lockRun(tx, input.projectId, input.runId)
      assertInboxRunOwnership(run, input, "SixbPg")

      const updatedAt = new Date()
      const rows = await tx<AgentInboxRow[]>`
        UPDATE agent_thread_inbox
        SET
          claimed_by_run_id = ${input.runId},
          claimed_by_token = ${input.executionToken},
          claimed_by_step = ${input.stepIndex},
          claimed_after_answer = ${input.afterAnswer ? true : null}::boolean,
          updated_at = ${updatedAt}
        WHERE project_id = ${input.projectId}
          AND thread_id = ${input.threadId}
          AND claimed_by_run_id IS NULL
          AND mode = 'steer'
          AND immediate = FALSE
        RETURNING *
      `
      return rows.map(rowToInboxItem).sort((left, right) => left.seq - right.seq)
    })
  }

  async consumeClaimed(
    input: ConsumeClaimedAgentInboxInput
  ): Promise<readonly AgentInboxItemRecord[]> {
    return runPgTransaction(this.sql, async (tx) => {
      const run = await lockRun(tx, input.projectId, input.runId)
      assertInboxRunOwnership(run, input, "SixbPg")

      const claimed = await tx<AgentInboxRow[]>`
        SELECT * FROM agent_thread_inbox
        WHERE project_id = ${input.projectId}
          AND thread_id = ${input.threadId}
          AND claimed_by_run_id = ${input.runId}
          AND claimed_by_token = ${input.executionToken}
        ORDER BY seq ASC
        FOR UPDATE
      `
      if (claimed.length === 0) return []

      const persisted = new Set(input.messageIds)
      const updatedAt = new Date()
      const consumed: AgentInboxItemRecord[] = []
      for (const row of claimed) {
        if (persisted.has(row.message_id)) {
          await tx`
            DELETE FROM agent_thread_inbox
            WHERE project_id = ${row.project_id} AND id = ${row.id}
          `
          consumed.push(rowToInboxItem(row))
        } else {
          await tx`
            UPDATE agent_thread_inbox
            SET
              claimed_by_run_id = NULL,
              claimed_by_token = NULL,
              claimed_by_step = NULL,
              claimed_after_answer = NULL,
              updated_at = ${updatedAt}
            WHERE project_id = ${row.project_id} AND id = ${row.id}
          `
        }
      }
      return consumed
    })
  }

  async releaseClaimed(input: { projectId: string; runId: string }): Promise<number> {
    const updatedAt = new Date()
    const rows = await this.sql<{ id: string }[]>`
      UPDATE agent_thread_inbox
      SET
        claimed_by_run_id = NULL,
        claimed_by_token = NULL,
        claimed_by_step = NULL,
        claimed_after_answer = NULL,
        updated_at = ${updatedAt}
      WHERE project_id = ${input.projectId} AND claimed_by_run_id = ${input.runId}
      RETURNING id
    `
    return rows.length
  }

  async takeNextQueued(input: TakeNextQueuedAgentInboxInput): Promise<AgentInboxItemRecord | null> {
    return runPgTransaction(this.sql, async (tx) => {
      const [thread] = await tx<ThreadSummaryRow[]>`
        SELECT id, kind, status, active_run_id FROM agent_threads
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        FOR UPDATE
      `
      if (!thread || thread.status !== "active" || thread.active_run_id !== null) return null

      const [winner] = await tx<AgentInboxRow[]>`
        SELECT * FROM agent_thread_inbox
        WHERE project_id = ${input.projectId}
          AND thread_id = ${input.threadId}
          AND claimed_by_run_id IS NULL
          AND (${!input.onlyImmediate}::boolean OR immediate = TRUE)
        ORDER BY
          CASE WHEN immediate = TRUE THEN 0 WHEN mode = 'steer' THEN 1 ELSE 2 END ASC,
          seq ASC
        LIMIT 1
        FOR UPDATE
      `
      if (!winner) return null

      await tx`
        DELETE FROM agent_thread_inbox
        WHERE project_id = ${winner.project_id} AND id = ${winner.id}
      `
      return rowToInboxItem(winner)
    })
  }
}

async function lockRun(tx: SQLClient, projectId: string, id: string) {
  const [row] = await tx<AgentRunRow[]>`
    SELECT * FROM agent_runs WHERE project_id = ${projectId} AND id = ${id} FOR UPDATE
  `
  return row ? rowToRunRecord(row) : null
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value
}

function rowToInboxItem(row: AgentInboxRow): AgentInboxItemRecord {
  const spec = row.spec === null ? undefined : parseJson<AgentInboxSpec>(row.spec)
  const claimedBy =
    row.claimed_by_run_id !== null && row.claimed_by_token !== null && row.claimed_by_step !== null
      ? {
          runId: row.claimed_by_run_id,
          executionToken: row.claimed_by_token,
          stepIndex: Number(row.claimed_by_step),
          ...(row.claimed_after_answer === true ? { afterAnswer: true } : {}),
        }
      : undefined
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    seq: Number(row.seq),
    authorPrincipal: {
      type: row.author_principal_type,
      id: row.author_principal_id,
    },
    mode: row.mode,
    parts: parseJson<readonly AgentMessagePart[]>(row.parts),
    ...(spec ? { spec } : {}),
    ...(row.time_zone ? { timeZone: row.time_zone } : {}),
    ...(row.locale ? { locale: row.locale } : {}),
    ...(row.immediate ? { immediate: true } : {}),
    ...(claimedBy ? { claimedBy } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}
