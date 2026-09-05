import {
  AgentStorageError,
  type AgentThreadRecord,
  type AgentThreadStore,
  type CreateAgentThreadInput,
  type ListAgentThreadsInput,
  type ListAgentThreadsResult,
} from "@sixb/core/storage"
import type { SqlParameter } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import type { PgStoreClient } from "../transactions"
import { type AgentThreadRow, queryAgentList, rowToThreadRecord } from "./rows"

export class PgAgentThreadStore implements AgentThreadStore {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateAgentThreadInput): Promise<AgentThreadRecord> {
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
          status,
          created_at,
          updated_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.ownerPrincipal.type},
          ${input.ownerPrincipal.id},
          ${input.title ?? null},
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
}
