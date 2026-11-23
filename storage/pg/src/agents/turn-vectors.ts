import {
  assertWriteAgentTurnVectorsInput,
  cachedTurnVectorSearchProbe,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  AgentStorageError,
  type AgentThreadIndexProgress,
  type AgentThreadToIndex,
  type AgentTurnVectorRecord,
  type AgentTurnVectorStore,
  type DeferAgentThreadIndexingInput,
  type GetAgentThreadIndexProgressInput,
  type ListAgentThreadsToIndexInput,
  type ListAgentTurnVectorsInput,
  type WriteAgentTurnVectorsInput,
} from "@sixb/core/storage"
import { type PgStoreClient, runPgTransaction } from "../transactions"

interface AgentTurnVectorRow {
  project_id: string
  thread_id: string
  message_id: string
  chunk: number
  first_seq: number
  last_seq: number
  turn_at: Date | string
  text: string
  configuration: string
  embedding: readonly (number | string)[]
  indexed_at: Date | string
}

interface AgentThreadIndexProgressRow {
  revision: number | string
  current: boolean
  newest_seq: number | null
  holding_stale_seq: number | null
  stale_from_seq: number | null
  failures: number | null
  deferred_until: Date | string | null
}

export class PgAgentTurnVectorStore implements AgentTurnVectorStore {
  readonly searchAvailable: () => Promise<boolean>

