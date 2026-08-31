import type { Database } from "bun:sqlite"
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

const SQLITE_CHECKPOINT_RUN_ID_BATCH_SIZE = 500

export class SqliteAgentContextCheckpointStore implements AgentContextCheckpointStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateAgentContextCheckpointInput): Promise<AgentContextCheckpointRecord> {
    assertCreateAgentContextCheckpointInput(input, "SixbSqlite")

    return this.db.transaction(() => {
      const runRow = this.db
        .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.createdByRunId) as AgentRunRow | null
      const threadRow = this.db
        .query("SELECT * FROM agent_threads WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.threadId) as AgentThreadRow | null
      assertAgentContextCheckpointAuthority({
        create: input,
        run: runRow ? rowToRunRecord(runRow) : null,
        thread: threadRow ? rowToThreadRecord(threadRow) : null,
        prefix: "SixbSqlite",
      })

      const latest = this.findLatest(input.projectId, input.threadId)
      const headRow = this.db
        .query(
          "SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_messages WHERE project_id = ? AND thread_id = ?"
        )
        .get(input.projectId, input.threadId) as { seq: number }

      const existingForRun = this.db
        .query(
          "SELECT * FROM agent_context_checkpoints WHERE project_id = ? AND created_by_run_id = ?"
        )
        .get(input.projectId, input.createdByRunId) as AgentContextCheckpointRow | null
      if (existingForRun) {
        const record = rowToContextCheckpointRecord(existingForRun)
        if (agentContextCheckpointMatchesCreateInput(record, input)) {
          assertAgentContextCheckpointReplayState({
            create: input,
            existing: record,
            latest,
            headSeq: headRow.seq,
            prefix: "SixbSqlite",
          })
          return record
        }
        throw new AgentStorageError(
          "invalid_state",
          `[SixbSqlite] Agent run '${input.createdByRunId}' already created a different context checkpoint.`
        )
      }

      const duplicateId = this.db
        .query("SELECT 1 FROM agent_context_checkpoints WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id)
      if (duplicateId) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbSqlite] Agent context checkpoint '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      const firstRetainedRow = this.db
        .query(
          "SELECT * FROM agent_messages WHERE project_id = ? AND thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1"
        )
        .get(input.projectId, input.threadId, input.summarizedThroughSeq) as AgentMessageRow | null
      assertAgentContextCheckpointAnchors({
        create: input,
        latest,
        headSeq: headRow.seq,
        firstRetained: firstRetainedRow ? rowToMessageRecord(firstRetainedRow) : null,
        prefix: "SixbSqlite",
      })

      const createdAt = input.createdAt ?? new Date()
      this.db
        .query(
          `
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          input.projectId,
          input.id,
          input.threadId,
          input.createdByRunId,
          input.expectedPreviousCheckpointId,
          input.reason,
          input.summary,
          input.summaryFormatVersion,
          input.summarizedThroughSeq,
          input.observedHeadSeq,
          input.estimatedInputTokensBefore,
          input.estimatedInputTokensAfter,
          input.summaryModelId,
          createdAt.toISOString()
        )

      return this.requireById(input.projectId, input.id)
    })()
  }

  async getLatest(input: {
    readonly projectId: string
    readonly threadId: string
  }): Promise<AgentContextCheckpointRecord | null> {
    return this.findLatest(input.projectId, input.threadId)
  }

  async getByRunIds(input: {
    readonly projectId: string
    readonly runIds: readonly string[]
  }): Promise<readonly AgentContextCheckpointRecord[]> {
    const runIds = [...new Set(input.runIds)]
    if (runIds.length === 0) return []

    const rows: AgentContextCheckpointRow[] = []
    for (let offset = 0; offset < runIds.length; offset += SQLITE_CHECKPOINT_RUN_ID_BATCH_SIZE) {
      const batch = runIds.slice(offset, offset + SQLITE_CHECKPOINT_RUN_ID_BATCH_SIZE)
      const placeholders = batch.map(() => "?").join(", ")
      rows.push(
        ...(this.db
          .query(
            `SELECT * FROM agent_context_checkpoints WHERE project_id = ? AND created_by_run_id IN (${placeholders})`
          )
          .all(input.projectId, ...batch) as AgentContextCheckpointRow[])
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

  private findLatest(projectId: string, threadId: string): AgentContextCheckpointRecord | null {
    const row = this.db
      .query(
        `
          SELECT * FROM agent_context_checkpoints
          WHERE project_id = ? AND thread_id = ?
          ORDER BY summarized_through_seq DESC, created_at DESC, id DESC
          LIMIT 1
        `
      )
      .get(projectId, threadId) as AgentContextCheckpointRow | null
    return row ? rowToContextCheckpointRecord(row) : null
  }

  private requireById(projectId: string, id: string): AgentContextCheckpointRecord {
    const row = this.db
      .query("SELECT * FROM agent_context_checkpoints WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentContextCheckpointRow | null
    if (!row) {
      throw new AgentStorageError(
        "invalid_state",
        `[SixbSqlite] Failed to load agent context checkpoint '${id}' for project '${projectId}'.`
      )
    }
    return rowToContextCheckpointRecord(row)
  }
}
