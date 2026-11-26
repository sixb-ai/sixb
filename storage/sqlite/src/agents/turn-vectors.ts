import type { Database } from "bun:sqlite"
import { ObjectQueryExecutionError } from "@sixb/core"
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
  type HaltAgentThreadIndexingInput,
  type ListAgentThreadsToIndexInput,
  type ListAgentTurnVectorsInput,
  type WriteAgentTurnVectorsInput,
} from "@sixb/core/storage"
import { ensureSqliteVectorSearch } from "../objects/vector-extension"
import { encodeSqliteVector } from "../vector-encoding"

interface AgentTurnVectorRow {
  project_id: string
  thread_id: string
  message_id: string
  chunk: number
  first_seq: number
  last_seq: number
  turn_at: string
  text: string
  configuration: string
  embedding: Uint8Array
  indexed_at: string
}

interface AgentThreadIndexProgressRow {
  revision: number
  current: number
  newest_seq: number | null
  holding_stale_seq: number | null
  stale_from_seq: number | null
  failures: number | null
  deferred_until: string | null
  halted: number
}

export class SqliteAgentTurnVectorStore implements AgentTurnVectorStore {
  readonly searchAvailable: () => Promise<boolean>

  constructor(private readonly db: Database) {
    this.searchAvailable = cachedTurnVectorSearchProbe(async () => {
      try {
        ensureSqliteVectorSearch(this.db)
        return true
      } catch (error) {
        // A SQLite built without extension loading: a plain no. Anything else is worth a warning.
        if (error instanceof ObjectQueryExecutionError) return false
        throw error
      }
    }, "SixbSqlite")
  }

  async progress(
    input: GetAgentThreadIndexProgressInput
  ): Promise<AgentThreadIndexProgress | null> {
    const row = this.db
      .query(`
        SELECT
          thread.message_revision AS revision,
          COALESCE(
            state.configuration = ?3
              AND thread.indexed_revision = thread.message_revision
              AND state.stale_from_seq IS NULL,
            0
          ) AS current,
          (
            SELECT MAX(first_seq) FROM agent_turn_vectors
            WHERE project_id = thread.project_id AND thread_id = thread.id AND configuration = ?3
          ) AS newest_seq,
          (
            SELECT MAX(first_seq) FROM agent_turn_vectors
            WHERE project_id = thread.project_id AND thread_id = thread.id AND configuration = ?3
              AND first_seq <= state.stale_from_seq
          ) AS holding_stale_seq,
          state.stale_from_seq,
          state.failures,
          state.deferred_until,
          COALESCE(
            state.configuration = ?3 AND state.halted_revision = thread.message_revision,
            0
          ) AS halted
        FROM agent_threads AS thread
        LEFT JOIN agent_thread_index_state AS state
          ON state.project_id = thread.project_id AND state.thread_id = thread.id
        WHERE thread.project_id = ?1 AND thread.id = ?2
      `)
      .get(
        input.projectId,
        input.threadId,
        input.configuration
      ) as AgentThreadIndexProgressRow | null
    if (!row) return null

    const newest = row.newest_seq ?? 1
    const holdingStale = row.stale_from_seq === null ? newest : (row.holding_stale_seq ?? 1)

    return {
      threadId: input.threadId,
      revision: row.revision,
      current: row.current === 1,
      fromSeq: Math.min(newest, holdingStale),
      failures: row.failures ?? 0,
      ...(row.deferred_until === null ? {} : { deferredUntil: new Date(row.deferred_until) }),
      halted: row.halted === 1,
    }
  }

