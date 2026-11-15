import {
  AgentStorageError,
  type AgentThreadReadRecord,
  type AgentThreadReadStore,
  type ListAgentThreadReadsInput,
  type MarkAgentThreadReadInput,
} from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"
import { type AgentThreadReadRow, rowToThreadReadRecord } from "./rows"

export class PgAgentThreadReadStore implements AgentThreadReadStore {
  constructor(private readonly sql: PgStoreClient) {}

  async mark(input: MarkAgentThreadReadInput): Promise<AgentThreadReadRecord> {
    const readAt = input.readAt ?? new Date()

    // One statement: clamp to the thread's head, insert or advance, and never move a row
    // backwards. No row comes back only when the thread does not exist.
    const [row] = await this.sql<AgentThreadReadRow[]>`
      WITH target AS (
        SELECT last_message_seq FROM agent_threads
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
      )
      INSERT INTO agent_thread_reads (
        project_id,
        thread_id,
        principal_type,
        principal_id,
        through_seq,
        read_at
      )
      SELECT
        ${input.projectId},
        ${input.threadId},
        'user',
        ${input.principal.id},
        LEAST(GREATEST(${Math.max(0, Math.trunc(input.throughSeq))}, 0), target.last_message_seq),
        ${readAt}
      FROM target
      ON CONFLICT (project_id, thread_id, principal_type, principal_id) DO UPDATE SET
        through_seq = GREATEST(agent_thread_reads.through_seq, EXCLUDED.through_seq),
        read_at = CASE
          WHEN EXCLUDED.through_seq > agent_thread_reads.through_seq THEN EXCLUDED.read_at
          ELSE agent_thread_reads.read_at
        END
      RETURNING *
    `

    if (!row) {
      throw new AgentStorageError(
        "thread_not_found",
        `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }

    return rowToThreadReadRecord(row)
  }

  async list(input: ListAgentThreadReadsInput): Promise<readonly AgentThreadReadRecord[]> {
    if (input.threadIds.length === 0) return []

    const rows = await this.sql<AgentThreadReadRow[]>`
      SELECT * FROM agent_thread_reads
      WHERE project_id = ${input.projectId}
        AND principal_type = 'user'
        AND principal_id = ${input.principal.id}
        AND thread_id = ANY(${this.sql.array([...input.threadIds])}::text[])
    `

    return rows.map(rowToThreadReadRecord)
  }
}
