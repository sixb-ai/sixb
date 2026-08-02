import type { Database } from "bun:sqlite"
import {
  type AgentRunRecord,
  type AgentRunStore,
  AgentStorageError,
  type ConfirmAgentRunExecutionOwnershipInput,
  type CreateAgentRunInput,
  type FinishAgentRunInput,
  type FinishQueuedAgentRunInput,
  type ListAgentRunsInput,
  type ListAgentRunsResult,
  type ReclaimAgentRunInput,
  type StartAgentRunInput,
  serializeSixbFailure,
} from "@sixb/core/storage"
import {
  appendRunListFilters,
  hasEmptyStatuses,
  queryRunList,
  type SqliteValue,
} from "../run-list-query"
import { isUniqueConstraintError } from "../storage-errors"
import { type AgentRunRow, rowToRunRecord } from "./rows"

const SQLITE_RUN_ID_BATCH_SIZE = 500

export class SqliteAgentRunStore implements AgentRunStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    const createdAt = input.createdAt ?? new Date()

    return this.db.transaction(() => {
      const thread = this.db
        .query("SELECT active_run_id FROM agent_threads WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.threadId) as { active_run_id: string | null } | null

      if (!thread) {
        throw new AgentStorageError(
          "thread_not_found",
          `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
        )
      }

      if (thread.active_run_id !== null) {
        throw new AgentStorageError(
          "active_run_exists",
          `[SixbSqlite] Agent thread '${input.threadId}' already has an active run '${thread.active_run_id}'.`
        )
      }

      try {
        this.db
          .query(
            `
            INSERT INTO agent_runs (
              project_id,
              id,
              thread_id,
              agent_id,
              trigger_message_id,
              requested_by_principal_type,
              requested_by_principal_id,
              status,
              attempt,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.threadId,
            input.agentId,
            input.triggerMessageId,
            input.requestedByPrincipal.type,
            input.requestedByPrincipal.id,
            createdAt.toISOString()
          )
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbSqlite] Agent run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }

      this.db
        .query(
          "UPDATE agent_threads SET active_run_id = ?, updated_at = ? WHERE project_id = ? AND id = ?"
        )
        .run(input.id, createdAt.toISOString(), input.projectId, input.threadId)

      return this.requireRun(input.projectId, input.id)
    })()
  }

  async start(input: StartAgentRunInput): Promise<AgentRunRecord> {
    const startedAt = input.startedAt ?? new Date()
    return this.db.transaction(() => {
      this.requireStatus(input.projectId, input.id, "queued")
      this.db
        .query(
          `
          UPDATE agent_runs
          SET
            status = 'running',
            execution_principal_type = ?,
            execution_principal_id = ?,
            model_id = ?,
            attempt = 1,
            execution_token = ?,
            execution_queue_lease_expires_at = ?,
            started_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.executionPrincipal?.type ?? null,
          input.executionPrincipal?.id ?? null,
          input.modelId ?? null,
          input.execution.token,
          input.execution.queueLeaseExpiresAt.toISOString(),
          startedAt.toISOString(),
          input.projectId,
          input.id
        )

      return this.requireRun(input.projectId, input.id)
    })()
  }

  async finishQueued(input: FinishQueuedAgentRunInput): Promise<AgentRunRecord> {
    const completedAt = input.completedAt ?? new Date()
    return this.db.transaction(() => {
      const run = this.requireStatus(input.projectId, input.id, "queued")
      this.db
        .query(
          `
          UPDATE agent_runs
          SET status = ?, error = ?, completed_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          serializeSixbFailure(input.error),
          completedAt.toISOString(),
          input.projectId,
          input.id
        )
      this.releaseThread(run, completedAt)
      return this.requireRun(input.projectId, input.id)
    })()
  }

  async reclaim(input: ReclaimAgentRunInput): Promise<AgentRunRecord> {
    return this.db.transaction(() => {
      this.requireRunning(input.projectId, input.id)
      this.db
        .query(
          `
          UPDATE agent_runs
          SET
            attempt = attempt + 1,
            execution_token = ?,
            execution_queue_lease_expires_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.execution.token,
          input.execution.queueLeaseExpiresAt.toISOString(),
          input.projectId,
          input.id
        )

      return this.requireRun(input.projectId, input.id)
    })()
  }

  async confirmExecutionOwnership(
    input: ConfirmAgentRunExecutionOwnershipInput
  ): Promise<AgentRunRecord> {
    return this.db.transaction(() => {
      const run = this.requireRunning(input.projectId, input.id)
      if (run.execution_token !== input.executionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[SixbSqlite] Execution token is no longer current on agent run '${input.id}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE agent_runs
          SET execution_queue_lease_expires_at = MAX(execution_queue_lease_expires_at, ?)
          WHERE project_id = ? AND id = ?
        `
        )
        .run(input.queueLeaseExpiresAt.toISOString(), input.projectId, input.id)
      return this.requireRun(input.projectId, input.id)
    })()
  }

  async finish(input: FinishAgentRunInput): Promise<AgentRunRecord> {
    const completedAt = input.completedAt ?? new Date()
    const errorValue = input.status === "succeeded" ? null : serializeSixbFailure(input.error)

    return this.db.transaction(() => {
      const run = this.requireRunning(input.projectId, input.id)

      if (run.execution_token !== input.executionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[SixbSqlite] Execution token is no longer current on agent run '${input.id}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE agent_runs
          SET
            status = ?,
            model_id = COALESCE(?, model_id),
            finish_reason = ?,
            usage_input_tokens = ?,
            usage_output_tokens = ?,
            usage_total_tokens = ?,
            usage_reasoning_tokens = ?,
            usage_cached_input_tokens = ?,
            error = ?,
            diagnostics = ?,
            execution_token = NULL,
            execution_queue_lease_expires_at = NULL,
            completed_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          input.modelId ?? null,
          input.finishReason ?? null,
          input.usage?.inputTokens ?? null,
          input.usage?.outputTokens ?? null,
          input.usage?.totalTokens ?? null,
          input.usage?.reasoningTokens ?? null,
          input.usage?.cachedInputTokens ?? null,
          errorValue,
          input.diagnostics === undefined ? null : JSON.stringify(input.diagnostics),
          completedAt.toISOString(),
          input.projectId,
          input.id
        )

      this.releaseThread(run, completedAt)

      return this.requireRun(input.projectId, input.id)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as AgentRunRow | null

    return row ? rowToRunRecord(row) : null
  }

  async getByIds(params: {
    projectId: string
    ids: readonly string[]
  }): Promise<readonly AgentRunRecord[]> {
    const ids = [...new Set(params.ids)]
    if (ids.length === 0) {
      return []
    }

    const rows: AgentRunRow[] = []
    for (let offset = 0; offset < ids.length; offset += SQLITE_RUN_ID_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + SQLITE_RUN_ID_BATCH_SIZE)
      const placeholders = batch.map(() => "?").join(", ")
      rows.push(
        ...(this.db
          .query(`SELECT * FROM agent_runs WHERE project_id = ? AND id IN (${placeholders})`)
          .all(params.projectId, ...batch) as AgentRunRow[])
      )
    }
    const byId = new Map(rows.map((row) => [row.id, rowToRunRecord(row)]))
    return ids.flatMap((id) => {
      const run = byId.get(id)
      return run ? [run] : []
    })
  }

  async list(input: ListAgentRunsInput): Promise<ListAgentRunsResult> {
    if (hasEmptyStatuses(input)) {
      return { runs: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.threadId) {
      whereClauses.push("thread_id = ?")
      args.push(input.threadId)
    }

    if (input.agentId) {
      whereClauses.push("agent_id = ?")
      args.push(input.agentId)
    }

    appendRunListFilters(whereClauses, args, input, "COALESCE(started_at, created_at)")

    const { rows, total, hasMore } = queryRunList<AgentRunRow>({
      db: this.db,
      tableName: "agent_runs",
      whereClauses,
      args,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })

    return { runs: rows.map(rowToRunRecord), hasMore, total }
  }

  private requireRunning(projectId: string, id: string): AgentRunRow {
    return this.requireStatus(projectId, id, "running")
  }

  private requireStatus(
    projectId: string,
    id: string,
    status: AgentRunRecord["status"]
  ): AgentRunRow {
    const row = this.db
      .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentRunRow | null

    if (!row) {
      throw new AgentStorageError(
        "run_not_found",
        `[SixbSqlite] Agent run '${id}' not found for project '${projectId}'.`
      )
    }

    if (row.status !== status) {
      throw new AgentStorageError(
        "invalid_state",
        `[SixbSqlite] Agent run '${id}' is not ${status} (status '${row.status}').`
      )
    }

    return row
  }

  private releaseThread(run: AgentRunRow, completedAt: Date): void {
    this.db
      .query(
        `
        UPDATE agent_threads
        SET active_run_id = NULL, updated_at = ?
        WHERE project_id = ? AND id = ? AND active_run_id = ?
      `
      )
      .run(completedAt.toISOString(), run.project_id, run.thread_id, run.id)
  }

  private requireRun(projectId: string, id: string): AgentRunRecord {
    const row = this.db
      .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentRunRow | null

    if (!row) {
      throw new AgentStorageError(
        "run_not_found",
        `[SixbSqlite] Agent run '${id}' not found for project '${projectId}'.`
      )
    }

    return rowToRunRecord(row)
  }
}
