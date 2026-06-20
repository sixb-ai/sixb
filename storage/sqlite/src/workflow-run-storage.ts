import type { Database } from "bun:sqlite"
import type {
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListLatestWorkflowRunsInput,
  ListLatestWorkflowRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  ResumeWorkflowRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WaitWorkflowNodeRunInput,
  WaitWorkflowRunInput,
  WorkflowIOSnapshot,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStorage,
  WorkflowRunRecord,
  WorkflowRunSource,
  WorkflowRunStorage,
} from "@sixb/core"
import { WorkflowRunError } from "@sixb/core"
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

  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteWorkflowRunStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }

    this.nodes = new SqliteWorkflowNodeRunStorage(this.db)
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
            source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
          input.source ? JSON.stringify(input.source) : null
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
              error = NULL
            WHERE project_id = ? AND id = ?
          `
          )
          .run(
            "running",
            serializeRecord(input.input),
            startedAt.toISOString(),
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
              started_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            input.projectId,
            input.id,
            input.workflowId,
            "running",
            serializeRecord(input.input),
            startedAt.toISOString()
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

      this.db
        .query(
          `
          UPDATE workflow_runs
          SET
            status = ?,
            finished_at = ?,
            error = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded" ? null : (input.error ?? null),
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

      this.db
        .query(
          `
          UPDATE workflow_runs
          SET
            status = ?,
            finished_at = NULL,
            error = NULL
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
          WHERE project_id = ? AND id = ?
        `
        )
        .run("running", input.projectId, input.id)

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
    if (hasEmptyStatuses(input)) {
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
          input.status === "succeeded" ? null : (input.error ?? null),
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
    queuedAt: row.queued_at ? new Date(row.queued_at) : undefined,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    error: row.error ?? undefined,
    source: row.source ? (JSON.parse(row.source) as WorkflowRunSource) : undefined,
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
    error: row.error ?? undefined,
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
    (current === "waiting" && next === "cancelled") ||
    (current === "queued" && next !== "succeeded")
  )
}

interface WorkflowRunDatabaseRow {
  project_id: string
  id: string
  workflow_id: string
  status: WorkflowRunRecord["status"]
  input: string
  queued_at: string | null
  started_at: string
  finished_at: string | null
  error: string | null
  source: string | null
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
