import { ObjectQueryExecutionError } from "@sixb/core"
import {
  assertSearchAgentTurnVectorsInput,
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
  type SearchAgentTurnVectorsInput,
  type SearchAgentTurnVectorsResult,
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

interface AgentTurnSearchRow {
  searched_from: Date | string | null
  thread_id: string | null
  message_id: string
  chunk: number
  first_seq: number
  last_seq: number
  turn_at: Date | string
  text: string
  score: number | string
}

interface AgentThreadIndexProgressRow {
  revision: number | string
  current: boolean
  newest_seq: number | null
  holding_stale_seq: number | null
  stale_from_seq: number | null
  failures: number | null
  deferred_until: Date | string | null
  halted: boolean
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
        state.deferred_until,
        COALESCE(
          state.configuration = ${input.configuration}
            AND state.halted_revision = thread.message_revision,
          false
        ) AS halted
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
      halted: row.halted,
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
          halted_revision = NULL,
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

  async halt(input: HaltAgentThreadIndexingInput): Promise<boolean> {
    return runPgTransaction(this.sql, async (tx) => {
      // Held as `write` holds it: no append or deletion moves the revision until this commits.
      const [thread] = await tx<{ message_revision: number | string }[]>`
        SELECT message_revision FROM agent_threads
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        FOR UPDATE
      `
      if (!thread || Number(thread.message_revision) !== input.revision) return false

      // The state is about the configuration that failed now: under another, nothing is indexed.
      await tx`
        UPDATE agent_threads SET indexed_revision = NULL
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
      `
      await tx`
        INSERT INTO agent_thread_index_state (
          project_id, thread_id, configuration, halted_revision
        ) VALUES (
          ${input.projectId}, ${input.threadId}, ${input.configuration}, ${input.revision}
        )
        ON CONFLICT (project_id, thread_id) DO UPDATE SET
          configuration = EXCLUDED.configuration,
          stale_from_seq = CASE
            WHEN agent_thread_index_state.configuration = EXCLUDED.configuration
            THEN agent_thread_index_state.stale_from_seq
          END,
          deferred_until = NULL,
          failures = 0,
          halted_revision = EXCLUDED.halted_revision
      `

      return true
    })
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

  async search(input: SearchAgentTurnVectorsInput): Promise<SearchAgentTurnVectorsResult> {
    assertSearchAgentTurnVectorsInput(input, "SixbPg")
    if (!(await this.searchAvailable())) {
      throw new ObjectQueryExecutionError(
        "vector_extension_missing",
        "PostgreSQL vector search requires pgvector installed in schema public (CREATE EXTENSION vector WITH SCHEMA public)."
      )
    }

    const { projectId, principal } = input
    const sql = this.sql

    // The principal's conversations, read from two indexes: those they own
    // (idx_agent_threads_project_owner_activity) and those they were added to
    // (idx_agent_thread_participants_principal). Only a conversation takes participants.
    const theirs = principal
      ? sql`
          SELECT id FROM agent_threads
          WHERE project_id = ${projectId} AND kind = 'conversation'
            AND owner_principal_type = ${principal.type} AND owner_principal_id = ${principal.id}
          UNION
          SELECT thread_id FROM agent_thread_participants
          WHERE project_id = ${projectId}
            AND principal_type = ${principal.type} AND principal_id = ${principal.id}
        `
      : sql`SELECT id FROM agent_threads WHERE project_id = ${projectId} AND kind = 'conversation'`

    const shared =
      input.scope === "shared"
        ? sql`
            AND EXISTS (
              SELECT 1 FROM agent_thread_participants AS participant
              WHERE participant.project_id = ${projectId} AND participant.thread_id = theirs.id
            )
          `
        : sql``
    const excluded =
      input.excludeThreadId === undefined ? sql`` : sql`AND theirs.id <> ${input.excludeThreadId}`
    const since = input.since ? sql`AND vector.turn_at >= ${input.since}` : sql``
    const until = input.until ? sql`AND vector.turn_at < ${input.until}` : sql``

    // `recent` reads keys alone, the most recent first, one past the candidates: whether that one
    // exists says whether the window is cut, and where. Only the candidates' embeddings are read,
    // and scored exactly: `scored` is materialized, so no filter on the score reaches the scan of
    // `agent_turn_vectors`, where it would score every row. Ids order by code unit, as every
    // provider does.
    const rows = await sql<AgentTurnSearchRow[]>`
      WITH theirs AS (${theirs}),
      eligible AS (
        SELECT theirs.id FROM theirs WHERE true ${excluded} ${shared}
      ),
      recent AS MATERIALIZED (
        SELECT vector.thread_id, vector.message_id, vector.chunk, vector.turn_at
        FROM eligible
        JOIN agent_turn_vectors AS vector
          ON vector.project_id = ${projectId} AND vector.thread_id = eligible.id
        WHERE vector.configuration = ${input.configuration} ${since} ${until}
        ORDER BY vector.turn_at DESC, vector.thread_id COLLATE "C", vector.message_id COLLATE "C",
          vector.chunk
        LIMIT ${input.candidates + 1}
      ),
      bound AS (
        SELECT CASE WHEN COUNT(*) > ${input.candidates} THEN COALESCE(
          MIN(turn_at) FILTER (WHERE turn_at > (SELECT MIN(turn_at) FROM recent)),
          MIN(turn_at)
        ) END AS searched_from
        FROM recent
      ),
      candidates AS (
        SELECT recent.* FROM recent, bound
        WHERE bound.searched_from IS NULL OR recent.turn_at >= bound.searched_from
        ORDER BY recent.turn_at DESC, recent.thread_id COLLATE "C", recent.message_id COLLATE "C",
          recent.chunk
        LIMIT ${input.candidates}
      ),
      scored AS MATERIALIZED (
        SELECT candidates.thread_id, candidates.message_id, candidates.chunk, candidates.turn_at,
          CASE WHEN cardinality(vector.embedding) = ${input.vector.length} THEN 1 - (
            vector.embedding::public.vector
              OPERATOR(public.<=>) ${JSON.stringify(input.vector)}::public.vector
          ) END AS score
        FROM candidates
        JOIN agent_turn_vectors AS vector
          ON vector.project_id = ${projectId}
            AND vector.message_id = candidates.message_id AND vector.chunk = candidates.chunk
      ),
      turns AS (
        SELECT DISTINCT ON (message_id) * FROM scored
        WHERE score IS NOT NULL
        ORDER BY message_id, score DESC, chunk
      ),
      ranked AS (
        SELECT turns.*, row_number() OVER (
          PARTITION BY thread_id ORDER BY score DESC, turn_at DESC, message_id COLLATE "C"
        ) AS place
        FROM turns
      ),
      best AS (
        SELECT * FROM ranked WHERE place <= ${input.perThread}
        ORDER BY score DESC, turn_at DESC, thread_id COLLATE "C", message_id COLLATE "C"
        LIMIT ${input.k}
      )
      SELECT bound.searched_from, best.thread_id, best.message_id, best.chunk, best.turn_at,
        best.score, vector.first_seq, vector.last_seq, vector.text
      FROM bound
      LEFT JOIN best ON true
      LEFT JOIN agent_turn_vectors AS vector
        ON vector.project_id = ${projectId}
          AND vector.message_id = best.message_id AND vector.chunk = best.chunk
      ORDER BY best.score DESC, best.turn_at DESC, best.thread_id COLLATE "C",
        best.message_id COLLATE "C"
    `

    const searchedFrom = rows[0]?.searched_from
    return {
      hits: rows.flatMap((row) =>
        row.thread_id === null
          ? []
          : [
              {
                threadId: row.thread_id,
                messageId: row.message_id,
                chunk: Number(row.chunk),
                firstSeq: Number(row.first_seq),
                lastSeq: Number(row.last_seq),
                turnAt: new Date(row.turn_at),
                text: row.text,
                score: Math.max(-1, Math.min(1, Number(row.score))),
              },
            ]
      ),
      ...(searchedFrom ? { searchedFrom: new Date(searchedFrom) } : {}),
    }
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
        AND NOT COALESCE(
          state.configuration = ${input.configuration}
            AND state.halted_revision = thread.message_revision,
          false
        )
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