  async write(input: WriteAgentTurnVectorsInput): Promise<boolean> {
    assertWriteAgentTurnVectorsInput(input, "SixbSqlite")

    // Immediate: no append or deletion moves the thread's revision while this writes.
    return this.db
      .transaction(() => {
        const thread = this.db
          .query("SELECT message_revision FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.threadId) as { message_revision: number } | null
        if (!thread || thread.message_revision !== input.revision) return false

        this.db
          .query(`
            DELETE FROM agent_turn_vectors
            WHERE project_id = ? AND thread_id = ? AND (first_seq >= ? OR configuration <> ?)
          `)
          .run(input.projectId, input.threadId, input.fromSeq, input.configuration)

        const indexedAt = (input.indexedAt ?? new Date()).toISOString()
        const insert = this.db.query(`
          INSERT INTO agent_turn_vectors (
            project_id, thread_id, message_id, chunk, first_seq, last_seq, turn_at, text,
            configuration, embedding, indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const turn of input.turns) {
          insert.run(
            input.projectId,
            input.threadId,
            turn.messageId,
            turn.chunk,
            turn.firstSeq,
            turn.lastSeq,
            turn.turnAt.toISOString(),
            turn.text,
            input.configuration,
            encodeSqliteVector(turn.embedding),
            indexedAt
          )
        }

        this.db
          .query("UPDATE agent_threads SET indexed_revision = ? WHERE project_id = ? AND id = ?")
          .run(input.complete ? input.revision : null, input.projectId, input.threadId)

        // A deletion before `fromSeq` still waits for its turn; one at or after it is rewritten now.
        this.db
          .query(`
            INSERT INTO agent_thread_index_state (
              project_id, thread_id, configuration, stale_from_seq, deferred_until, failures,
              indexed_at
            ) VALUES (?1, ?2, ?3, NULL, NULL, 0, ?4)
            ON CONFLICT (project_id, thread_id) DO UPDATE SET
              configuration = excluded.configuration,
              stale_from_seq = CASE
                WHEN agent_thread_index_state.configuration = excluded.configuration
                  AND agent_thread_index_state.stale_from_seq < ?5
                THEN agent_thread_index_state.stale_from_seq
              END,
              deferred_until = NULL,
              failures = 0,
              halted_revision = NULL,
              indexed_at = excluded.indexed_at
          `)
          .run(input.projectId, input.threadId, input.configuration, indexedAt, input.fromSeq)

        return true
      })
      .immediate()
  }

  async defer(input: DeferAgentThreadIndexingInput): Promise<void> {
    const row = this.db
      .query(`
        INSERT INTO agent_thread_index_state (
          project_id, thread_id, configuration, deferred_until, failures
        )
        SELECT project_id, id, ?3, ?4, ?5 FROM agent_threads WHERE project_id = ?1 AND id = ?2
        ON CONFLICT (project_id, thread_id) DO UPDATE SET
          deferred_until = excluded.deferred_until,
          failures = agent_thread_index_state.failures + excluded.failures
        RETURNING thread_id
      `)
      .get(
        input.projectId,
        input.threadId,
        input.configuration,
        input.until.toISOString(),
        input.failed ? 1 : 0
      )
    if (!row) {
      throw new AgentStorageError(
        "thread_not_found",
        `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }
  }

  async halt(input: HaltAgentThreadIndexingInput): Promise<boolean> {
    return this.db
      .transaction(() => {
        const thread = this.db
          .query("SELECT message_revision FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.threadId) as { message_revision: number } | null
        if (!thread || thread.message_revision !== input.revision) return false

        // The state is about the configuration that failed now: under another, nothing is indexed.
        this.db
          .query("UPDATE agent_threads SET indexed_revision = NULL WHERE project_id = ? AND id = ?")
          .run(input.projectId, input.threadId)
        this.db
          .query(`
            INSERT INTO agent_thread_index_state (
              project_id, thread_id, configuration, halted_revision
            ) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT (project_id, thread_id) DO UPDATE SET
              configuration = excluded.configuration,
              stale_from_seq = CASE
                WHEN agent_thread_index_state.configuration = excluded.configuration
                THEN agent_thread_index_state.stale_from_seq
              END,
              deferred_until = NULL,
              failures = 0,
              halted_revision = excluded.halted_revision
          `)
          .run(input.projectId, input.threadId, input.configuration, input.revision)

        return true
      })
      .immediate()
  }

  async list(input: ListAgentTurnVectorsInput): Promise<readonly AgentTurnVectorRecord[]> {
    const rows = this.db
      .query(`
        SELECT * FROM agent_turn_vectors
        WHERE project_id = ? AND thread_id = ? AND first_seq >= ?
        ORDER BY first_seq, chunk
      `)
      .all(input.projectId, input.threadId, input.fromSeq ?? 1) as AgentTurnVectorRow[]
    return rows.map(rowToTurnVector)
  }

  async listThreadsToIndex(
    input: ListAgentThreadsToIndexInput
  ): Promise<readonly AgentThreadToIndex[]> {
    // Two index-backed reads find the candidates: threads behind their revision
    // (idx_agent_threads_turns_behind), and threads indexed with another configuration. A
    // deletion moves the revision too, so a stale index is behind by it. ISO timestamps sort as
    // times.
    const rows = this.db
      .query(`
        WITH candidates AS (
          SELECT id AS thread_id FROM agent_threads
          WHERE project_id = ?1
            AND kind = 'conversation'
            AND indexed_revision IS NOT message_revision
          UNION
          SELECT thread_id FROM agent_thread_index_state
          WHERE project_id = ?1 AND configuration <> ?2
        )
        SELECT thread.id, thread.message_revision
        FROM candidates
        JOIN agent_threads AS thread
          ON thread.project_id = ?1 AND thread.id = candidates.thread_id
        LEFT JOIN agent_thread_index_state AS state
          ON state.project_id = thread.project_id AND state.thread_id = thread.id
        WHERE thread.kind = 'conversation'
          AND thread.active_run_id IS NULL
          AND (state.deferred_until IS NULL OR state.deferred_until <= ?3)
          AND NOT COALESCE(
            state.configuration = ?2 AND state.halted_revision = thread.message_revision,
            0
          )
        ORDER BY COALESCE(thread.last_message_at, thread.created_at) DESC, thread.id ASC
        LIMIT ?4
      `)
      .all(
        input.projectId,
        input.configuration,
        (input.now ?? new Date()).toISOString(),
        input.limit
      ) as { id: string; message_revision: number }[]
    return rows.map((row) => ({ threadId: row.id, revision: row.message_revision }))
  }
}

function rowToTurnVector(row: AgentTurnVectorRow): AgentTurnVectorRecord {
  const bytes = new Uint8Array(row.embedding)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const embedding = Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
    view.getFloat32(index * 4, true)
  )

  return {
    projectId: row.project_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    chunk: row.chunk,
    firstSeq: row.first_seq,
    lastSeq: row.last_seq,
    turnAt: new Date(row.turn_at),
    text: row.text,
    configuration: row.configuration,
    embedding,
    indexedAt: new Date(row.indexed_at),
  }
}
