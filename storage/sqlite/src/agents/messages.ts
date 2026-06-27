import type { Database } from "bun:sqlite"
import {
  AGENT_MESSAGE_CONTENT_VERSION,
  type AgentMessageRecord,
  type AgentMessageStore,
  AgentStorageError,
  type AppendAgentMessageInput,
  type ListAgentMessagesInput,
  type ListAgentMessagesResult,
} from "@sixb/core"
import type { SqliteValue } from "../run-list-query"
import { isUniqueConstraintError } from "../storage-errors"
import { type AgentMessageRow, queryAgentList, rowToMessageRecord } from "./rows"

export class SqliteAgentMessageStore implements AgentMessageStore {
  constructor(private readonly db: Database) {}

  async append(input: AppendAgentMessageInput): Promise<AgentMessageRecord> {
    const createdAt = input.createdAt ?? new Date()

    return this.db.transaction(() => {
      const thread = this.db
        .query("SELECT 1 AS present FROM agent_threads WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.threadId) as { present: number } | null

      if (!thread) {
        throw new AgentStorageError(
          "thread_not_found",
          `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
        )
      }

      if (input.runId !== null) {
        const run = this.db
          .query("SELECT 1 AS present FROM agent_runs WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.runId) as { present: number } | null

        if (!run) {
          throw new AgentStorageError(
            "run_not_found",
            `[SixbSqlite] Agent run '${input.runId}' not found for project '${input.projectId}'.`
          )
        }
      }

      const seqRow = this.db
        .query(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_messages WHERE project_id = ? AND thread_id = ?"
        )
        .get(input.projectId, input.threadId) as { next: number }

      try {
        this.db
          .query(
            `
            INSERT INTO agent_messages (
              project_id,
              id,
              thread_id,
              run_id,
              role,
              author_principal_type,
              author_principal_id,
              seq,
              parts,
              metadata,
              content_version,
              created_at,
              completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.threadId,
            input.runId,
            input.role,
            input.authorPrincipal?.type ?? null,
            input.authorPrincipal?.id ?? null,
            seqRow.next,
            JSON.stringify(input.parts),
            input.metadata === undefined ? null : JSON.stringify(input.metadata),
            AGENT_MESSAGE_CONTENT_VERSION,
            createdAt.toISOString(),
            input.completedAt ? input.completedAt.toISOString() : null
          )
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbSqlite] Agent message '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }

      this.db
        .query(
          `
          UPDATE agent_threads
          SET message_count = message_count + 1, last_message_at = ?, updated_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(createdAt.toISOString(), createdAt.toISOString(), input.projectId, input.threadId)

      return this.requireMessage(input.projectId, input.id)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentMessageRecord | null> {
    const row = this.db
      .query("SELECT * FROM agent_messages WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as AgentMessageRow | null

    return row ? rowToMessageRecord(row) : null
  }

  async list(input: ListAgentMessagesInput): Promise<ListAgentMessagesResult> {
    if (input.roles !== undefined && input.roles.length === 0) {
      return { messages: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?", "thread_id = ?"]
    const args: SqliteValue[] = [input.projectId, input.threadId]

    if (input.roles) {
      whereClauses.push(`role IN (${input.roles.map(() => "?").join(", ")})`)
      args.push(...input.roles)
    }

    const dir = input.order === "desc" ? "DESC" : "ASC"
    const { rows, total, hasMore } = queryAgentList<AgentMessageRow>({
      db: this.db,
      table: "agent_messages",
      whereClauses,
      args,
      orderBy: `seq ${dir}`,
      limit: input.limit,
      offset: input.offset,
    })

    return { messages: rows.map(rowToMessageRecord), hasMore, total }
  }

  private requireMessage(projectId: string, id: string): AgentMessageRecord {
    const row = this.db
      .query("SELECT * FROM agent_messages WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentMessageRow | null

    if (!row) {
      throw new AgentStorageError(
        "invalid_state",
        `[SixbSqlite] Failed to load agent message '${id}' for project '${projectId}'.`
      )
    }

    return rowToMessageRecord(row)
  }
}
