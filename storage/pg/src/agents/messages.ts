import {
  type AgentMessageRecord,
  type AgentMessageStore,
  AgentStorageError,
  type AppendAgentMessageInput,
  type ListAgentMessagesInput,
  type ListAgentMessagesResult,
  SIXB_MESSAGE_CONTENT_VERSION,
} from "@sixb/core"
import type { SqlParameter } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import { type AgentMessageRow, queryAgentList, rowToMessageRecord } from "./rows"

export class PgAgentMessageStore implements AgentMessageStore {
  constructor(private readonly sql: PgStoreClient) {}

  async append(input: AppendAgentMessageInput): Promise<AgentMessageRecord> {
    const createdAt = input.createdAt ?? new Date()

    try {
      return await runPgTransaction(this.sql, async (tx) => {
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

        if (input.runId !== null) {
          const [run] = await tx<{ id: string }[]>`
            SELECT id FROM agent_runs WHERE project_id = ${input.projectId} AND id = ${input.runId}
          `

          if (!run) {
            throw new AgentStorageError(
              "run_not_found",
              `[SixbPg] Agent run '${input.runId}' not found for project '${input.projectId}'.`
            )
          }
        }

        const [seqRow] = await tx<{ next: number | string }[]>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_messages
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        `

        const [row] = await tx<AgentMessageRow[]>`
          INSERT INTO agent_messages (
            project_id,
            id,
            thread_id,
            run_id,
            role,
            seq,
            parts,
            metadata,
            content_version,
            created_at,
            completed_at
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.threadId},
            ${input.runId},
            ${input.role},
            ${Number(seqRow.next)},
            ${JSON.stringify(input.parts)}::text::jsonb,
            ${input.metadata === undefined ? null : JSON.stringify(input.metadata)}::text::jsonb,
            ${SIXB_MESSAGE_CONTENT_VERSION},
            ${createdAt},
            ${input.completedAt ?? null}
          )
          RETURNING *
        `

        await tx`
          UPDATE agent_threads
          SET message_count = message_count + 1, last_message_at = ${createdAt}, updated_at = ${createdAt}
          WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        `

        return rowToMessageRecord(row)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Agent message '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentMessageRecord | null> {
    const [row] = await this.sql<AgentMessageRow[]>`
      SELECT * FROM agent_messages WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToMessageRecord(row) : null
  }

  async list(input: ListAgentMessagesInput): Promise<ListAgentMessagesResult> {
    if (input.roles !== undefined && input.roles.length === 0) {
      return { messages: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1", "thread_id = $2"]
    const params: SqlParameter[] = [input.projectId, input.threadId]
    let index = 3

    if (input.roles) {
      const placeholders = input.roles.map(() => `$${index++}`)
      whereClauses.push(`role IN (${placeholders.join(", ")})`)
      params.push(...input.roles)
    }

    const dir = input.order === "desc" ? "DESC" : "ASC"
    const { rows, total, hasMore } = await queryAgentList<AgentMessageRow>({
      sql: this.sql,
      table: "agent_messages",
      whereClauses,
      params,
      nextIndex: index,
      orderBy: `seq ${dir}`,
      limit: input.limit,
      offset: input.offset,
    })

    return { messages: rows.map(rowToMessageRecord), hasMore, total }
  }
}
