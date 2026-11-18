import type { Database } from "bun:sqlite"
import {
  AgentStorageError,
  type AgentThreadReadState,
  type AgentThreadReadStore,
  type ListAgentThreadReadsInput,
  type MarkAgentThreadReadInput,
} from "@sixb/core/storage"
import { countedMessageSql } from "./rows"

interface AgentThreadReadStateRow {
  thread_id: string
  head_seq: number
  through_seq: number
  read_at: string | null
  unread: number
}

export class SqliteAgentThreadReadStore implements AgentThreadReadStore {
  constructor(private readonly db: Database) {}

  async mark(input: MarkAgentThreadReadInput): Promise<AgentThreadReadState> {
    // Immediate: no append or deletion moves the thread's messages while the mark reads them.
    return this.db
      .transaction(() => {
        const thread = this.db
          .query("SELECT 1 AS present FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.threadId) as { present: number } | null
        if (!thread) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
          )
        }

        const reached = this.reachedSeq(input)
        if (reached !== null) {
          // Never backwards: another device that read further keeps its place. Looking always
          // counts, so `read_at` moves even when the place does not. ISO strings sort as times.
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
                read_at = MAX(agent_thread_reads.read_at, excluded.read_at)
            `)
            .run(
              input.projectId,
              input.threadId,
              input.principal.id,
              reached,
              (input.readAt ?? new Date()).toISOString()
            )
        }

        const [state] = this.readStates(input.projectId, input.principal.id, [input.threadId])
        if (!state) {
          throw new Error(`[SixbSqlite] Agent thread '${input.threadId}' lost its read state.`)
        }
        return state
      })
      .immediate()
  }

  async list(input: ListAgentThreadReadsInput): Promise<readonly AgentThreadReadState[]> {
    if (input.threadIds.length === 0) return []

    return this.readStates(input.projectId, input.principal.id, [...new Set(input.threadIds)])
  }

  /** The seq a mark reaches: its message's, or the newest. `null` when the message is gone. */
  private reachedSeq(input: MarkAgentThreadReadInput): number | null {
    if (input.throughMessageId === undefined) {
      const head = this.db
        .query(
          "SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_messages WHERE project_id = ? AND thread_id = ?"
        )
        .get(input.projectId, input.threadId) as { seq: number }
      return head.seq
    }

    const message = this.db
      .query("SELECT seq FROM agent_messages WHERE project_id = ? AND thread_id = ? AND id = ?")
      .get(input.projectId, input.threadId, input.throughMessageId) as { seq: number } | null
    return message?.seq ?? null
  }

  /**
   * Each existing thread's place for one person, and the messages past it someone else wrote.
   * No row reads as 0. Both reads walk the thread's `(project_id, thread_id, seq)` index: the
   * count costs what is unread, not the thread's length.
   */
  private readStates(
    projectId: string,
    principalId: string,
    threadIds: readonly string[]
  ): AgentThreadReadState[] {
    const rows = this.db
      .query(`
        SELECT
          place.thread_id,
          place.head_seq,
          MIN(COALESCE(place.through_seq, 0), place.head_seq) AS through_seq,
          place.read_at,
          (
            SELECT COUNT(*) FROM agent_messages AS message
            WHERE message.project_id = ?2
              AND message.thread_id = place.thread_id
              AND message.seq > COALESCE(place.through_seq, 0)
              AND (
                message.role <> 'user'
                OR message.author_principal_type IS NOT 'user'
                OR message.author_principal_id IS NOT ?1
              )
              AND ${countedMessageSql("message")}
          ) AS unread
        FROM (
          SELECT
            thread.id AS thread_id,
            (
              SELECT COALESCE(MAX(seq), 0) FROM agent_messages
              WHERE project_id = thread.project_id AND thread_id = thread.id
            ) AS head_seq,
            reading.through_seq AS through_seq,
            reading.read_at AS read_at
          FROM agent_threads AS thread
          LEFT JOIN agent_thread_reads AS reading
            ON reading.project_id = thread.project_id
            AND reading.thread_id = thread.id
            AND reading.principal_type = 'user'
            AND reading.principal_id = ?1
          WHERE thread.project_id = ?2
            AND thread.id IN (SELECT value FROM json_each(?3))
        ) AS place
      `)
      .all(principalId, projectId, JSON.stringify(threadIds)) as AgentThreadReadStateRow[]

    return rows.map((row) => ({
      threadId: row.thread_id,
      throughSeq: row.through_seq,
      headSeq: row.head_seq,
      unread: row.unread,
      ...(row.read_at === null ? {} : { readAt: new Date(row.read_at) }),
    }))
  }
}