  constructor(private readonly sql: PgStoreClient) {
    // Search casts the stored REAL[] to pgvector's type, which must live in `public`.
    this.searchAvailable = cachedTurnVectorSearchProbe(async () => {
      const [row] = await this.sql<{ ready: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE e.extname = 'vector' AND n.nspname = 'public'
        ) AS ready
      `
      return row?.ready === true
    }, "SixbPg")
  }

  async progress(
    input: GetAgentThreadIndexProgressInput
  ): Promise<AgentThreadIndexProgress | null> {
    const [row] = await this.sql<AgentThreadIndexProgressRow[]>`
      SELECT
        thread.message_revision AS revision,
        COALESCE(
          state.configuration = ${input.configuration}
            AND thread.indexed_revision = thread.message_revision
            AND state.stale_from_seq IS NULL,
          false
        ) AS current,
        (
          SELECT MAX(first_seq) FROM agent_turn_vectors
          WHERE project_id = thread.project_id AND thread_id = thread.id
            AND configuration = ${input.configuration}
        ) AS newest_seq,
        (
          SELECT MAX(first_seq) FROM agent_turn_vectors
          WHERE project_id = thread.project_id AND thread_id = thread.id
            AND configuration = ${input.configuration}
            AND first_seq <= state.stale_from_seq
        ) AS holding_stale_seq,
        state.stale_from_seq,
        state.failures,
        state.deferred_until
      FROM agent_threads AS thread
      LEFT JOIN agent_thread_index_state AS state
        ON state.project_id = thread.project_id AND state.thread_id = thread.id
      WHERE thread.project_id = ${input.projectId} AND thread.id = ${input.threadId}
    `
    if (!row) return null

    const newest = row.newest_seq ?? 1
    const holdingStale = row.stale_from_seq === null ? newest : (row.holding_stale_seq ?? 1)

    return {
      threadId: input.threadId,
      revision: Number(row.revision),
      current: row.current,
      fromSeq: Math.min(newest, holdingStale),
      failures: row.failures ?? 0,
      ...(row.deferred_until === null ? {} : { deferredUntil: new Date(row.deferred_until) }),
    }
  }

  async write(input: WriteAgentTurnVectorsInput): Promise<boolean> {
    assertWriteAgentTurnVectorsInput(input, "SixbPg")

    return runPgTransaction(this.sql, async (tx) => {
      // Appends and deletions hold the thread FOR UPDATE: holding it too, the revision read here
      // is the one the turns were read at until this commits.
      const [thread] = await tx<{ message_revision: number | string }[]>`
        SELECT message_revision FROM agent_threads
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        FOR UPDATE
      `
      if (!thread || Number(thread.message_revision) !== input.revision) return false

      await tx`
        DELETE FROM agent_turn_vectors
        WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
          AND (first_seq >= ${input.fromSeq} OR configuration <> ${input.configuration})
      `

      const indexedAt = input.indexedAt ?? new Date()
      if (input.turns.length > 0) {
        const rows = input.turns.map((turn) => ({
          message_id: turn.messageId,
          chunk: turn.chunk,
          first_seq: turn.firstSeq,
          last_seq: turn.lastSeq,
          turn_at: turn.turnAt.toISOString(),
          text: turn.text,
          embedding: turn.embedding,
        }))
        await tx`
          INSERT INTO agent_turn_vectors (
            project_id, thread_id, message_id, chunk, first_seq, last_seq, turn_at, text,
            configuration, embedding, indexed_at
          )
          SELECT ${input.projectId}, ${input.threadId}, message_id, chunk, first_seq, last_seq,
            turn_at, text, ${input.configuration}, embedding, ${indexedAt}
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS turn(
            message_id text, chunk integer, first_seq integer, last_seq integer,
            turn_at timestamptz, text text, embedding real[]
          )
        `
      }

      await tx`
        UPDATE agent_threads
        SET indexed_revision = ${input.complete ? input.revision : null}
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
      `

      // A deletion before `fromSeq` still waits for its turn; one at or after it is rewritten now.
      await tx`
        INSERT INTO agent_thread_index_state (
          project_id, thread_id, configuration, stale_from_seq, deferred_until, failures, indexed_at
        ) VALUES (
          ${input.projectId}, ${input.threadId}, ${input.configuration}, NULL, NULL, 0, ${indexedAt}
        )
        ON CONFLICT (project_id, thread_id) DO UPDATE SET
          configuration = EXCLUDED.configuration,
          stale_from_seq = CASE
            WHEN agent_thread_index_state.configuration = EXCLUDED.configuration
              AND agent_thread_index_state.stale_from_seq < ${input.fromSeq}
            THEN agent_thread_index_state.stale_from_seq
          END,
          deferred_until = NULL,
          failures = 0,
          indexed_at = EXCLUDED.indexed_at
      `

      return true
    })
  }

  async defer(input: DeferAgentThreadIndexingInput): Promise<void> {
    const rows = await this.sql<{ thread_id: string }[]>`
      INSERT INTO agent_thread_index_state (
        project_id, thread_id, configuration, deferred_until, failures
      )
      SELECT project_id, id, ${input.configuration}, ${input.until}, ${input.failed ? 1 : 0}
      FROM agent_threads
      WHERE project_id = ${input.projectId} AND id = ${input.threadId}
      ON CONFLICT (project_id, thread_id) DO UPDATE SET
        deferred_until = EXCLUDED.deferred_until,
        failures = agent_thread_index_state.failures + EXCLUDED.failures
      RETURNING thread_id
    `
    if (rows.length === 0) {
      throw new AgentStorageError(
        "thread_not_found",
        `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }
  }

  async list(input: ListAgentTurnVectorsInput): Promise<readonly AgentTurnVectorRecord[]> {
    const rows = await this.sql<AgentTurnVectorRow[]>`
      SELECT project_id, thread_id, message_id, chunk, first_seq, last_seq, turn_at, text,
        configuration, embedding::float8[] AS embedding, indexed_at
      FROM agent_turn_vectors
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        AND first_seq >= ${input.fromSeq ?? 1}
      ORDER BY first_seq, chunk
    `
    return rows.map(rowToTurnVector)
  }

  async listThreadsToIndex(
    input: ListAgentThreadsToIndexInput
  ): Promise<readonly AgentThreadToIndex[]> {
    // Two index-backed reads find the candidates: threads behind their revision
    // (idx_agent_threads_turns_behind), and threads indexed with another configuration. A
    // deletion moves the revision too, so a stale index is behind by it.
    const rows = await this.sql<{ id: string; message_revision: number | string }[]>`
      WITH candidates AS (
        SELECT id AS thread_id FROM agent_threads
        WHERE project_id = ${input.projectId}
          AND kind = 'conversation'
          AND turns_behind
        UNION
        SELECT thread_id FROM agent_thread_index_state
        WHERE project_id = ${input.projectId} AND configuration <> ${input.configuration}
      )
      SELECT thread.id, thread.message_revision
      FROM candidates
      JOIN agent_threads AS thread
        ON thread.project_id = ${input.projectId} AND thread.id = candidates.thread_id
      LEFT JOIN agent_thread_index_state AS state
        ON state.project_id = thread.project_id AND state.thread_id = thread.id
      WHERE thread.kind = 'conversation'
        AND thread.active_run_id IS NULL
        AND (state.deferred_until IS NULL OR state.deferred_until <= ${input.now ?? new Date()})
      ORDER BY COALESCE(thread.last_message_at, thread.created_at) DESC, thread.id ASC
      LIMIT ${input.limit}
    `
    return rows.map((row) => ({ threadId: row.id, revision: Number(row.message_revision) }))
  }
}

function rowToTurnVector(row: AgentTurnVectorRow): AgentTurnVectorRecord {
  return {
    projectId: row.project_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    chunk: Number(row.chunk),
    firstSeq: Number(row.first_seq),
    lastSeq: Number(row.last_seq),
    turnAt: new Date(row.turn_at),
    text: row.text,
    configuration: row.configuration,
    embedding: row.embedding.map(Number),
    indexedAt: new Date(row.indexed_at),
  }
}
