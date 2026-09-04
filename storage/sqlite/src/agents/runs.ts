import type { Database } from "bun:sqlite"
import {
  assertAgentRunExecution,
  assertConversationAgentRunSpec,
  assertCreateSubagentRunInput,
  assertSubagentRunResult,
  subagentRunMatchesCreateInput,
} from "@sixb/core/internal/agent-run-storage-provider"
import { MAIN_AGENT_ID } from "@sixb/core/internal/agents"
import { normalizeRequesterGroupIds } from "@sixb/core/internal/auth"
import { serializeSixbFailure } from "@sixb/core/internal/errors"
import {
  AGENT_RUN_FAILURE_CODES,
  type AgentRunRecord,
  type AgentRunStore,
  AgentStorageError,
  type ConfirmAgentRunExecutionOwnershipInput,
  type ConversationAgentRunRecord,
  type CreateAgentRunInput,
  type CreateSubagentRunInput,
  type ExecutionStorage,
  type FinishAgentRunInput,
  type FinishQueuedAgentRunInput,
  type ListAgentRunsInput,
  type ListAgentRunsResult,
  type ReclaimAgentRunInput,
  type StartAgentRunInput,
  type SubagentRunRecord,
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
  constructor(
    private readonly db: Database,
    private readonly executions: ExecutionStorage
  ) {}

  async create(input: CreateAgentRunInput): Promise<ConversationAgentRunRecord> {
    assertConversationAgentRunSpec(input.spec, "SixbSqlite")
    const createdAt = input.createdAt ?? new Date()
    await assertAgentRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      authority:
        input.agentId === MAIN_AGENT_ID
          ? { type: "inherited" }
          : { type: "managed", agentId: input.agentId },
    })

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
              execution_id,
              kind,
              thread_id,
              agent_id,
              trigger_message_id,
              spec,
              requester_group_ids,
              status,
              attempt,
              created_at
            ) VALUES (?, ?, ?, 'conversation', ?, ?, ?, ?, ?, 'queued', 0, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.executionId,
            input.threadId,
            input.agentId,
            input.triggerMessageId,
            JSON.stringify(input.spec),
            JSON.stringify(normalizeRequesterGroupIds(input.requesterGroupIds)),
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

      const created = this.requireRun(input.projectId, input.id)
      if (created.kind !== "conversation") {
        throw new Error(`[SixbSqlite] Agent run insert '${input.id}' returned the wrong run kind.`)
      }
      return created
    })()
  }

  async createSubagent(input: CreateSubagentRunInput): Promise<SubagentRunRecord> {
    assertCreateSubagentRunInput(input, "SixbSqlite")
    const execution = await assertAgentRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      authority: { type: "inherited" },
    })

    return this.db.transaction(() => {
      const parentRow = this.db
        .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.parentRunId) as AgentRunRow | null
      if (!parentRow || parentRow.kind !== "conversation") {
        throw new AgentStorageError(
          "run_not_found",
          `[SixbSqlite] Parent Agent run '${input.parentRunId}' was not found.`
        )
      }

      const existingRow = this.db
        .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as AgentRunRow | null
      if (existingRow) {
        const existing = rowToRunRecord(existingRow)
        if (subagentRunMatchesCreateInput(existing, input)) return existing
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbSqlite] Subagent run '${input.id}' already exists with different immutable inputs.`
        )
      }
      if (parentRow.status !== "running") {
        throw new AgentStorageError(
          "invalid_state",
          `[SixbSqlite] Parent Agent run '${parentRow.id}' is not running (status '${parentRow.status}').`
        )
      }
      if (
        execution.source.type !== "execution" ||
        execution.source.executionId !== parentRow.execution_id
      ) {
        throw new AgentStorageError(
          "invalid_input",
          `[SixbSqlite] Subagent execution '${execution.id}' is not a child of parent execution '${parentRow.execution_id}'.`
        )
      }
      if (parentRow.execution_token !== input.parentExecutionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[SixbSqlite] Parent Agent run '${parentRow.id}' is no longer owned by this execution.`
        )
      }

      const count = this.db
        .query(
          `SELECT COUNT(*) AS count FROM agent_runs
           WHERE project_id = ? AND parent_run_id = ? AND status IN ('queued', 'running')`
        )
        .get(input.projectId, input.parentRunId) as { count: number }
      if (count.count >= input.maxActiveChildren) {
        throw new AgentStorageError(
          "active_child_limit",
          `[SixbSqlite] Agent run '${parentRow.id}' already has ${count.count} active subagents.`
        )
      }

      try {
        this.db
          .query(
            `
            INSERT INTO agent_runs (
              project_id, id, execution_id, kind, parent_run_id, spawn_key, spec,
              requester_group_ids, status, attempt, created_at
            ) VALUES (?, ?, ?, 'subagent', ?, ?, ?, ?, 'queued', 0, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.executionId,
            input.parentRunId,
            input.spawnKey,
            JSON.stringify(input.spec),
            parentRow.requester_group_ids,
            (input.createdAt ?? new Date()).toISOString()
          )
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbSqlite] Subagent run '${input.id}' conflicts with an existing durable spawn.`
          )
        }
        throw error
      }

      const created = this.requireRun(input.projectId, input.id)
      if (created.kind !== "subagent") {
        throw new Error(`[SixbSqlite] Subagent insert '${input.id}' returned the wrong run kind.`)
      }
      return created
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
            model_id = ?,
            attempt = 1,
            execution_token = ?,
            execution_queue_lease_expires_at = ?,
            started_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
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
          input.error === undefined
            ? null
            : serializeSixbFailure(input.error, AGENT_RUN_FAILURE_CODES),
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
    const errorValue =
      input.status === "succeeded" || input.error === undefined
        ? null
        : serializeSixbFailure(input.error, AGENT_RUN_FAILURE_CODES)

    return this.db.transaction(() => {
      const run = this.requireRunning(input.projectId, input.id)

      if (run.execution_token !== input.executionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[SixbSqlite] Execution token is no longer current on agent run '${input.id}'.`
        )
      }
      if (input.status === "succeeded" && run.kind === "subagent") {
        assertSubagentRunResult(input.result, run.id, "SixbSqlite")
      }
      if (
        input.status === "succeeded" &&
        run.kind === "conversation" &&
        input.result !== undefined
      ) {
        throw new AgentStorageError(
          "invalid_input",
          `[SixbSqlite] Conversational Agent run '${run.id}' cannot persist a subagent result.`
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
            error = ?,
            diagnostics = ?,
            result = ?,
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
          errorValue,
          input.diagnostics === undefined ? null : JSON.stringify(input.diagnostics),
          input.status === "succeeded" && input.result !== undefined
            ? JSON.stringify(input.result)
            : null,
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
    if (hasEmptyStatuses(input) || input.kinds?.length === 0) {
      return { runs: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.kinds) {
      whereClauses.push(`kind IN (${input.kinds.map(() => "?").join(", ")})`)
      args.push(...input.kinds)
    }

    if (input.threadId) {
      whereClauses.push("thread_id = ?")
      args.push(input.threadId)
    }

    if (input.agentId) {
      whereClauses.push("agent_id = ?")
      args.push(input.agentId)
    }

    if (input.parentRunId) {
      whereClauses.push("parent_run_id = ?")
      args.push(input.parentRunId)
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
    if (run.kind !== "conversation") return
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
