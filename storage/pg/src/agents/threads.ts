import {
  participantsToAdd,
  snapshotAgentThreadSandboxParams,
  transitionAgentThreadSandbox,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AddAgentThreadParticipantsInput,
  AgentStorageError,
  type AgentThreadParticipantRecord,
  type AgentThreadRecord,
  type AgentThreadSandboxState,
  type AgentThreadStore,
  type CreateAgentThreadInput,
  type ListAgentThreadParticipantsInput,
  type ListAgentThreadsInput,
  type ListAgentThreadsResult,
  type RemoveAgentThreadParticipantInput,
  type TransitionAgentThreadSandboxInput,
} from "@sixb/core/storage"
import type { SqlParameter } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import {
  type AgentRunRow,
  type AgentThreadParticipantRow,
  type AgentThreadRow,
  queryAgentList,
  rowToParticipantRecord,
  rowToRunRecord,
  rowToThreadRecord,
} from "./rows"

export class PgAgentThreadStore implements AgentThreadStore {
  constructor(private readonly sql: PgStoreClient) {}

  async transitionSandbox(
    input: TransitionAgentThreadSandboxInput
  ): Promise<AgentThreadSandboxState> {
    return runPgTransaction(this.sql, async (tx) => {
      // Same lock order as run finalization: run, then thread.
      const runs =
        input.action === "recreate"
          ? []
          : await tx<AgentRunRow[]>`
        SELECT * FROM agent_runs WHERE project_id = ${input.projectId} AND id = ${input.runId}
        FOR UPDATE
      `
      const [thread] = await tx<AgentThreadRow[]>`
        SELECT * FROM agent_threads WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      const state = transitionAgentThreadSandbox(
        thread ? rowToThreadRecord(thread) : null,
        runs[0] ? rowToRunRecord(runs[0]) : null,
        input
      )
      await tx`UPDATE agent_threads SET sandbox_state = ${JSON.stringify(state)}::text::jsonb
        WHERE project_id = ${input.projectId} AND id = ${input.id}`
      return state
    })
  }

  async create(input: CreateAgentThreadInput): Promise<AgentThreadRecord> {
    const sandboxParams =
      input.sandboxParams === undefined
        ? null
        : JSON.stringify(snapshotAgentThreadSandboxParams(input.sandboxParams))
    const createdAt = input.createdAt ?? new Date()
    const updatedAt = input.updatedAt ?? createdAt

    try {
      const [row] = await this.sql<AgentThreadRow[]>`
        INSERT INTO agent_threads (
          project_id,
          id,
          owner_principal_type,
          owner_principal_id,
          title,
          sandbox_params,
          status,
          created_at,
          updated_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.ownerPrincipal.type},
          ${input.ownerPrincipal.id},
          ${input.title ?? null},
          ${sandboxParams}::text::jsonb,
          ${input.status ?? "active"},
          ${createdAt},
          ${updatedAt}
        )
        RETURNING *
      `

      return rowToThreadRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Agent thread '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentThreadRecord | null> {
    const [row] = await this.sql<AgentThreadRow[]>`
      SELECT * FROM agent_threads WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToThreadRecord(row) : null
  }

  async getByIds(params: {
    readonly projectId: string
    readonly ids: readonly string[]
  }): Promise<readonly AgentThreadRecord[]> {
    const ids = [...new Set(params.ids)]
    if (ids.length === 0) {
      return []
    }

    const rows = await this.sql<AgentThreadRow[]>`
      SELECT *
      FROM agent_threads
      WHERE project_id = ${params.projectId}
        AND id = ANY(${this.sql.array(ids)}::text[])
    `

    const byId = new Map(rows.map((row) => [row.id, row]))
    return ids.flatMap((id) => {
      const row = byId.get(id)
      return row ? [rowToThreadRecord(row)] : []
    })
  }

  async list(input: ListAgentThreadsInput): Promise<ListAgentThreadsResult> {
    if (input.statuses !== undefined && input.statuses.length === 0) {
      return { threads: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.statuses) {
      const placeholders = input.statuses.map(() => `$${index++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }

    if (input.ownerPrincipal) {
      whereClauses.push(`owner_principal_type = $${index++} AND owner_principal_id = $${index++}`)
      params.push(input.ownerPrincipal.type, input.ownerPrincipal.id)
    }

    if (input.participantPrincipal) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM agent_thread_participants participant
        WHERE participant.project_id = agent_threads.project_id
          AND participant.thread_id = agent_threads.id
          AND participant.principal_type = $${index++}
          AND participant.principal_id = $${index++}
      )`)
      params.push(input.participantPrincipal.type, input.participantPrincipal.id)
    }

    const dir = input.order === "asc" ? "ASC" : "DESC"
    const { rows, total, hasMore } = await queryAgentList<AgentThreadRow>({
      sql: this.sql,
      table: "agent_threads",
      whereClauses,
      params,
      nextIndex: index,
      orderBy: `COALESCE(last_message_at, created_at) ${dir}, id ${dir}`,
      limit: input.limit,
      offset: input.offset,
    })

    return { threads: rows.map(rowToThreadRecord), hasMore, total }
  }

  async addParticipants(
    input: AddAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    return runPgTransaction(this.sql, async (tx) => {
      // Concurrent adds to one thread queue on its row, so the limit counts every participant.
      const [thread] = await tx<{ id: string }[]>`
        SELECT id FROM agent_threads
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        FOR UPDATE
      `
      if (!thread) {
        throw new AgentStorageError(
          "thread_not_found",
          `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
        )
      }

      const existing = await selectParticipants(tx, input.projectId, [input.threadId])
      const added = participantsToAdd(input, existing, "SixbPg")
      const addedAt = input.addedAt ?? new Date()

      for (const principal of added) {
        await tx`
          INSERT INTO agent_thread_participants (
            project_id,
            thread_id,
            principal_type,
            principal_id,
            added_at,
            added_by_type,
            added_by_id
          ) VALUES (
            ${input.projectId},
            ${input.threadId},
            ${principal.type},
            ${principal.id},
            ${addedAt},
            ${input.addedBy.type},
            ${input.addedBy.id}
          )
        `
      }

      return added.length === 0
        ? existing
        : selectParticipants(tx, input.projectId, [input.threadId])
    })
  }

  async removeParticipant(input: RemoveAgentThreadParticipantInput): Promise<boolean> {
    const rows = await this.sql<{ principal_id: string }[]>`
      DELETE FROM agent_thread_participants
      WHERE project_id = ${input.projectId}
        AND thread_id = ${input.threadId}
        AND principal_type = ${input.principal.type}
        AND principal_id = ${input.principal.id}
      RETURNING principal_id
    `

    return rows.length > 0
  }

  async listParticipants(
    input: ListAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    return selectParticipants(this.sql, input.projectId, [...new Set(input.threadIds)])
  }
}

async function selectParticipants(
  sql: PgStoreClient,
  projectId: string,
  threadIds: readonly string[]
): Promise<AgentThreadParticipantRecord[]> {
  if (threadIds.length === 0) {
    return []
  }

  const rows = await sql<AgentThreadParticipantRow[]>`
    SELECT *
    FROM agent_thread_participants
    WHERE project_id = ${projectId}
      AND thread_id = ANY(${sql.array([...threadIds])}::text[])
    ORDER BY added_at, principal_id COLLATE "C", thread_id COLLATE "C"
  `

  return rows.map(rowToParticipantRecord)
}
