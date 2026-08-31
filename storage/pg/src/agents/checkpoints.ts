import {
  agentContextCheckpointMatchesCreateInput,
  assertAgentContextCheckpointAnchors,
  assertAgentContextCheckpointAuthority,
  assertAgentContextCheckpointReplayState,
  assertCreateAgentContextCheckpointInput,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AgentContextCheckpointRecord,
  type AgentContextCheckpointStore,
  AgentStorageError,
  type CreateAgentContextCheckpointInput,
} from "@sixb/core/storage"
import { isUniqueViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import {
  type AgentContextCheckpointRow,
  type AgentMessageRow,
  type AgentRunRow,
  type AgentThreadRow,
  rowToContextCheckpointRecord,
  rowToMessageRecord,
  rowToRunRecord,
  rowToThreadRecord,
} from "./rows"

const PG_CHECKPOINT_RUN_ID_BATCH_SIZE = 10_000

export class PgAgentContextCheckpointStore implements AgentContextCheckpointStore {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateAgentContextCheckpointInput): Promise<AgentContextCheckpointRecord> {
    assertCreateAgentContextCheckpointInput(input, "SixbPg")

    try {
      return await runPgTransaction(this.sql, async (tx) => {
        // Match run finalization's lock order (run, then thread) to avoid a cross-operation deadlock.
        const [runRow] = await tx<AgentRunRow[]>`
          SELECT * FROM agent_runs
          WHERE project_id = ${input.projectId} AND id = ${input.createdByRunId}
          FOR UPDATE
        `
        const [threadRow] = await tx<AgentThreadRow[]>`
          SELECT * FROM agent_threads
          WHERE project_id = ${input.projectId} AND id = ${input.threadId}
          FOR UPDATE
        `
        assertAgentContextCheckpointAuthority({
          create: input,
          run: runRow ? rowToRunRecord(runRow) : null,
          thread: threadRow ? rowToThreadRecord(threadRow) : null,
          prefix: "SixbPg",
        })

        const [latestRow] = await tx<AgentContextCheckpointRow[]>`
          SELECT * FROM agent_context_checkpoints
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
          ORDER BY summarized_through_seq DESC, created_at DESC, id DESC
          LIMIT 1
        `
        const latest = latestRow ? rowToContextCheckpointRecord(latestRow) : null
        const [headRow] = await tx<{ seq: number | string }[]>`
          SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_messages
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        `
        const headSeq = Number(headRow?.seq ?? 0)

        const [existingForRunRow] = await tx<AgentContextCheckpointRow[]>`
          SELECT * FROM agent_context_checkpoints
          WHERE project_id = ${input.projectId} AND created_by_run_id = ${input.createdByRunId}
        `
        if (existingForRunRow) {
          const record = rowToContextCheckpointRecord(existingForRunRow)
          if (agentContextCheckpointMatchesCreateInput(record, input)) {
            assertAgentContextCheckpointReplayState({
              create: input,
              existing: record,
              latest,
              headSeq,
              prefix: "SixbPg",
            })
            return record
          }
          throw new AgentStorageError(
            "invalid_state",
            `[SixbPg] Agent run '${input.createdByRunId}' already created a different context checkpoint.`
          )
        }

        const [duplicateId] = await tx<{ present: number }[]>`
          SELECT 1 AS present FROM agent_context_checkpoints
          WHERE project_id = ${input.projectId} AND id = ${input.id}
        `
        if (duplicateId) {
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbPg] Agent context checkpoint '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        const [firstRetainedRow] = await tx<AgentMessageRow[]>`
          SELECT * FROM agent_messages
          WHERE
            project_id = ${input.projectId}
            AND thread_id = ${input.threadId}
            AND seq > ${input.summarizedThroughSeq}
          ORDER BY seq ASC
          LIMIT 1
        `
        assertAgentContextCheckpointAnchors({
          create: input,
          latest,
          headSeq,
          firstRetained: firstRetainedRow ? rowToMessageRecord(firstRetainedRow) : null,
          prefix: "SixbPg",
        })

        const [row] = await tx<AgentContextCheckpointRow[]>`
          INSERT INTO agent_context_checkpoints (
            project_id,
            id,
            thread_id,
            created_by_run_id,
            previous_checkpoint_id,
            reason,
            summary,
            summary_format_version,
            summarized_through_seq,
            observed_head_seq,
            estimated_input_tokens_before,
            estimated_input_tokens_after,
            summary_model_id,
            created_at
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.threadId},
            ${input.createdByRunId},
            ${input.expectedPreviousCheckpointId},
            ${input.reason},
            ${input.summary},
            ${input.summaryFormatVersion},
            ${input.summarizedThroughSeq},
            ${input.observedHeadSeq},
            ${input.estimatedInputTokensBefore},
            ${input.estimatedInputTokensAfter},
            ${input.summaryModelId},
            ${input.createdAt ?? new Date()}
          )
          RETURNING *
        `
        return rowToContextCheckpointRecord(row)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Agent context checkpoint '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
      throw error
    }
  }

  async getLatest(input: {
    readonly projectId: string
    readonly threadId: string
  }): Promise<AgentContextCheckpointRecord | null> {
    const [row] = await this.sql<AgentContextCheckpointRow[]>`
      SELECT * FROM agent_context_checkpoints
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
      ORDER BY summarized_through_seq DESC, created_at DESC, id DESC
      LIMIT 1
    `
    return row ? rowToContextCheckpointRecord(row) : null
  }

  async getByRunIds(input: {
    readonly projectId: string
    readonly runIds: readonly string[]
  }): Promise<readonly AgentContextCheckpointRecord[]> {
    const runIds = [...new Set(input.runIds)]
    if (runIds.length === 0) return []

    const rows: AgentContextCheckpointRow[] = []
    for (let offset = 0; offset < runIds.length; offset += PG_CHECKPOINT_RUN_ID_BATCH_SIZE) {
      const batch = runIds.slice(offset, offset + PG_CHECKPOINT_RUN_ID_BATCH_SIZE)
      const placeholders = batch.map((_, index) => `$${index + 2}`).join(", ")
      rows.push(
        ...(await this.sql.unsafe<AgentContextCheckpointRow[]>(
          `SELECT * FROM agent_context_checkpoints WHERE project_id = $1 AND created_by_run_id IN (${placeholders})`,
          [input.projectId, ...batch]
        ))
      )
    }
    const byRunId = new Map(
      rows.map((row) => [row.created_by_run_id, rowToContextCheckpointRecord(row)] as const)
    )
    return runIds.flatMap((runId) => {
      const checkpoint = byRunId.get(runId)
      return checkpoint ? [checkpoint] : []
    })
  }
}
