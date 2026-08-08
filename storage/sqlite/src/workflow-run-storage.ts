import type { Database } from "bun:sqlite"
import type { Principal, WorkflowRunSource } from "@sixb/core"
import { parseSixbFailure, serializeSixbFailure } from "@sixb/core/internal/errors"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type {
  CancelWorkflowAgentNodeRunInput,
  ConfirmWorkflowAgentNodeRunExecutionOwnershipInput,
  ConfirmWorkflowRunExecutionOwnershipInput,
  CreateWorkflowAgentNodeRunInput,
  FinishWorkflowAgentNodeRunInput,
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListLatestWorkflowRunsInput,
  ListLatestWorkflowRunsResult,
  ListWorkflowAgentNodeRunsInput,
  ListWorkflowAgentNodeRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  ReclaimWorkflowAgentNodeRunInput,
  ReclaimWorkflowRunInput,
  ResumeWorkflowRunInput,
  StartWorkflowAgentNodeRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WaitWorkflowNodeRunInput,
  WaitWorkflowRunInput,
  WorkflowAgentNodeRunRecord,
  WorkflowAgentNodeRunStorage,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStorage,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import {
  AGENT_RUN_FAILURE_CODES,
  WORKFLOW_RUN_FAILURE_CODES,
  WorkflowRunError,
} from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import { installFreshSqliteSchema } from "./migrations"
import {
  appendRunListFilters,
  hasEmptyStatuses,
  queryRunList,
  type SqliteValue,
} from "./run-list-query"
import { isUniqueConstraintError } from "./storage-errors"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteWorkflowRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteWorkflowRunStorage implements WorkflowRunStorage {
  readonly nodes: SqliteWorkflowNodeRunStorage
  readonly agentNodes: SqliteWorkflowAgentNodeRunStorage

  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteWorkflowRunStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }

    this.nodes = new SqliteWorkflowNodeRunStorage(this.db)
    this.agentNodes = new SqliteWorkflowAgentNodeRunStorage(this.db)
  }

  async queue(input: QueueWorkflowRunInput): Promise<WorkflowRunRecord> {
    const queuedAt = input.queuedAt ?? new Date()

    try {
      this.db
        .query(
          `
          INSERT INTO workflow_runs (
            project_id,
            id,
            workflow_id,
            status,
            input,
            queued_at,
            started_at,
            source,
            requested_by_principal_type,
            requested_by_principal_id,
            attempt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.workflowId,
          "queued",
          serializeRecord(input.input),
          queuedAt.toISOString(),
          queuedAt.toISOString(),
          input.source ? JSON.stringify(input.source) : null,
          input.requestedByPrincipal?.type ?? "system",
          input.requestedByPrincipal?.id ?? "system",
          0
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }

    return this.requireWorkflowRun(input.projectId, input.id)
  }

  async start(input: StartWorkflowRunInput): Promise<WorkflowRunRecord> {
    const startedAt = input.startedAt ?? new Date()

    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowRunDatabaseRow | null

      if (existing) {
        if (existing.status !== "queued") {
          throw new WorkflowRunError(
            `[SixbSqlite] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        if (existing.workflow_id !== input.workflowId) {
          throw new WorkflowRunError(
            `[SixbSqlite] Workflow run '${input.id}' workflow '${input.workflowId}' does not match existing workflow '${existing.workflow_id}'.`
          )
        }

        this.db
          .query(
            `
            UPDATE workflow_runs
            SET
              status = ?,
              input = ?,
              started_at = ?,
              finished_at = NULL,
              error = NULL,
              source = COALESCE(source, ?)
              , attempt = attempt + 1,
              execution_token = ?, execution_queue_lease_expires_at = ?
            WHERE project_id = ? AND id = ?
          `
          )
          .run(
            "running",
            serializeRecord(input.input),
            startedAt.toISOString(),
            input.source ? JSON.stringify(input.source) : null,
            input.execution?.token ?? null,
            input.execution?.queueLeaseExpiresAt.toISOString() ?? null,
            input.projectId,
            input.id
          )

        return this.requireWorkflowRun(input.projectId, input.id)
      }

      try {
        this.db
          .query(
            `
            INSERT INTO workflow_runs (
              project_id,
              id,
              workflow_id,
              status,
              input,
              started_at,
              source,
              requested_by_principal_type,
              requested_by_principal_id,
              attempt,
              execution_token,
              execution_queue_lease_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.workflowId,
            "running",
            serializeRecord(input.input),
            startedAt.toISOString(),
            input.source ? JSON.stringify(input.source) : null,
            input.requestedByPrincipal?.type ?? "system",
            input.requestedByPrincipal?.id ?? "system",
            1,
            input.execution?.token ?? null,
            input.execution?.queueLeaseExpiresAt.toISOString() ?? null
          )
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new WorkflowRunError(
            `[SixbSqlite] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }

      return this.requireWorkflowRun(input.projectId, input.id)
    })()
  }

  async reclaim(input: ReclaimWorkflowRunInput): Promise<WorkflowRunRecord> {
    return this.db.transaction(() => {
      const row = this.requireStatus(input.projectId, input.id, "running")
      this.db
        .query(`
        UPDATE workflow_runs SET attempt = ?, execution_token = ?,
          execution_queue_lease_expires_at = ? WHERE project_id = ? AND id = ?
      `)
        .run(
          row.attempt + 1,
          input.execution.token,
          input.execution.queueLeaseExpiresAt.toISOString(),
          input.projectId,
          input.id
        )
      return this.requireWorkflowRun(input.projectId, input.id)
    })()
  }

  async confirmExecutionOwnership(
    input: ConfirmWorkflowRunExecutionOwnershipInput
  ): Promise<WorkflowRunRecord> {
    return this.db.transaction(() => {
      const row = this.requireStatus(input.projectId, input.id, "running")
      assertSqliteWorkflowRunOwnership(row, input.executionToken)
      const current = row.execution_queue_lease_expires_at
        ? new Date(row.execution_queue_lease_expires_at)
        : input.queueLeaseExpiresAt
      this.db
        .query(`
        UPDATE workflow_runs SET execution_queue_lease_expires_at = ?
        WHERE project_id = ? AND id = ?
      `)
        .run(
          new Date(Math.max(current.getTime(), input.queueLeaseExpiresAt.getTime())).toISOString(),
          input.projectId,
          input.id
        )
      return this.requireWorkflowRun(input.projectId, input.id)
    })()
  }

  async finish(input: FinishWorkflowRunInput): Promise<WorkflowRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowRunDatabaseRow | null

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (!canFinishWorkflowRun(existing.status, input.status)) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.id}' for project '${input.projectId}' cannot be finished from status '${existing.status}'.`
        )
      }
      assertSqliteWorkflowRunOwnership(existing, input.executionToken)

      this.db
        .query(
          `
          UPDATE workflow_runs
          SET
            status = ?,
            finished_at = ?,
            output = ?,
            error = ?,
            execution_token = NULL,
            execution_queue_lease_expires_at = NULL
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded" ? serializeRecord(input.output) : null,
          input.status === "succeeded" || input.error === undefined
            ? null
            : serializeSixbFailure(input.error, WORKFLOW_RUN_FAILURE_CODES),
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowRunDatabaseRow

      return rowToWorkflowRunRecord(updated)
    })()
  }

  async wait(input: WaitWorkflowRunInput): Promise<WorkflowRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowRunDatabaseRow | null

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.id}' for project '${input.projectId}' must be running.`
        )
      }
      assertSqliteWorkflowRunOwnership(existing, input.executionToken)

      this.db
        .query(
          `
          UPDATE workflow_runs
          SET
            status = ?,
            finished_at = NULL,
            error = NULL
            , execution_token = NULL, execution_queue_lease_expires_at = NULL
          WHERE project_id = ? AND id = ?
        `
        )
        .run("waiting", input.projectId, input.id)

      return this.requireWorkflowRun(input.projectId, input.id)
    })()
  }

  async resume(input: ResumeWorkflowRunInput): Promise<WorkflowRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowRunDatabaseRow | null

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "waiting") {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.id}' for project '${input.projectId}' must be waiting.`
        )
      }

      this.db
        .query(
          `
          UPDATE workflow_runs
          SET
            status = ?,
            finished_at = NULL,
            error = NULL
            , attempt = attempt + 1, execution_token = ?, execution_queue_lease_expires_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "running",
          input.execution?.token ?? null,
          input.execution?.queueLeaseExpiresAt.toISOString() ?? null,
          input.projectId,
          input.id
        )

      return this.requireWorkflowRun(input.projectId, input.id)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as WorkflowRunDatabaseRow | null

    return row ? rowToWorkflowRunRecord(row) : null
  }

  async list(input: ListWorkflowRunsInput): Promise<ListWorkflowRunsResult> {
    if (hasEmptyStatuses(input) || input.workflowIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.workflowId) {
      whereClauses.push("workflow_id = ?")
      args.push(input.workflowId)
    }

    if (input.workflowIds) {
      whereClauses.push(`workflow_id IN (${input.workflowIds.map(() => "?").join(", ")})`)
      args.push(...input.workflowIds)
    }

    appendRunListFilters(whereClauses, args, input)

    const { rows, total, hasMore } = queryRunList<WorkflowRunDatabaseRow>({
      db: this.db,
      tableName: "workflow_runs",
      whereClauses,
      args,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })

    return {
      runs: rows.map(rowToWorkflowRunRecord),
      hasMore,
      total,
    }
  }

  async listLatestByWorkflowIds(
    input: ListLatestWorkflowRunsInput
  ): Promise<ListLatestWorkflowRunsResult> {
    const rows = queryLatestRunsByOwnerId<WorkflowRunDatabaseRow>({
      db: this.db,
      tableName: "workflow_runs",
      ownerColumn: "workflow_id",
      ownerIds: input.workflowIds,
      projectId: input.projectId,
      ownerIdFor: (row) => row.workflow_id,
    })

    return {
      runs: rows.map(rowToWorkflowRunRecord),
    }
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private requireWorkflowRun(projectId: string, id: string): WorkflowRunRecord {
    const record = this.db
      .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as WorkflowRunDatabaseRow | null

    if (!record) {
      throw new WorkflowRunError(
        `[SixbSqlite] Failed to load workflow run '${id}' for project '${projectId}'.`
      )
    }

    return rowToWorkflowRunRecord(record)
  }

  private requireStatus(
    projectId: string,
    id: string,
    status: WorkflowRunRecord["status"]
  ): WorkflowRunDatabaseRow {
    const row = this.db
      .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as WorkflowRunDatabaseRow | null
    if (!row) throw new WorkflowRunError(`[SixbSqlite] Workflow run '${id}' not found.`)
    if (row.status !== status) {
      throw new WorkflowRunError(
        `[SixbSqlite] Workflow run '${id}' must be ${status} (status '${row.status}').`
      )
    }
    return row
  }
}

export class SqliteWorkflowAgentNodeRunStorage implements WorkflowAgentNodeRunStorage {
  constructor(private readonly db: Database) {}

  async create(input: CreateWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    try {
      this.db
        .query(`
          INSERT INTO workflow_agent_node_runs (
            project_id, node_run_id, agent_id, status, prompt, attempt, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.projectId,
          input.nodeRunId,
          input.agentId,
          "queued",
          input.prompt,
          0,
          (input.createdAt ?? new Date()).toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new WorkflowRunError(
          `[SixbSqlite] Agent execution already exists for workflow node run '${input.nodeRunId}'.`
        )
      }
      throw error
    }
    return this.require(input.projectId, input.nodeRunId)
  }

  async start(input: StartWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return this.db.transaction(() => {
      this.requireStatus(input.projectId, input.nodeRunId, "queued")
      this.db
        .query(`
        UPDATE workflow_agent_node_runs SET
          status = ?, execution_principal_type = ?, execution_principal_id = ?, model_id = ?,
          attempt = 1, execution_token = ?, execution_queue_lease_expires_at = ?, started_at = ?
        WHERE project_id = ? AND node_run_id = ?
      `)
        .run(
          "running",
          input.executionPrincipal?.type ?? null,
          input.executionPrincipal?.id ?? null,
          input.modelId ?? null,
          input.execution.token,
          input.execution.queueLeaseExpiresAt.toISOString(),
          (input.startedAt ?? new Date()).toISOString(),
          input.projectId,
          input.nodeRunId
        )
      return this.require(input.projectId, input.nodeRunId)
    })()
  }

  async reclaim(input: ReclaimWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return this.db.transaction(() => {
      const row = this.requireStatus(input.projectId, input.nodeRunId, "running")
      this.db
        .query(`
        UPDATE workflow_agent_node_runs SET
          attempt = ?, execution_token = ?, execution_queue_lease_expires_at = ?
        WHERE project_id = ? AND node_run_id = ?
      `)
        .run(
          Number(row.attempt) + 1,
          input.execution.token,
          input.execution.queueLeaseExpiresAt.toISOString(),
          input.projectId,
          input.nodeRunId
        )
      return this.require(input.projectId, input.nodeRunId)
    })()
  }

  async confirmExecutionOwnership(
    input: ConfirmWorkflowAgentNodeRunExecutionOwnershipInput
  ): Promise<WorkflowAgentNodeRunRecord> {
    return this.db.transaction(() => {
      const row = this.requireStatus(input.projectId, input.nodeRunId, "running")
      assertSqliteWorkflowAgentNodeOwnership(row, input.executionToken)
      const current = row.execution_queue_lease_expires_at
        ? new Date(row.execution_queue_lease_expires_at)
        : input.queueLeaseExpiresAt
      this.db
        .query(`
        UPDATE workflow_agent_node_runs SET execution_queue_lease_expires_at = ?
        WHERE project_id = ? AND node_run_id = ?
      `)
        .run(
          new Date(Math.max(current.getTime(), input.queueLeaseExpiresAt.getTime())).toISOString(),
          input.projectId,
          input.nodeRunId
        )
      return this.require(input.projectId, input.nodeRunId)
    })()
  }

  async finish(input: FinishWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return this.db.transaction(() => {
      const row = this.requireStatus(input.projectId, input.nodeRunId, "running")
      assertSqliteWorkflowAgentNodeOwnership(row, input.executionToken)
      this.db
        .query(`
        UPDATE workflow_agent_node_runs SET
          status = ?, model_id = COALESCE(?, model_id), finish_reason = ?, usage = ?, trace = ?,
          diagnostics = ?, error = ?, execution_token = NULL,
          execution_queue_lease_expires_at = NULL, completed_at = ?
        WHERE project_id = ? AND node_run_id = ?
      `)
        .run(
          input.status,
          input.modelId ?? null,
          input.finishReason ?? null,
          input.usage ? JSON.stringify(input.usage) : null,
          input.trace ? JSON.stringify(input.trace) : null,
          input.diagnostics ? JSON.stringify(input.diagnostics) : null,
          input.status === "succeeded" || input.error === undefined
            ? null
            : serializeSixbFailure(input.error, AGENT_RUN_FAILURE_CODES),
          (input.completedAt ?? new Date()).toISOString(),
          input.projectId,
          input.nodeRunId
        )
      return this.require(input.projectId, input.nodeRunId)
    })()
  }

  async cancel(input: CancelWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return this.db.transaction(() => {
      const row = this.require(input.projectId, input.nodeRunId)
      if (row.status !== "queued" && row.status !== "running") {
        throw new WorkflowRunError(
          `[SixbSqlite] Agent workflow node run '${input.nodeRunId}' cannot be cancelled from status '${row.status}'.`
        )
      }
      this.db
        .query(
          `UPDATE workflow_agent_node_runs SET status = ?, error = ?, execution_token = NULL,
            execution_queue_lease_expires_at = NULL, completed_at = ?
           WHERE project_id = ? AND node_run_id = ?`
        )
        .run(
          "cancelled",
          input.error === undefined
            ? null
            : serializeSixbFailure(input.error, AGENT_RUN_FAILURE_CODES),
          (input.completedAt ?? new Date()).toISOString(),
          input.projectId,
          input.nodeRunId
        )
      return this.require(input.projectId, input.nodeRunId)
    })()
  }

  async getByNodeRunId(params: {
    projectId: string
    nodeRunId: string
  }): Promise<WorkflowAgentNodeRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM workflow_agent_node_runs WHERE project_id = ? AND node_run_id = ?")
      .get(params.projectId, params.nodeRunId) as WorkflowAgentNodeRunDatabaseRow | null
    return row ? rowToWorkflowAgentNodeRunRecord(row) : null
  }

  async list(input: ListWorkflowAgentNodeRunsInput): Promise<ListWorkflowAgentNodeRunsResult> {
    if (hasEmptyStatuses(input)) return { runs: [], total: 0, hasMore: false }
    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]
    if (input.agentId) {
      whereClauses.push("agent_id = ?")
      args.push(input.agentId)
    }
    appendRunListFilters(whereClauses, args, input)
    const result = queryRunList<WorkflowAgentNodeRunDatabaseRow>({
      db: this.db,
      tableName: "workflow_agent_node_runs",
      whereClauses,
      args,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })
    return { ...result, runs: result.rows.map(rowToWorkflowAgentNodeRunRecord) }
  }

  private require(projectId: string, nodeRunId: string): WorkflowAgentNodeRunRecord {
    const row = this.db
      .query("SELECT * FROM workflow_agent_node_runs WHERE project_id = ? AND node_run_id = ?")
      .get(projectId, nodeRunId) as WorkflowAgentNodeRunDatabaseRow | null
    if (!row) {
      throw new WorkflowRunError(
        `[SixbSqlite] Agent workflow node run '${nodeRunId}' not found for project '${projectId}'.`
      )
    }
    return rowToWorkflowAgentNodeRunRecord(row)
  }

  private requireStatus(
    projectId: string,
    nodeRunId: string,
    status: WorkflowAgentNodeRunRecord["status"]
  ): WorkflowAgentNodeRunDatabaseRow {
    const row = this.db
      .query("SELECT * FROM workflow_agent_node_runs WHERE project_id = ? AND node_run_id = ?")
      .get(projectId, nodeRunId) as WorkflowAgentNodeRunDatabaseRow | null
    if (!row) {
      throw new WorkflowRunError(
        `[SixbSqlite] Agent workflow node run '${nodeRunId}' not found for project '${projectId}'.`
      )
    }
    if (row.status !== status) {
      throw new WorkflowRunError(
        `[SixbSqlite] Agent workflow node run '${nodeRunId}' must be ${status} (status '${row.status}').`
      )
    }
    return row
  }
}

