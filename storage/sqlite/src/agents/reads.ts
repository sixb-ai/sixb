import type { Database } from "bun:sqlite"
import {
  AgentStorageError,
  type AgentThreadReadRecord,
  type AgentThreadReadStore,
  type ListAgentThreadReadsInput,
  type MarkAgentThreadReadInput,
} from "@sixb/core/storage"
import { type AgentThreadReadRow, rowToThreadReadRecord } from "./rows"

export class SqliteAgentThreadReadStore implements AgentThreadReadStore {
  constructor(private readonly db: Database) {}

  async mark(input: MarkAgentThreadReadInput): Promise<AgentThreadReadRecord> {
    return this.db
      .transaction(() => {
        const thread = this.db
          .query("SELECT last_message_seq FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.threadId) as { last_message_seq: number } | null
        if (!thread) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
          )
        }

        const throughSeq = Math.min(
          Math.max(0, Math.trunc(input.throughSeq)),
          thread.last_message_seq
        )
        const readAt = (input.readAt ?? new Date()).toISOString()

        // One statement: clamp, insert or advance, and never move a row backwards.
        this.db
          .query(`
            INSERT INTO agent_thread_reads (
              project_id,
              thread_id,
              principal_type,
              principal_id,
              through_seq,
              read_at
            ) VALUES (?, ?, 'user', ?, ?, ?)
            ON CONFLICT (project_id, thread_id, principal_type, principal_id) DO UPDATE SET
              through_seq = MAX(agent_thread_reads.through_seq, excluded.through_seq),
              read_at = CASE
                WHEN excluded.through_seq > agent_thread_reads.through_seq THEN excluded.read_at
                ELSE agent_thread_reads.read_at
              END
          `)
          .run(input.projectId, input.threadId, input.principal.id, throughSeq, readAt)

        const row = this.db
          .query(
            `SELECT * FROM agent_thread_reads
             WHERE project_id = ? AND thread_id = ?
               AND principal_type = 'user' AND principal_id = ?`
          )
          .get(input.projectId, input.threadId, input.principal.id) as AgentThreadReadRow
        return rowToThreadReadRecord(row)
      })
      .immediate()
  }

  async list(input: ListAgentThreadReadsInput): Promise<readonly AgentThreadReadRecord[]> {
    if (input.threadIds.length === 0) return []

    const rows = this.db
      .query(`
        SELECT * FROM agent_thread_reads
        WHERE project_id = ?
          AND principal_type = 'user'
          AND principal_id = ?
          AND thread_id IN (SELECT value FROM json_each(?))
      `)
      .all(
        input.projectId,
        input.principal.id,
        JSON.stringify(input.threadIds)
      ) as AgentThreadReadRow[]

    return rows.map(rowToThreadReadRecord)
  }
}
