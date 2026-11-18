import {
  AgentStorageError,
  type AgentThreadReadState,
  type AgentThreadReadStore,
  type ListAgentThreadReadsInput,
  type MarkAgentThreadReadInput,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { type PgStoreClient, runPgTransaction } from "../transactions"

interface AgentThreadReadStateRow {
  thread_id: string
  head_seq: number | string
  through_seq: number | string
  read_at: Date | string | null
  unread: number | string
}

export class PgAgentThreadReadStore implements AgentThreadReadStore {
  constructor(private readonly sql: PgStoreClient) {}

  async mark(input: MarkAgentThreadReadInput): Promise<AgentThreadReadState> {
    return runPgTransaction(this.sql, async (tx) => {
      // Appends and deletions hold the thread row FOR UPDATE: sharing it, the mark reads a
      // thread no retry or edit is renumbering.
      const [thread] = await tx<{ id: string }[]>`
        SELECT id FROM agent_threads
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        FOR SHARE
      `
      if (!thread) {
        throw new AgentStorageError(
          "thread_not_found",
          `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
        )
      }

      const reached = await reachedSeq(tx, input)
      if (reached !== null) {
        // Never backwards: another device that read further keeps its place. Looking always
        // counts, so `read_at` moves even when the place does not.
        await tx`
          INSERT INTO agent_thread_reads (
            project_id,
            thread_id,
            principal_type,
            principal_id,
            through_seq,
            read_at
          ) VALUES (
            ${input.projectId},
            ${input.threadId},
            'user',
            ${input.principal.id},
            ${reached},
            ${input.readAt ?? new Date()}
          )
          ON CONFLICT (project_id, thread_id, principal_type, principal_id) DO UPDATE SET
            through_seq = GREATEST(agent_thread_reads.through_seq, EXCLUDED.through_seq),
            read_at = GREATEST(agent_thread_reads.read_at, EXCLUDED.read_at)
        `
      }

      const [state] = await readStates(tx, input.projectId, input.principal.id, [input.threadId])
      if (!state) {
        throw new Error(`[SixbPg] Agent thread '${input.threadId}' lost its read state.`)
      }
      return state
    })
  }

  async list(input: ListAgentThreadReadsInput): Promise<readonly AgentThreadReadState[]> {
    if (input.threadIds.length === 0) return []

    return readStates(this.sql, input.projectId, input.principal.id, [...new Set(input.threadIds)])
  }
}

/** The seq a mark reaches: its message's, or the newest. `null` when the message is gone. */
async function reachedSeq(tx: SQLClient, input: MarkAgentThreadReadInput): Promise<number | null> {
  if (input.throughMessageId === undefined) {
    const [head] = await tx<{ seq: number | string }[]>`
      SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_messages
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
    `
    return Number(head?.seq ?? 0)
  }

  const [message] = await tx<{ seq: number | string }[]>`
    SELECT seq FROM agent_messages
    WHERE project_id = ${input.projectId}
      AND thread_id = ${input.threadId}
      AND id = ${input.throughMessageId}
  `
  return message ? Number(message.seq) : null
}

/**
 * Each existing thread's place for one person, and the messages past it someone else wrote.
 * No row reads as 0. A message counts unless it is their own user message or one that only
 * reports approval outcomes (`countsAsThreadMessage`). Both reads walk the thread's
 * `(project_id, thread_id, seq)` index: the count costs what is unread, not the thread's length.
 */
async function readStates(
  sql: PgStoreClient,
  projectId: string,
  principalId: string,
  threadIds: readonly string[]
): Promise<AgentThreadReadState[]> {
  const rows = await sql<AgentThreadReadStateRow[]>`
    SELECT
      place.thread_id,
      place.head_seq,
      LEAST(COALESCE(place.through_seq, 0), place.head_seq) AS through_seq,
      place.read_at,
      (
        SELECT COUNT(*) FROM agent_messages AS message
        WHERE message.project_id = ${projectId}
          AND message.thread_id = place.thread_id
          AND message.seq > COALESCE(place.through_seq, 0)
          AND (
            message.role <> 'user'
            OR message.author_principal_type IS DISTINCT FROM 'user'
            OR message.author_principal_id IS DISTINCT FROM ${principalId}
          )
          AND NOT (
            jsonb_array_length(message.parts) > 0 AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(message.parts) AS part
              WHERE part->>'type' <> 'approval-outcome'
            )
          )
      ) AS unread
    FROM (
      SELECT
        thread.id AS thread_id,
        (
          SELECT COALESCE(MAX(seq), 0) FROM agent_messages
          WHERE project_id = thread.project_id AND thread_id = thread.id
        ) AS head_seq,
        reading.through_seq,
        reading.read_at
      FROM agent_threads AS thread
      LEFT JOIN agent_thread_reads AS reading
        ON reading.project_id = thread.project_id
        AND reading.thread_id = thread.id
        AND reading.principal_type = 'user'
        AND reading.principal_id = ${principalId}
      WHERE thread.project_id = ${projectId}
        AND thread.id = ANY(${sql.array([...threadIds])}::text[])
    ) AS place
  `

  return rows.map((row) => ({
    threadId: row.thread_id,
    throughSeq: Number(row.through_seq),
    headSeq: Number(row.head_seq),
    unread: Number(row.unread),
    ...(row.read_at === null ? {} : { readAt: new Date(row.read_at) }),
  }))
}