export class SqliteWorkflowNodeRunStorage implements WorkflowNodeRunStorage {
  constructor(private readonly db: Database) {}

  async start(input: StartWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    assertNonNegativeInteger(input.nodeIndex, "nodeIndex")

    return this.db.transaction(() => {
      const workflowRun = this.db
        .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.workflowRunId) as WorkflowRunDatabaseRow | null

      if (!workflowRun) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.workflowRunId}' not found for project '${input.projectId}'.`
        )
      }

      if (workflowRun.status !== "running") {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow run '${input.workflowRunId}' for project '${input.projectId}' must be running.`
        )
      }
      assertSqliteWorkflowRunOwnership(workflowRun, input.executionToken)

      if (workflowRun.workflow_id !== input.workflowId) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow node run '${input.id}' workflow '${input.workflowId}' does not match workflow run '${input.workflowRunId}' workflow '${workflowRun.workflow_id}'.`
        )
      }

      const startedAt = input.startedAt ?? new Date()

      try {
        this.db
          .query(
            `
            INSERT INTO workflow_node_runs (
              project_id,
              id,
              workflow_run_id,
              workflow_id,
              node_index,
              node_type,
              node_id,
              node_key,
              status,
              input,
              started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.workflowRunId,
            input.workflowId,
            input.nodeIndex,
            input.nodeType,
            input.nodeId,
            input.nodeKey,
            "running",
            serializeRecord(input.input),
            startedAt.toISOString()
          )
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new WorkflowRunError(
            `[SixbSqlite] Workflow node run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }

      const row = this.db
        .query("SELECT * FROM workflow_node_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowNodeRunDatabaseRow | null

      if (!row) {
        throw new WorkflowRunError(
          `[SixbSqlite] Failed to load workflow node run '${input.id}' for project '${input.projectId}'.`
        )
      }

      return rowToWorkflowNodeRunRecord(row)
    })()
  }

  async finish(input: FinishWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM workflow_node_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowNodeRunDatabaseRow | null

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow node run '${input.id}' not found for project '${input.projectId}'.`
        )
      }
      this.assertNodeParentOwnership(existing, input.executionToken)

      if (existing.status !== "running" && existing.status !== "waiting") {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow node run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      this.db
        .query(
          `
          UPDATE workflow_node_runs
          SET
            status = ?,
            finished_at = ?,
            output = ?,
            error = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded" && input.output ? serializeRecord(input.output) : null,
          input.status === "succeeded" || input.error === undefined
            ? null
            : serializeSixbFailure(input.error, WORKFLOW_RUN_FAILURE_CODES),
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM workflow_node_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowNodeRunDatabaseRow

      return rowToWorkflowNodeRunRecord(updated)
    })()
  }

  async wait(input: WaitWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM workflow_node_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowNodeRunDatabaseRow | null

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow node run '${input.id}' not found for project '${input.projectId}'.`
        )
      }
      this.assertNodeParentOwnership(existing, input.executionToken)

      if (existing.status !== "running") {
        throw new WorkflowRunError(
          `[SixbSqlite] Workflow node run '${input.id}' for project '${input.projectId}' must be running.`
        )
      }

      this.db
        .query(
          `
          UPDATE workflow_node_runs
          SET
            status = ?,
            finished_at = NULL,
            output = NULL,
            error = NULL
          WHERE project_id = ? AND id = ?
        `
        )
        .run("waiting", input.projectId, input.id)

      const updated = this.db
        .query("SELECT * FROM workflow_node_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WorkflowNodeRunDatabaseRow

      return rowToWorkflowNodeRunRecord(updated)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowNodeRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM workflow_node_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as WorkflowNodeRunDatabaseRow | null

    return row ? rowToWorkflowNodeRunRecord(row) : null
  }

  async list(input: ListWorkflowNodeRunsInput): Promise<ListWorkflowNodeRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        nodes: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.workflowRunId) {
      whereClauses.push("workflow_run_id = ?")
      args.push(input.workflowRunId)
    }

    if (input.workflowId) {
      whereClauses.push("workflow_id = ?")
      args.push(input.workflowId)
    }

    if (input.nodeType) {
      whereClauses.push("node_type = ?")
      args.push(input.nodeType)
    }

    if (input.nodeId) {
      whereClauses.push("node_id = ?")
      args.push(input.nodeId)
    }

    if (input.nodeKey) {
      whereClauses.push("node_key = ?")
      args.push(input.nodeKey)
    }

    appendRunListFilters(whereClauses, args, input)

    const { rows, total, hasMore } = queryRunList<WorkflowNodeRunDatabaseRow>({
      db: this.db,
      tableName: "workflow_node_runs",
      whereClauses,
      args,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })

    return {
      nodes: rows.map(rowToWorkflowNodeRunRecord),
      hasMore,
      total,
    }
  }

  private assertNodeParentOwnership(node: WorkflowNodeRunDatabaseRow, token?: string): void {
    const run = this.db
      .query("SELECT * FROM workflow_runs WHERE project_id = ? AND id = ?")
      .get(node.project_id, node.workflow_run_id) as WorkflowRunDatabaseRow | null
    if (!run) throw new WorkflowRunError("[SixbSqlite] Parent workflow run was not found.")
    assertSqliteWorkflowRunOwnership(run, token)
  }
}

function serializeRecord(value: WorkflowIOSnapshot): string {
  return JSON.stringify(value)
}

function parseRecord(value: string): WorkflowIOSnapshot {
  return JSON.parse(value) as WorkflowIOSnapshot
}

function rowToWorkflowRunRecord(row: WorkflowRunDatabaseRow): WorkflowRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    status: row.status,
    input: parseRecord(row.input),
    output: row.output ? parseRecord(row.output) : undefined,
    queuedAt: row.queued_at ? new Date(row.queued_at) : undefined,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    error: row.error === null ? undefined : parseSixbFailure(row.error, WORKFLOW_RUN_FAILURE_CODES),
    source: row.source ? (JSON.parse(row.source) as WorkflowRunSource) : undefined,
    requestedByPrincipal: {
      type: row.requested_by_principal_type,
      id: row.requested_by_principal_id,
    },
    attempt: row.attempt,
    ...(row.execution_token && row.execution_queue_lease_expires_at
      ? {
          execution: {
            token: row.execution_token,
            queueLeaseExpiresAt: new Date(row.execution_queue_lease_expires_at),
          },
        }
      : {}),
  }
}

function rowToWorkflowNodeRunRecord(row: WorkflowNodeRunDatabaseRow): WorkflowNodeRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowRunId: row.workflow_run_id,
    workflowId: row.workflow_id,
    nodeIndex: row.node_index,
    nodeType: row.node_type,
    nodeId: row.node_id,
    nodeKey: row.node_key,
    status: row.status,
    input: parseRecord(row.input),
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    output: row.output ? parseRecord(row.output) : undefined,
    error: row.error === null ? undefined : parseSixbFailure(row.error, WORKFLOW_RUN_FAILURE_CODES),
  }
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowRunError(
      `[SixbSqlite] Workflow run ${fieldName} must be a non-negative integer.`
    )
  }
}

function canFinishWorkflowRun(
  current: WorkflowRunRecord["status"],
  next: FinishWorkflowRunInput["status"]
): boolean {
  return (
    current === "running" ||
    (current === "waiting" && next !== "succeeded") ||
    (current === "queued" && next !== "succeeded")
  )
}

interface WorkflowRunDatabaseRow {
  project_id: string
  id: string
  workflow_id: string
  status: WorkflowRunRecord["status"]
  input: string
  output: string | null
  queued_at: string | null
  started_at: string
  finished_at: string | null
  error: string | null
  source: string | null
  requested_by_principal_type: Principal["type"]
  requested_by_principal_id: string
  attempt: number
  execution_token: string | null
  execution_queue_lease_expires_at: string | null
}

interface WorkflowNodeRunDatabaseRow {
  project_id: string
  id: string
  workflow_run_id: string
  workflow_id: string
  node_index: number
  node_type: WorkflowNodeRunRecord["nodeType"]
  node_id: string
  node_key: string
  status: WorkflowNodeRunRecord["status"]
  input: string
  started_at: string
  finished_at: string | null
  output: string | null
  error: string | null
}

interface WorkflowAgentNodeRunDatabaseRow {
  project_id: string
  node_run_id: string
  agent_id: string
  status: WorkflowAgentNodeRunRecord["status"]
  prompt: string
  execution_principal_type: "serviceAccount" | null
  execution_principal_id: string | null
  model_id: string | null
  finish_reason: WorkflowAgentNodeRunRecord["finishReason"] | null
  usage: string | null
  trace: string | null
  diagnostics: string | null
  error: string | null
  attempt: number
  execution_token: string | null
  execution_queue_lease_expires_at: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

function assertSqliteWorkflowAgentNodeOwnership(
  row: WorkflowAgentNodeRunDatabaseRow,
  token: string
): void {
  if (row.execution_token !== token) {
    throw new WorkflowRunError(
      `[SixbSqlite] Execution token is no longer current on agent workflow node run '${row.node_run_id}'.`
    )
  }
}

function rowToWorkflowAgentNodeRunRecord(
  row: WorkflowAgentNodeRunDatabaseRow
): WorkflowAgentNodeRunRecord {
  return {
    projectId: row.project_id,
    nodeRunId: row.node_run_id,
    agentId: row.agent_id,
    status: row.status,
    prompt: row.prompt,
    ...(row.execution_principal_type && row.execution_principal_id
      ? {
          executionPrincipal: {
            type: row.execution_principal_type,
            id: row.execution_principal_id,
          },
        }
      : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.finish_reason ? { finishReason: row.finish_reason } : {}),
    ...(row.usage ? { usage: JSON.parse(row.usage) } : {}),
    ...(row.trace ? { trace: JSON.parse(row.trace) } : {}),
    ...(row.diagnostics ? { diagnostics: JSON.parse(row.diagnostics) } : {}),
    ...(row.error ? { error: parseSixbFailure(row.error, AGENT_RUN_FAILURE_CODES) } : {}),
    attempt: row.attempt,
    ...(row.execution_token && row.execution_queue_lease_expires_at
      ? {
          execution: {
            token: row.execution_token,
            queueLeaseExpiresAt: new Date(row.execution_queue_lease_expires_at),
          },
        }
      : {}),
    createdAt: new Date(row.created_at),
    ...(row.started_at ? { startedAt: new Date(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at) } : {}),
  }
}

function assertSqliteWorkflowRunOwnership(row: WorkflowRunDatabaseRow, token?: string): void {
  if (row.execution_token !== (token ?? null)) {
    throw new WorkflowRunError(
      `[SixbSqlite] Execution token is no longer current on workflow run '${row.id}'.`
    )
  }
}
